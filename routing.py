"""
routing.py — Geographic passenger assignment and route optimization.

Two-stage approach:
  1. assign_passengers_to_cars(): haversine proximity grouping (which car each passenger rides in)
  2. optimize_route(): Google Maps Directions API with waypoint optimization (pickup order + km)
                       Falls back to haversine nearest-neighbor if no API key is set.
"""

import json
import math
import sys
import urllib.parse
import urllib.request

GMAPS_DIRECTIONS_URL = "https://maps.googleapis.com/maps/api/directions/json"


# ── Distance ──────────────────────────────────────────────────────────────────

def haversine(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    """Straight-line distance in km between two WGS-84 points."""
    R = 6371.0
    dlat = math.radians(lat2 - lat1)
    dlng = math.radians(lng2 - lng1)
    a = (math.sin(dlat / 2) ** 2
         + math.cos(math.radians(lat1)) * math.cos(math.radians(lat2))
         * math.sin(dlng / 2) ** 2)
    return R * 2 * math.asin(math.sqrt(max(0.0, a)))


def _has_location(emp) -> bool:
    return emp.lat != 0.0 or emp.lng != 0.0


# ── Route optimization ────────────────────────────────────────────────────────

def _optimize_gmaps(
    driver_lat: float,
    driver_lng: float,
    passengers: list,
    workplace: tuple[float, float],
    api_key: str,
) -> tuple[list, float, str]:
    """
    Google Maps Directions API — optimize:true waypoints.
    Returns (reordered_passengers, total_km, encoded_overview_polyline).
    Uses ~1 API call per car per day (≤ 10/week, well within free tier).
    """
    if not passengers:
        km = haversine(driver_lat, driver_lng, *workplace)
        return [], km, ""

    wp_str = "optimize:true|" + "|".join(f"{p.lat},{p.lng}" for p in passengers)
    params = urllib.parse.urlencode({
        "origin":      f"{driver_lat},{driver_lng}",
        "destination": f"{workplace[0]},{workplace[1]}",
        "waypoints":   wp_str,
        "key":         api_key,
    })
    url = f"{GMAPS_DIRECTIONS_URL}?{params}"

    print(f"[routing] Calling Google Maps Directions API: origin={driver_lat},{driver_lng} "
          f"dest={workplace} waypoints={len(passengers)}", file=sys.stderr)

    with urllib.request.urlopen(url, timeout=10) as resp:
        data = json.loads(resp.read())

    status = data.get("status")
    if status != "OK":
        error_msg = data.get("error_message", "")
        raise RuntimeError(f"Google Maps API returned: {status} — {error_msg}")

    route   = data["routes"][0]
    order   = route["waypoint_order"]
    total_m = sum(leg["distance"]["value"] for leg in route["legs"])

    # Collect step-level polylines (higher resolution than overview_polyline)
    step_polylines = []
    for leg in route["legs"]:
        for step in leg.get("steps", []):
            pts = step.get("polyline", {}).get("points", "")
            if pts:
                step_polylines.append(pts)
    polyline_data = json.dumps(step_polylines) if step_polylines else ""

    print(f"[routing] Google Maps OK — order={order} km={total_m/1000:.1f} steps={len(step_polylines)}",
          file=sys.stderr)
    return [passengers[i] for i in order], total_m / 1000.0, polyline_data


def _nearest_neighbor(
    driver_lat: float,
    driver_lng: float,
    passengers: list,
    workplace: tuple[float, float],
) -> tuple[list, float]:
    """Haversine nearest-neighbor TSP fallback (no API key required)."""
    unvisited = list(range(len(passengers)))
    order, total = [], 0.0
    cur = (driver_lat, driver_lng)
    while unvisited:
        nearest = min(
            unvisited,
            key=lambda i: haversine(*cur, passengers[i].lat, passengers[i].lng),
        )
        total += haversine(*cur, passengers[nearest].lat, passengers[nearest].lng)
        cur = (passengers[nearest].lat, passengers[nearest].lng)
        order.append(nearest)
        unvisited.remove(nearest)
    total += haversine(*cur, *workplace)
    return [passengers[i] for i in order], total


def optimize_route(
    driver,
    passengers: list,
    workplace: tuple[float, float],
    api_key: str,
) -> tuple[list, float, str]:
    """
    Return (ordered_passengers, total_km, encoded_polyline) for one car.

    - Employees without location data (lat=lng=0) are appended at the end.
    - Uses Google Maps API when api_key is set and driver has coordinates.
    - Falls back to haversine nearest-neighbor otherwise (polyline = "").
    """
    with_loc    = [p for p in passengers if _has_location(p)]
    without_loc = [p for p in passengers if not _has_location(p)]

    if not with_loc:
        return without_loc, 0.0, ""

    if api_key and _has_location(driver):
        try:
            ordered, km, polyline = _optimize_gmaps(
                driver.lat, driver.lng, with_loc, workplace, api_key
            )
            return ordered + without_loc, km, polyline
        except Exception as exc:
            print(f"[routing] Google Maps API failed, falling back to haversine: {exc}",
                  file=sys.stderr)

    if _has_location(driver):
        ordered, km = _nearest_neighbor(driver.lat, driver.lng, with_loc, workplace)
        return ordered + without_loc, km, ""

    return passengers, 0.0, ""  # no coordinates at all — preserve original order


# ── Passenger assignment ──────────────────────────────────────────────────────

def assign_passengers_to_cars(
    drivers: list,
    candidates: list,
    seats_per_car: int,
) -> list[list]:
    """
    Split the fairness-ordered candidate list between cars geographically.

    The seat_counts sort already determined *who* rides; this function determines
    *which car* each rider goes in, minimizing haversine distance to the driver.

    Falls back to sequential assignment (original behavior) when location data
    is unavailable for drivers or passengers.
    """
    buckets: list[list] = [[] for _ in drivers]
    riders = candidates[: seats_per_car * len(drivers)]

    drivers_have_loc    = any(_has_location(d) for d in drivers)
    passengers_have_loc = any(_has_location(p) for p in riders)

    if not drivers_have_loc or not passengers_have_loc:
        # No location data — fill cars sequentially (fairness order preserved)
        for idx, emp in enumerate(riders):
            car_idx = idx // seats_per_car
            if car_idx < len(buckets):
                buckets[car_idx].append(emp)
        return buckets

    for emp in riders:
        if not _has_location(emp):
            # Passenger without location → least-full car
            target = min(
                (i for i in range(len(drivers)) if len(buckets[i]) < seats_per_car),
                key=lambda i: len(buckets[i]),
                default=None,
            )
            if target is not None:
                buckets[target].append(emp)
            continue

        scored = [
            (haversine(emp.lat, emp.lng, d.lat, d.lng), i)
            for i, d in enumerate(drivers)
            if len(buckets[i]) < seats_per_car and _has_location(d)
        ]
        if scored:
            _, best = min(scored)
            buckets[best].append(emp)
        else:
            # Located cars full — assign to any car with space
            for i, bucket in enumerate(buckets):
                if len(bucket) < seats_per_car:
                    bucket.append(emp)
                    break

    return buckets
