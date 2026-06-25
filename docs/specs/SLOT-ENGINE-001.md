# SLOT-ENGINE-001 — Smart Time Slot Recommendation Engine (reconciled spec)

**Status:** Phase 1 implemented (standalone engine). Phases 2–3 pending.
**Source:** uploaded vendor spec `smart_time_slot_recommendation_engine_requirements.md` (2026-06-25),
reconciled here against Albusto's actual implementation (the vendor spec was written blind to it).

## Goal
When the company installs the marketplace app, the Schedule slot-picker suggests the best arrival
**time-frames + technician** for a new job (cards in a side panel + highlights on the tech
timelines). "Time-frame = arrival window," not job duration.

## Binding decisions (owner interview 2026-06-25)
1. **Separate service.** The engine is a standalone deployable (`slot-engine/`), stateless: Albusto
   pushes the full snapshot (per the input contract) and the engine returns ranked slots. (Push
   model; the engine can evolve to pull `jobs:read` later. Keeps the engine off the browser surface
   and avoids cross-API auth for MVP.)
2. **Technician base locations.** New `technician_base_locations` table + a Settings screen to set
   each tech's home/base lat/lng (Albusto stores none today). Albusto includes them in the snapshot.
3. **Haversine MVP.** Straight-line distance × city-speed + buffers for travel time. Google Routes
   Compute Route Matrix is a later upgrade (vendor spec mandates it; owner chose haversine for MVP).
4. **UI: both.** Recommendation **cards** in a side panel of `CustomTimeModal` **and** highlights on
   the tech timelines, gated by the `smart-slot-engine` marketplace install.

## Albusto reality vs vendor spec (key mismatches handled)
- No `arrival_window_start/end` columns — jobs carry `start_date` + duration; the snapshot passes
  `window_start`/`window_end` (HH:MM) + `duration_minutes` derived by Albusto.
- Technicians come from Zenbooker (`/api/zenbooker/team-members`) with ZIP `assigned_territories`
  (no coords). Base coords come from the new `technician_base_locations` setting.
- `job_type` is free-text; durations resolve via `config.durations.by_job_type` with a default.
- New-job slot picking is single-technician → MVP is single-tech (multi-tech existing jobs are
  honored as blocking schedule entries).
- Marketplace (`marketplace_apps`/`marketplace_installations`, mig 083) gates the feature; an install
  check toggles the UI.

## Phase 1 — Standalone engine ✅ (this commit)
`slot-engine/` — stateless Node/Express service. `POST /api/v1/slot-recommendations` (input/output
contracts in `slot-engine/README.md`). Pipeline: candidate generation → hard filters
(past-timeframe, overlap, nearest-distance, edge distance/time, extra-travel, empty-day) → physical
feasibility (earliest/latest propagation with shift + base) → metrics → weighted scoring → ranking +
diversity → explanations. Config-driven (`src/config.js`), deterministic. 7 scenario tests
(`node --test`) + live HTTP smoke test passing.

## Phase 2 — Albusto integration (pending)
- Migration: `technician_base_locations(company_id, tech_id, lat, lng, label, ...)`.
- Backend CRUD + a Settings screen ("Technician base locations") to set each tech's coords.
- A proxy endpoint (e.g. `POST /api/v1/slot-recommendations`) that: checks the marketplace install
  is connected → gathers technicians (+ base) + the relevant scheduled jobs window + the new job's
  geocoded point → calls the engine (`SLOT_ENGINE_URL`) → returns recommendations. `company_id` only
  from `req.companyFilter`; `requirePermission('schedule.dispatch')`.
- Register the `smart-slot-engine` marketplace app.

## Phase 3 — Slot-picker UI (pending)
- `CustomTimeModal`: fetch recommendations when opened for a new job (only if app installed); render
  a side panel of cards (date · window · technician · score · reason → click applies slot+tech) and
  highlight the recommended windows/lanes on the tech timelines (extends the existing
  `preselectTechId` "Suggested" mechanism).

## Future (vendor spec phases 2–3)
Google Routes Compute Route Matrix (real traffic-aware travel time + cache), multi-technician new
requests (team feasible-interval intersection), skills/service-area matching, learning weights from
dispatcher choices, audit persistence (`slot_recommendation_*` tables).
