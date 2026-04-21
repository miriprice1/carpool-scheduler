# 🚗 לוח נסיעות — Carpool Scheduler

An internal web app for managing weekly carpool schedules for a team of employees.

## Features

- **2-week block driver rotation** — automatically selects 2 primary drivers per 2-week block, cycling fairly based on total weeks driven
- **Daily WFH substitution** — when a primary driver works from home, the off-duty driver fills in for that day only
- **Geographic passenger assignment** — passengers are grouped to the nearest driver's car using haversine distance
- **Google Maps route optimisation** — pickup order within each car is optimised via the Directions API; falls back to nearest-neighbour if no key is set
- **Interactive route map** — Leaflet.js map with step-level road polyline, numbered pickup markers, and a "Open in Google Maps" link
- **Drag-and-drop editing** — move passengers between cars or to public transport; route km recalculates automatically after each change
- **Fairness warnings** — alerts when a manual swap would disadvantage someone with fewer rides
- **Monthly summary** — calendar view of weekly drivers and substitutes per month
- **Schedule history** — expandable list of all saved weeks

## Tech Stack

| Layer | Technology |
|---|---|
| Backend | Python 3.10+ · Flask · Gunicorn |
| Routing | Google Maps Directions API (haversine fallback) |
| Frontend | Vanilla JS · HTML5 drag-and-drop |
| Maps | Leaflet.js + OpenStreetMap tiles |
| State | JSON file on persistent disk |

## Local Development

```bash
# 1. Clone
git clone https://github.com/miriprice1/carpool-scheduler.git
cd carpool-scheduler

# 2. Install dependencies
pip install -r requirements.txt

# 3. Create your local config (gitignored)
cp config.json.example config.json
# Edit config.json — add your workplace coordinates and Google Maps API key

# 4. Run
python app.py
# → http://localhost:5000
```

## Configuration

### `config.json` (local, gitignored)

```json
{
  "workplace": {
    "name": "שם המשרד",
    "lat": 31.9117,
    "lng": 34.8090
  },
  "google_maps_api_key": "YOUR_KEY_HERE"
}
```

Get a Google Maps key: Google Cloud Console → Enable **Directions API** → Credentials → Create API Key.
Free tier: 40,000 Directions calls/month. This app uses ≤ 10/week.

### `employees.json`

Each employee entry:

```json
{
  "id": "unique-id",
  "name": "Full Name",
  "is_driver": true,
  "address": "Street, City",
  "lat": 31.9274,
  "lng": 35.0481
}
```

Employees with `lat`/`lng` of `0.0` are assigned without geographic optimisation (the app degrades gracefully).

## Deploying to Render

The repo includes a `render.yaml` for one-click deployment.

1. Go to [render.com](https://render.com) → **New → Web Service** → connect this repo
2. Render auto-detects `render.yaml` — confirm **Starter plan** ($7/mo, required for persistent disk)
3. Add environment variables in the Render dashboard:

| Variable | Description |
|---|---|
| `GOOGLE_MAPS_API_KEY` | Your Maps Directions API key |
| `WORKPLACE_NAME` | Display name for the office |
| `WORKPLACE_LAT` | Office latitude |
| `WORKPLACE_LNG` | Office longitude |

4. The persistent disk (`/data`) keeps `state.json` alive across redeploys.
5. Future deploys: `git push` — Render auto-deploys.

## State Persistence

- **Local:** `state.json` lives next to `app.py` (gitignored)
- **Render:** `state.json` lives on a 1 GB persistent disk mounted at `/data` (set via `DATA_DIR=/data` env var)

## Project Structure

```
carpool/
├── app.py              # Flask routes & helpers
├── scheduler.py        # Driver rotation & day scheduling logic
├── routing.py          # Google Maps API + haversine fallback
├── models.py           # Employee, CarAssignment, DaySchedule dataclasses
├── employees.json      # Employee roster with coordinates
├── config.json.example # Template — copy to config.json and fill in
├── static/
│   ├── drag.js         # All frontend logic (schedule UI, drag-drop, map)
│   └── style.css
└── templates/
    └── index.html
```
