from dataclasses import dataclass, field
from datetime import date


@dataclass
class Employee:
    id: str
    name: str
    is_driver: bool
    address: str = ""
    lat: float = 0.0
    lng: float = 0.0

    def to_dict(self):
        return {
            "id": self.id,
            "name": self.name,
            "is_driver": self.is_driver,
            "address": self.address,
            "lat": self.lat,
            "lng": self.lng,
        }


@dataclass
class CarAssignment:
    car_number: int          # 1 or 2
    driver: Employee
    passengers: list[Employee] = field(default_factory=list)  # ordered by pickup sequence, max 4
    route_km: float = 0.0    # total route distance (driver home → pickups → workplace)
    route_polyline: str = "" # Google Maps encoded overview polyline (empty = haversine fallback)

    def to_dict(self):
        return {
            "car_number": self.car_number,
            "driver": self.driver.to_dict(),
            "passengers": [p.to_dict() for p in self.passengers],
            "route_km": round(self.route_km, 1),
            "route_polyline": self.route_polyline,
        }


@dataclass
class DaySchedule:
    date: date
    cars: list[CarAssignment]          # 0, 1, or 2 entries
    public_transport: list[Employee]
    wfh: list[Employee]
    warning: str | None = None

    def to_dict(self):
        return {
            "date": self.date.isoformat(),
            "cars": [c.to_dict() for c in self.cars],
            "public_transport": [e.to_dict() for e in self.public_transport],
            "wfh": [e.to_dict() for e in self.wfh],
            "warning": self.warning,
        }
