from copy import deepcopy
from datetime import date, timedelta

from models import CarAssignment, DaySchedule, Employee
from routing import assign_passengers_to_cars, optimize_route

PASSENGERS_PER_CAR = 4
CARS = 2
WORK_DAYS = 5  # Sun–Thu


def week_dates(week_start: date) -> list[date]:
    """Return [Sun, Mon, Tue, Wed, Thu] for the given week_start (must be Sunday)."""
    return [week_start + timedelta(days=i) for i in range(WORK_DAYS)]


def select_block_drivers(
    all_employees: list[Employee],
    week_counts: dict[str, int],
) -> list[Employee]:
    """Select 2 primary drivers for a new 2-week block (fewest primary weeks first, name tiebreak)."""
    drivers = [e for e in all_employees if e.is_driver]
    drivers.sort(key=lambda e: (week_counts.get(e.id, 0), e.name))
    return drivers[:CARS]


def schedule_day(
    day: date,
    all_employees: list[Employee],
    wfh_ids: set[str],
    block_drivers: list[Employee],
    drive_counts: dict[str, int],
    seat_counts: dict[str, int],
    workplace: tuple[float, float],
    api_key: str,
) -> DaySchedule:
    """
    Generate one day's schedule.

    Driver selection:
      The 2 block (primary) drivers are used unless WFH — in that case the off-duty
      driver substitutes for that day only.

    Passenger assignment (two-stage):
      1. Fairness sort (seat_counts) selects who gets seats.
      2. Geographic assignment (haversine) splits riders between the two cars.
      3. Google Maps Directions API (or haversine fallback) orders pickups within each car.
    """
    wfh_employees = [e for e in all_employees if e.id in wfh_ids]
    present       = [e for e in all_employees if e.id not in wfh_ids]

    block_ids = {d.id for d in block_drivers}

    # Off-duty drivers: licensed, present today, not in the primary pair
    off_duty = [e for e in present if e.is_driver and e.id not in block_ids]
    off_duty.sort(key=lambda e: (drive_counts.get(e.id, 0), e.name))

    selected_drivers: list[Employee] = []
    sub_idx = 0
    for primary in block_drivers:
        if primary.id not in wfh_ids:
            selected_drivers.append(primary)
        elif sub_idx < len(off_duty):
            selected_drivers.append(off_duty[sub_idx])
            sub_idx += 1

    warning = None
    if len(selected_drivers) == 0:
        warning = "אין נהגות זמינות היום — אין מכוניות"
    elif len(selected_drivers) == 1:
        warning = f"רק נהגת אחת זמינה היום ({selected_drivers[0].name}) — מכונית אחת פועלת"

    driving_ids = {d.id for d in selected_drivers}

    # Candidates: present, not driving, sorted by fewest rides (fairness)
    candidates = [e for e in present if e.id not in driving_ids]
    candidates.sort(key=lambda e: (seat_counts.get(e.id, 0), e.name))

    # Stage 1: split candidates between cars by geographic proximity
    buckets = assign_passengers_to_cars(selected_drivers, candidates, PASSENGERS_PER_CAR)

    # Stage 2: optimize pickup order within each car
    cars: list[CarAssignment] = []
    seated_ids: set[str] = set()
    for i, driver in enumerate(selected_drivers):
        pax_ordered, km, polyline = optimize_route(driver, buckets[i], workplace, api_key)
        seated_ids.update(p.id for p in pax_ordered)
        cars.append(CarAssignment(
            car_number=i + 1,
            driver=driver,
            passengers=pax_ordered,
            route_km=km,
            route_polyline=polyline,
        ))

    public_transport = [
        e for e in present if e.id not in driving_ids and e.id not in seated_ids
    ]

    return DaySchedule(
        date=day,
        cars=cars,
        public_transport=public_transport,
        wfh=wfh_employees,
        warning=warning,
    )


def schedule_week(
    week_start: date,
    all_employees: list[Employee],
    wfh_per_day: dict[str, list[str]],
    drive_counts: dict[str, int],
    seat_counts: dict[str, int],
    block_drivers: list[Employee] | None,
    week_counts: dict[str, int],
    workplace: tuple[float, float] = (0.0, 0.0),
    api_key: str = "",
) -> tuple[list[DaySchedule], list[Employee]]:
    """
    Generate a full Sun–Thu schedule.

    block_drivers=None starts a new 2-week block (auto-selected by week_counts).
    Returns (schedules, block_drivers_used).
    """
    if block_drivers is None or len(block_drivers) < CARS:
        block_drivers = select_block_drivers(all_employees, week_counts)

    working_drive = deepcopy(drive_counts)
    working_seat  = deepcopy(seat_counts)

    schedules: list[DaySchedule] = []
    for day in week_dates(week_start):
        wfh_ids = set(wfh_per_day.get(day.isoformat(), []))
        ds = schedule_day(
            day, all_employees, wfh_ids, block_drivers,
            working_drive, working_seat, workplace, api_key,
        )
        schedules.append(ds)

        for car in ds.cars:
            if car.driver:
                working_drive[car.driver.id] = working_drive.get(car.driver.id, 0) + 1
            for pax in car.passengers:
                working_seat[pax.id] = working_seat.get(pax.id, 0) + 1

    return schedules, block_drivers


def apply_week(
    final_schedules: list[DaySchedule],
    block_drivers: list[Employee],
    drive_counts: dict[str, int],
    seat_counts: dict[str, int],
    week_counts: dict[str, int],
) -> tuple[dict[str, int], dict[str, int], dict[str, int]]:
    """
    Compute updated counts from the post-edit final schedules.

    drive_counts: increments per day actually driven (primary or substitute).
    week_counts:  increments by 1 per primary (block) driver per week saved.
    Returns (new_drive_counts, new_seat_counts, new_week_counts).
    """
    new_drive = deepcopy(drive_counts)
    new_seat  = deepcopy(seat_counts)
    new_week  = deepcopy(week_counts)

    for ds in final_schedules:
        for car in ds.cars:
            if car.driver:
                new_drive[car.driver.id] = new_drive.get(car.driver.id, 0) + 1
            for pax in car.passengers:
                new_seat[pax.id] = new_seat.get(pax.id, 0) + 1

    for driver in block_drivers:
        new_week[driver.id] = new_week.get(driver.id, 0) + 1

    return new_drive, new_seat, new_week


def validate_move(
    employee_id: str,
    to_zone: str,
    to_slot: str,
    day_state: dict,
    all_employees: list[Employee],
    wfh_ids: set[str],
) -> str | None:
    """
    Validate a drag-and-drop move.
    Returns an error message if invalid, or None if allowed.
    """
    emp_by_id = {e.id: e for e in all_employees}
    employee  = emp_by_id.get(employee_id)
    if not employee:
        return "עובדת לא מוכרת"

    if to_zone == "public_transport":
        return None

    if employee_id in wfh_ids:
        return f"{employee.name} בבית היום"

    if to_slot == "driver" and not employee.is_driver:
        return f"{employee.name} אינה נהגת רשומה"

    if to_slot == "passenger":
        car_num  = int(to_zone.split("_")[1])
        car_data = next(
            (c for c in day_state.get("cars", []) if c["car_number"] == car_num), None
        )
        if car_data:
            current_count = len(car_data.get("passengers", []))
            already_here  = any(p["id"] == employee_id for p in car_data.get("passengers", []))
            if not already_here and current_count >= PASSENGERS_PER_CAR:
                return f"מכונית {car_num} מלאה ({PASSENGERS_PER_CAR}/{PASSENGERS_PER_CAR} נוסעות)"

    return None
