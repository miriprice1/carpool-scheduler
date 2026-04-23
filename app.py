import json
import os
import uuid
from datetime import date, timedelta

from flask import Flask, jsonify, render_template, request, send_file

from models import CarAssignment, DaySchedule, Employee
from scheduler import CARS, apply_week, schedule_week, validate_move, week_dates
from routing import optimize_route

BASE_DIR       = os.path.dirname(os.path.abspath(__file__))
EMPLOYEES_FILE = os.path.join(BASE_DIR, "employees.json")
CONFIG_FILE    = os.path.join(BASE_DIR, "config.json")

# On Render, mount a persistent disk and set DATA_DIR=/data so state survives redeploys.
# Locally, state.json sits next to app.py (BASE_DIR).
DATA_DIR   = os.environ.get("DATA_DIR", BASE_DIR)
STATE_FILE = os.path.join(DATA_DIR, "state.json")
UPLOAD_DIR = os.path.join(DATA_DIR, "uploads")

ALLOWED_IMAGE_EXTS = {"jpg", "jpeg", "png", "webp"}

app = Flask(__name__)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def load_employees() -> list[Employee]:
    with open(EMPLOYEES_FILE, encoding="utf-8") as f:
        data = json.load(f)
    return [
        Employee(
            id=e["id"],
            name=e["name"],
            is_driver=e["is_driver"],
            address=e.get("address", ""),
            lat=e.get("lat", 0.0),
            lng=e.get("lng", 0.0),
        )
        for e in data
    ]


def _find_image_path(emp_id: str) -> str | None:
    for ext in ALLOWED_IMAGE_EXTS:
        p = os.path.join(UPLOAD_DIR, f"{emp_id}.{ext}")
        if os.path.exists(p):
            return p
    return None


def save_employees(employees: list[Employee]) -> None:
    with open(EMPLOYEES_FILE, "w", encoding="utf-8") as f:
        json.dump([e.to_dict() for e in employees], f, indent=2, ensure_ascii=False)


def load_config() -> dict:
    """Load config from config.json (local dev), overridden by environment variables.

    Environment variables take precedence so that secrets never need to be
    committed to source control.  On Render, set:
      GOOGLE_MAPS_API_KEY  — your Maps Directions API key
      WORKPLACE_NAME       — e.g. "טיקטין תכנון חשמל"
      WORKPLACE_LAT        — decimal latitude
      WORKPLACE_LNG        — decimal longitude
    """
    base: dict = {"workplace": {"name": "המשרד", "lat": 0.0, "lng": 0.0}, "google_maps_api_key": ""}
    if os.path.exists(CONFIG_FILE):
        with open(CONFIG_FILE, encoding="utf-8") as f:
            base = json.load(f)

    # Environment variables override file values
    api_key   = os.environ.get("GOOGLE_MAPS_API_KEY") or base.get("google_maps_api_key", "")
    workplace = base.get("workplace", {"name": "המשרד", "lat": 0.0, "lng": 0.0})

    if os.environ.get("WORKPLACE_NAME"):
        workplace["name"] = os.environ["WORKPLACE_NAME"]
    if os.environ.get("WORKPLACE_LAT"):
        workplace["lat"]  = float(os.environ["WORKPLACE_LAT"])
    if os.environ.get("WORKPLACE_LNG"):
        workplace["lng"]  = float(os.environ["WORKPLACE_LNG"])

    return {"workplace": workplace, "google_maps_api_key": api_key}


def load_state() -> dict:
    if not os.path.exists(STATE_FILE):
        return {
            "drive_counts": {}, "seat_counts": {}, "week_counts": {},
            "block_drivers": None, "block_week": 0, "history": [],
        }
    state = json.load(open(STATE_FILE, encoding="utf-8"))
    state.setdefault("history", [])
    state.setdefault("week_counts", {})
    state.setdefault("block_drivers", None)
    state.setdefault("block_week", 0)
    return state


def save_state(state: dict) -> None:
    os.makedirs(DATA_DIR, exist_ok=True)
    with open(STATE_FILE, "w", encoding="utf-8") as f:
        json.dump(state, f, indent=2, ensure_ascii=False)


def next_sunday() -> date:
    today = date.today()
    days_until_sunday = (6 - today.weekday()) % 7
    if days_until_sunday == 0:
        return today
    return today + timedelta(days=days_until_sunday)


def day_schedule_from_dict(d: dict, emp_by_id: dict[str, Employee]) -> DaySchedule:
    """Reconstruct a DaySchedule from the JSON dict the frontend sends back."""
    cars = []
    for c in d.get("cars", []):
        driver_data = c.get("driver")
        if not driver_data:
            continue
        driver_id = driver_data["id"]
        if driver_id not in emp_by_id:
            continue
        driver     = emp_by_id[driver_id]
        passengers = [emp_by_id[p["id"]] for p in c.get("passengers", []) if p["id"] in emp_by_id]
        cars.append(CarAssignment(
            car_number=c["car_number"],
            driver=driver,
            passengers=passengers,
            route_km=c.get("route_km", 0.0),
            route_polyline=c.get("route_polyline", ""),
        ))
    pt  = [emp_by_id[e["id"]] for e in d.get("public_transport", []) if e["id"] in emp_by_id]
    wfh = [emp_by_id[e["id"]] for e in d.get("wfh", []) if e["id"] in emp_by_id]
    return DaySchedule(
        date=date.fromisoformat(d["date"]),
        cars=cars,
        public_transport=pt,
        wfh=wfh,
        warning=d.get("warning"),
    )


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

@app.route("/")
def index():
    default_week = next_sunday().isoformat()
    return render_template("index.html", default_week=default_week)


@app.route("/api/employees")
def api_employees():
    employees = load_employees()
    return jsonify([e.to_dict() for e in employees])


@app.route("/api/state")
def api_state():
    return jsonify(load_state())


@app.route("/api/generate", methods=["POST"])
def api_generate():
    body        = request.get_json()
    week_start  = date.fromisoformat(body["week_start"])
    wfh_per_day: dict[str, list[str]] = body.get("wfh", {})

    employees = load_employees()
    emp_by_id = {e.id: e for e in employees}
    state     = load_state()
    config    = load_config()

    wp_cfg    = config.get("workplace", {})
    workplace = (wp_cfg.get("lat", 0.0), wp_cfg.get("lng", 0.0))
    api_key   = config.get("google_maps_api_key", "")

    state_block_ids: list[str] | None = state.get("block_drivers")
    block_week: int = state.get("block_week", 0)

    forced_ids: list[str] | None = body.get("forced_drivers")

    if forced_ids:
        block_drivers = [emp_by_id[fid] for fid in forced_ids if fid in emp_by_id]
        if len(block_drivers) != CARS:
            block_drivers = None
        is_new_block = True
    elif state_block_ids and block_week > 0:
        block_drivers = [emp_by_id[fid] for fid in state_block_ids if fid in emp_by_id]
        if len(block_drivers) != CARS:
            block_drivers = None
        is_new_block = block_drivers is None
    else:
        block_drivers = None
        is_new_block  = True

    schedules, used_block_drivers = schedule_week(
        week_start=week_start,
        all_employees=employees,
        wfh_per_day=wfh_per_day,
        drive_counts=state["drive_counts"],
        seat_counts=state["seat_counts"],
        block_drivers=block_drivers,
        week_counts=state.get("week_counts", {}),
        workplace=workplace,
        api_key=api_key,
    )

    block_week_num = 1 if is_new_block else 2

    return jsonify({
        "schedules":      [ds.to_dict() for ds in schedules],
        "weekly_drivers": [d.to_dict() for d in used_block_drivers],
        "block_week_num": block_week_num,
        "workplace":      wp_cfg,
    })


@app.route("/api/validate-move", methods=["POST"])
def api_validate_move():
    body      = request.get_json()
    employees = load_employees()
    wfh_ids   = set(body.get("wfh_ids", []))

    error = validate_move(
        employee_id=body["employee_id"],
        to_zone=body["to_zone"],
        to_slot=body["to_slot"],
        day_state=body.get("current_day_state", {}),
        all_employees=employees,
        wfh_ids=wfh_ids,
    )

    if error:
        return jsonify({"ok": False, "error": error})
    return jsonify({"ok": True})


@app.route("/api/save", methods=["POST"])
def api_save():
    body      = request.get_json()
    employees = load_employees()
    emp_by_id = {e.id: e for e in employees}

    final_schedules = [day_schedule_from_dict(d, emp_by_id) for d in body["schedules"]]
    weekly_drivers  = [emp_by_id[d["id"]] for d in body["weekly_drivers"] if d["id"] in emp_by_id]
    week_start_iso  = body.get("week_start")

    state      = load_state()
    block_week = state.get("block_week", 0)

    new_drive, new_seat, new_week = apply_week(
        final_schedules=final_schedules,
        block_drivers=weekly_drivers,
        drive_counts=state["drive_counts"],
        seat_counts=state["seat_counts"],
        week_counts=state.get("week_counts", {}),
    )

    saved_ids        = [d.id for d in weekly_drivers]
    state_block_ids  = state.get("block_drivers") or []
    is_forced_change = sorted(saved_ids) != sorted(state_block_ids)

    if is_forced_change or block_week == 0:
        new_block_week    = 1
        new_block_drivers = saved_ids
    else:
        new_block_week    = 0
        new_block_drivers = None

    history: list[dict] = state["history"]
    history = [h for h in history if h.get("week_start") != week_start_iso]
    history.append({
        "week_start":    week_start_iso,
        "block_drivers": saved_ids,
        "schedules":     body["schedules"],
    })
    history.sort(key=lambda h: h["week_start"])

    save_state({
        "drive_counts":   new_drive,
        "seat_counts":    new_seat,
        "week_counts":    new_week,
        "block_drivers":  new_block_drivers,
        "block_week":     new_block_week,
        "history":        history,
    })

    return jsonify({"ok": True, "drive_counts": new_drive, "seat_counts": new_seat})


@app.route("/api/route-car", methods=["POST"])
def api_route_car():
    """Recalculate route for a single car after a drag-and-drop change."""
    body      = request.get_json()
    employees = load_employees()
    emp_by_id = {e.id: e for e in employees}
    config    = load_config()

    wp_cfg    = config.get("workplace", {})
    workplace = (wp_cfg.get("lat", 0.0), wp_cfg.get("lng", 0.0))
    api_key   = config.get("google_maps_api_key", "")

    driver = emp_by_id.get(body.get("driver_id"))
    if not driver:
        return jsonify({"error": "Driver not found"}), 400

    passengers = [emp_by_id[pid] for pid in body.get("passenger_ids", []) if pid in emp_by_id]
    ordered, km, polyline = optimize_route(driver, passengers, workplace, api_key)

    return jsonify({
        "passenger_order": [p.id for p in ordered],
        "route_km":        round(km, 1),
        "route_polyline":  polyline,
    })


@app.route("/api/history")
def api_history():
    month = request.args.get("month")
    state = load_state()
    history = state.get("history", [])

    if month:
        history = [h for h in history if h.get("week_start", "").startswith(month)]

    employees   = load_employees()
    week_counts = state.get("week_counts", {})

    drivers_summary = [
        {"id": e.id, "name": e.name, "total_drives": week_counts.get(e.id, 0)}
        for e in employees if e.is_driver
    ]
    drivers_summary.sort(key=lambda d: -d["total_drives"])

    return jsonify({"history": history, "drivers_summary": drivers_summary})


@app.route("/api/config-public")
def api_config_public():
    config = load_config()
    return jsonify({"google_maps_api_key": config.get("google_maps_api_key", "")})


@app.route("/api/employees", methods=["POST"])
def api_add_employee():
    body      = request.get_json()
    employees = load_employees()
    new_name  = (body.get("name") or "").strip()

    if not new_name:
        return jsonify({"ok": False, "error": "נדרש שם"}), 400

    emp = Employee(
        id=str(uuid.uuid4()),
        name=new_name,
        is_driver=bool(body.get("is_driver", False)),
        address=body.get("address", ""),
        lat=float(body.get("lat") or 0.0),
        lng=float(body.get("lng") or 0.0),
    )
    employees.append(emp)
    save_employees(employees)
    return jsonify({"ok": True, "employee": emp.to_dict()})


@app.route("/api/employees/<emp_id>", methods=["PUT"])
def api_edit_employee(emp_id):
    body      = request.get_json()
    employees = load_employees()
    idx       = next((i for i, e in enumerate(employees) if e.id == emp_id), None)
    if idx is None:
        return jsonify({"ok": False, "error": "עובד לא נמצא"}), 404

    e          = employees[idx]
    e.name     = (body.get("name") or e.name).strip()
    e.is_driver = bool(body.get("is_driver", e.is_driver))
    e.address  = body.get("address", e.address)
    e.lat      = float(body.get("lat") or e.lat)
    e.lng      = float(body.get("lng") or e.lng)
    employees[idx] = e
    save_employees(employees)
    return jsonify({"ok": True, "employee": e.to_dict()})


@app.route("/api/employees/<emp_id>", methods=["DELETE"])
def api_delete_employee(emp_id):
    employees = load_employees()
    new_list  = [e for e in employees if e.id != emp_id]
    if len(new_list) == len(employees):
        return jsonify({"ok": False, "error": "עובד לא נמצא"}), 404
    save_employees(new_list)
    img = _find_image_path(emp_id)
    if img:
        os.remove(img)
    return jsonify({"ok": True})


@app.route("/api/employees/<emp_id>/image")
def api_employee_image(emp_id):
    path = _find_image_path(emp_id)
    if not path:
        return "", 404
    ext  = path.rsplit(".", 1)[1].lower()
    mime = {"jpg": "image/jpeg", "jpeg": "image/jpeg",
            "png": "image/png",  "webp": "image/webp"}[ext]
    return send_file(path, mimetype=mime, max_age=86400)


@app.route("/api/employees/<emp_id>/image", methods=["POST"])
def api_upload_employee_image(emp_id):
    employees = load_employees()
    if not any(e.id == emp_id for e in employees):
        return jsonify({"ok": False, "error": "עובד לא נמצא"}), 404

    if "image" not in request.files:
        return jsonify({"ok": False, "error": "לא נשלח קובץ"}), 400

    file = request.files["image"]
    if not file or not file.filename:
        return jsonify({"ok": False, "error": "קובץ ריק"}), 400

    ext = file.filename.rsplit(".", 1)[-1].lower() if "." in file.filename else ""
    if ext not in ALLOWED_IMAGE_EXTS:
        return jsonify({"ok": False, "error": "סוג קובץ לא נתמך (jpg/png/webp בלבד)"}), 400

    data = file.read()
    if len(data) > 5 * 1024 * 1024:
        return jsonify({"ok": False, "error": "הקובץ גדול מדי (מקסימום 5MB)"}), 400

    if ext == "jpeg":
        ext = "jpg"

    os.makedirs(UPLOAD_DIR, exist_ok=True)

    for old_ext in ALLOWED_IMAGE_EXTS:
        old_path = os.path.join(UPLOAD_DIR, f"{emp_id}.{old_ext}")
        if os.path.exists(old_path):
            os.remove(old_path)

    with open(os.path.join(UPLOAD_DIR, f"{emp_id}.{ext}"), "wb") as f:
        f.write(data)

    return jsonify({"ok": True, "image_url": f"/api/employees/{emp_id}/image"})


if __name__ == "__main__":
    port  = int(os.environ.get("PORT", 5000))
    debug = os.environ.get("FLASK_DEBUG", "0") == "1"
    app.run(host="0.0.0.0", port=port, debug=debug)
