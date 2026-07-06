# SCHEDULE-MOBILE-MAP-001 — Test Cases

**Verification model:** frontend-only, no Jest harness for pure UI on this repo
(memory: "frontend has NO test harness"). Gates are **build + preview + manual**.
Build = `npm run build` (tsc -b, strict `noUnusedLocals`) in `frontend/`. Manual =
preview on a mobile viewport (`preview_resize` mobile / real phone).

## P0 — build & no-regression

### TC-MAP-001: build passes (P0)
- **Type:** Build
- **Verify:** `cd frontend && npm run build` exits 0. No unused locals/imports (strict).
  In particular the extracted `frontend/src/utils/mapPins.ts` is imported by both
  `CustomTimeModal.tsx` and `ScheduleJobsMap.tsx` (no dangling/unused export).

### TC-MAP-002: CustomTimeModal extraction didn't break the slot picker (P0)
- **Type:** Manual / preview (desktop)
- **Verify:** Open the slot picker (New Job → pick time, or reschedule). The right-hand map
  still shows numbered per-tech colored pins, the green "★ New" pin, geocode-on-miss still
  places addressless-but-address-bearing jobs, InfoWindow on click, legend present.
  `makePinSvg` output identical (pins look the same as before).
- **Why:** T1 extracts `makePinSvg` out of this live (VAPI-SLOT-ENGINE) component; this is the
  tripwire that the extraction is byte-behavior-preserving.

## P0 — the map renders the filtered jobs

### TC-MAP-003: toggle button swaps icon + view (P0)
- **Type:** Manual / preview (mobile)
- **Verify:** On mobile Schedule, a single icon-button sits **directly left of the gear**.
  In list mode it shows a **Map** icon; tap → list area is replaced by a full-width map and the
  button now shows a **List** icon; tap again → list returns, button shows Map icon. Never two
  buttons.

### TC-MAP-004: map plots exactly the listed (geocoded) jobs, numbered + per-tech colored (P0)
- **Type:** Manual / preview (mobile)
- **Verify:** For a day with several geocoded jobs across ≥2 techs: each listed geocoded job is
  a numbered pin; pins of one tech share that tech's color and equal the tile's left-border
  color for the same tech; numbering is 1..N per tech in start-time order.

### TC-MAP-005: no-geo jobs excluded and counted (P0)
- **Type:** Manual / preview (mobile)
- **Verify:** With a mix of geocoded and `geocoding_status !== 'success'` jobs on the day: only
  geocoded ones get pins; a note reads "N job(s) without a location" where N equals the count of
  listed jobs that were not plotted. (Confirm N by comparing list length vs pin count.)

## P1 — filter/day reactivity & pin detail

### TC-MAP-006: provider filter change updates the map (P1)
- **Type:** Manual / preview (mobile)
- **Verify:** In map mode, change the Provider chip in the gear sheet → pins update to the new
  provider's jobs (and colors), staying in map mode. Adding a second provider shows both techs.

### TC-MAP-007: day change updates the map (P1)
- **Type:** Manual / preview (mobile)
- **Verify:** In map mode, tap a different day in the week strip → pins update to that day's
  geocoded jobs; still in map mode.

### TC-MAP-008: pin tap opens InfoWindow (P1)
- **Type:** Manual / preview (mobile)
- **Verify:** Tapping a pin opens an InfoWindow with tech name + number (in tech color), time
  (company tz), job title/customer, address.

### TC-MAP-009: per-tech connector lines in stop order (P1)
- **Type:** Manual / preview (mobile)
- **Verify:** A tech with ≥2 geocoded stops shows one straight polyline through its stops in
  time order, in the tech color; a tech with 1 stop shows no line; two techs → two separate
  lines, no cross-tech connector. Lines are straight (not road-following).

### TC-MAP-010: empty day → empty map + message (P1)
- **Type:** Manual / preview (mobile)
- **Verify:** A day/provider combo with zero listed jobs (or zero geocoded) → map shows no pins,
  a default center, and an empty-state message; no crash; if there were unplottable jobs the
  count note also shows.

### TC-MAP-011: back-to-list cleanup (P1)
- **Type:** Manual / preview (mobile) + console
- **Verify:** Toggle map→list→map several times. List returns correctly each time; no console
  errors; no duplicated pins on re-entry (markers cleared on unmount/re-place).

## P2 — desktop untouched

### TC-MAP-012: desktop Schedule shows no toggle, no mobile map (P2)
- **Type:** Manual / preview (desktop)
- **Verify:** At desktop width the map toggle button is absent and `ScheduleJobsMap` never
  renders; CalendarControls view switcher still works (day/week/timeline/list). Rotating a
  narrow→wide viewport while map mode was open falls back to the normal desktop view (auto-reset).

### TC-MAP-013: no API key → graceful (P2)
- **Type:** Manual (env)
- **Verify:** With `VITE_GOOGLE_MAPS_API_KEY` unset/invalid, tapping map shows an inline
  "Map unavailable" message rather than a blank/broken box; List toggle still returns to the list.

## Manual preview checklist (run before marking done)

1. `cd frontend && npm run build` → exits 0 (TC-MAP-001).
2. `preview_start`, `preview_resize` preset `mobile`, navigate to `/schedule`.
3. Pick a day known to have geocoded jobs for a provider (seed/select provider chip).
4. Confirm the map-icon button sits left of the gear; tap → map; verify pins/colors/numbers
   (TC-MAP-004), no-geo note (TC-MAP-005), connectors (TC-MAP-009), pin InfoWindow (TC-MAP-008).
5. Change provider (TC-MAP-006) and day (TC-MAP-007) — pins update, stays in map.
6. Tap List icon → list returns (TC-MAP-011). Screenshot list + map states.
7. `preview_resize` preset `desktop` → no toggle, desktop views intact (TC-MAP-012).
8. Open the slot picker on desktop → its map still correct (TC-MAP-002).
