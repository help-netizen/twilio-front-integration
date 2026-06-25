# Albusto Slot Engine (SLOT-ENGINE-001)

Standalone, **stateless** service that ranks arrival **time-frames + technician** for a new job.
MVP: **haversine** travel, single-technician, fixed candidate windows. (Google Routes Compute
Route Matrix is a planned upgrade — see `docs/specs/SLOT-ENGINE-001.md`.)

It holds no data: Albusto pushes the full snapshot (new job geo, technicians + base locations,
scheduled jobs) in the request and the engine returns ranked recommendations.

## Run

```bash
cd slot-engine
npm install
npm start            # listens on :4500 (PORT env to override)
npm test             # node --test (7 scenario tests, no deps)
```

## API

`POST /api/v1/slot-recommendations`

```jsonc
{
  "request_id": "req_1",
  "requested_at": "2026-06-25T08:00:00-04:00",   // company-local wall clock; windows are local
  "config_override": { /* optional, deep-merged over src/config.js defaults */ },
  "new_request": {
    "id": "n1", "lat": 42.35, "lng": -71.09,
    "geo_confidence": 0.9, "uncertainty_radius_meters": 2500,   // optional (e.g. ZIP centroid)
    "job_type": "service_call", "duration_minutes": null,
    "required_technician_count": 1,
    "earliest_allowed_date": "2026-06-25", "latest_allowed_date": "2026-06-27"
  },
  "technicians": [
    { "id": "tech_001", "name": "Robert", "active": true, "base": { "lat": 42.36, "lng": -71.06 } }
  ],
  "scheduled_jobs": [
    { "id": "j1", "date": "2026-06-25", "status": "scheduled", "job_type": "service_call",
      "window_start": "10:00", "window_end": "12:00", "lat": 42.34, "lng": -71.10,
      "duration_minutes": 60, "assigned_technicians": ["tech_001"] }
  ]
}
```

Returns `{ recommendations: [{ rank, date, time_frame, technicians, score, confidence,
feasible_arrival_interval, metrics, reason_codes, explanation }], summary }`.

`GET /health` → liveness.

## Pipeline (`src/engine.js`)

candidate generation (date × fixed window × technician × insertion position) → hard filters
(past-timeframe, overlap, nearest-distance, edge distance/time, extra-travel, empty-day) →
**physical feasibility** (earliest/latest propagation with shift + base anchoring) → metrics →
weighted scoring → ranking + diversity → explanations.

Config lives in `src/config.js` (NFR: config-driven, deterministic). The engine is pure and
side-effect free; the HTTP layer (`src/server.js`) is a thin wrapper.
