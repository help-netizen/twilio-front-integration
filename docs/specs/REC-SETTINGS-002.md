# REC-SETTINGS-002 — `max_distance_miles` as the effective empty-day coverage radius

**Status:** Specification
**Priority:** P1
**Type:** Follow-up to REC-SETTINGS-001 — extend `buildConfigOverride` to also derive the engine travel caps from `max_distance_miles`.
**Requirements:** `docs/requirements.md` → "REC-SETTINGS-002 — make `max_distance_miles` the effective empty-day coverage radius (2026-06-26)" (AC-1..AC-6)
**Architecture:** `docs/architecture.md` → "REC-SETTINGS-002 — design (2026-06-26)"
**Predecessor:** REC-SETTINGS-001 (`docs/specs/REC-SETTINGS-001.md`) — established `buildConfigOverride` and the 5-param + 2-fixed mapping.

---

## Общее описание

REC-SETTINGS-001 maps the dispatcher's **Max distance (mi)** setting (`max_distance_miles`) to the engine's GEO pre-filter (`geography.max_distance_from_existing_job_miles` **and** `geography.max_distance_from_base_if_empty_day_miles`). That gate decides *which* candidates are **generated**, but the engine then independently re-checks each empty-day candidate (base → new job → base) against the **TRAVEL-FEASIBILITY** gates `travel.max_edge_travel_minutes` (default 45) and `travel.max_extra_travel_minutes` (default 35), which REC-SETTINGS-001 left at their `DEFAULT_CONFIG` values. With those defaults the empty-day detour gate cuts off at ~4.5–5 mi straight-line from base, so effective coverage is ~5 mi no matter how large the setting.

REC-SETTINGS-002 **additionally derives the two empty-day-relevant travel caps from `max_distance_miles`** (using the engine's own travel-time constants plus a small headroom) so a job at exactly the radius passes both travel gates and the **GEO gate becomes the binding constraint**. The only code that changes is `buildConfigOverride(settings)` in `backend/src/services/slotEngineSettingsService.js` (and its unit tests). **No engine change, no engine redeploy, no UI change, no DB/migration change.**

---

## Engine travel model (source of the formula — do not guess)

From `slot-engine/src/geo.js` `adjustedTravelMinutes(a, b, config)` (L25–43):

```
rawMinutes  = (haversineMiles(a,b) / average_city_speed_mph) * 60
driveMinutes = rawMinutes * travel_time_multiplier + operational_buffer_minutes
```

The edge/extra-travel **limits** in `slot-engine/src/engine.js` (~L132–147) compare against `driveMinutes` (raw drive; the geo-uncertainty margin is deliberately excluded from detour limits).

Constants from `slot-engine/src/config.js` `DEFAULT_CONFIG.travel`:

| Constant | Value | Used for |
|---|---|---|
| `average_city_speed_mph` | **25** | minutes-per-mile |
| `travel_time_multiplier` | **1.10** | minutes-per-mile |
| `operational_buffer_minutes` | **10** | fixed per-stop add |
| `max_edge_travel_minutes` (default) | **45** | floor for the derived edge cap |
| `max_extra_travel_minutes` (default) | **35** | floor for the derived extra cap |

Empty-day geometry (`engine.js` ~L97, L125–126): the new job is spliced into an empty route at `idx = 0`, so `prev === base` and `next === base`. Therefore:
- `ePrevNew = T(base, newJob)` and `eNewNext = T(newJob, base)` — both at distance `D` (the base↔job straight-line miles).
- `ePrevNext = T(base, base)` — distance **0**, so its `driveMinutes = operational_buffer_minutes = 10`.

---

## Closed-form formula

Let `D = max_distance_miles`, `K = (60 / average_city_speed_mph) * travel_time_multiplier = (60/25)*1.10 = 2.64` min/mi, `BUF = operational_buffer_minutes = 10` min.

```
edgeDriveMinutes(D)  = K·D + BUF                       = 2.64·D + 10
extraTravelMinutes(D) = 2·edgeDriveMinutes(D) − BUF     = 2·K·D + BUF = 5.28·D + 10
```

(`extraTravelMinutes` derivation: `ePrevNew.driveMinutes + eNewNext.driveMinutes − ePrevNext.driveMinutes = (K·D+BUF) + (K·D+BUF) − BUF`.)

**Prod sanity (required to reproduce):** `extraTravelMinutes(5) = 5.28·5 + 10 = 36.4 ≈ 35` (the default cap). Solving `5.28·D + 10 = 35` ⇒ `D ≈ 4.74 mi` — matches the observed empty-day cutoff of ~4.5–5 mi straight-line (job at base → recs; 5.4 mi → 0 feasible). ✔

### Headroom + flooring (the chosen policy)

```
TRAVEL_HEADROOM = 1.10        // +10%, multiplicative
max_edge_travel_minutes  = max(45, ceil(edgeDriveMinutes(D)  * 1.10))
max_extra_travel_minutes = max(35, ceil(extraTravelMinutes(D) * 1.10))
```

- **×1.10 multiplicative** (not flat +N): the margin scales with the cap and absorbs the gap between this straight-line closed form and the engine's actual per-pair haversine recomputation on real lat/lng, guaranteeing a job at exactly `D` passes both travel gates → **geo binds** (AC-2).
- **`Math.ceil`**: keeps caps integer-valued and rounds *up* (toward more headroom, never less).
- **Floor at engine defaults (45 / 35)**: guarantees the override is **never more restrictive than the engine default / than REC-SETTINGS-001's output** (AC-3) — at small radii where the formula yields < 45 / < 35 we keep 45 / 35.

---

## `buildConfigOverride(settings) → object` — full output shape (REC-SETTINGS-002)

Input is the fully-resolved 5-key settings object (`get`/`resolve` guarantee no partials). Output adds **one new `travel` block**; everything else is **identical** to REC-SETTINGS-001:

```js
{
  geography: {
    max_distance_from_existing_job_miles:      settings.max_distance_miles,
    max_distance_from_base_if_empty_day_miles: settings.max_distance_miles, // ONE radius → BOTH keys (unchanged)
    allow_empty_day_candidates:                true,                        // fixed, always (unchanged)
  },
  overlap:     { max_timeframe_overlap_minutes: settings.overlap_minutes },  // unchanged
  feasibility: { min_required_slack_minutes:    settings.min_buffer_minutes },// unchanged
  planning:    { horizon_days:                  settings.horizon_days },     // unchanged
  ranking:     { top_n:                         settings.recommendations_shown }, // unchanged
  workload:    { max_day_utilization:           0.95 },                      // fixed, always (unchanged)

  // NEW in REC-SETTINGS-002 — derived from settings.max_distance_miles:
  travel: {
    max_edge_travel_minutes:  Math.max(45, Math.ceil((K * D + 10) * 1.10)),
    max_extra_travel_minutes: Math.max(35, Math.ceil((2 * K * D + 10) * 1.10)),
  },
}
```

where `D = settings.max_distance_miles` and `K = 2.64`.

**Top-level keys now (7):** `feasibility, geography, overlap, planning, ranking, travel, workload`.
**`travel` keys (exactly 2):** `max_edge_travel_minutes, max_extra_travel_minutes`. No other `travel.*` key is emitted — `model`, `average_city_speed_mph`, `travel_time_multiplier`, `operational_buffer_minutes`, `geo_uncertainty_beta`, `max_edge_distance_miles` all stay at their `DEFAULT_CONFIG` values via `mergeConfig` deep-merge.

### Module constants (mirrored from the engine — NOT imported)

The backend does not depend on the `slot-engine/` package, so these are documented literals in `slotEngineSettingsService.js`:

```
ENGINE_SPEED_MPH     = 25;     // DEFAULT_CONFIG.travel.average_city_speed_mph
ENGINE_TRAVEL_MULT   = 1.10;   // DEFAULT_CONFIG.travel.travel_time_multiplier
ENGINE_OP_BUFFER_MIN = 10;     // DEFAULT_CONFIG.travel.operational_buffer_minutes
ENGINE_EDGE_DEFAULT  = 45;     // DEFAULT_CONFIG.travel.max_edge_travel_minutes
ENGINE_EXTRA_DEFAULT = 35;     // DEFAULT_CONFIG.travel.max_extra_travel_minutes
TRAVEL_HEADROOM      = 1.10;
const K = (60 / ENGINE_SPEED_MPH) * ENGINE_TRAVEL_MULT; // 2.64
```

---

## Worked values (representative radii)

| `max_distance_miles` (D) | `edgeDriveMinutes(D)` | `extraTravelMinutes(D)` | `max_edge_travel_minutes` | `max_extra_travel_minutes` |
|---|---|---|---|---|
| **1**   | 12.64 | 15.28 | **45** (floored) | **35** (floored) |
| **5**   | 23.20 | 36.40 | **45** (floored) | **41** |
| **10** (default) | 36.40 | 62.80 | **45** (floored) | **70** |
| **25**  | 76.00 | 142.00 | **84** | **157** |
| **100** | 274.00 | 538.00 | **302** | **592** |

- `max_extra_travel_minutes` is strictly increasing in D: `35 < 41 < 70 < 157 < 592`.
- `max_edge_travel_minutes` is non-decreasing in D: `45 = 45 = 45 < 84 < 302`.
- At default 10 mi: a job at exactly 10 mi straight-line on an empty day needs `extra = 62.8` and `edge = 36.4`; the caps (70 / 45) exceed both, so the **geo gate (10 mi haversine)** decides — coverage reaches ~10 mi, not ~5 (AC-2, AC-5).

---

## Why the geo gate now binds (correctness argument)

- The empty-day GEO gate compares `haversineMiles(base, newJob)` (raw miles) to `max_distance_from_base_if_empty_day_miles = D` — **no** speed, multiplier, or buffer.
- The travel gates compare `edgeDriveMinutes`/`extraTravelMinutes` (which include ×1.10 + the +10 buffer) to caps that we set to `≥ 1.10 ×` those very quantities evaluated at `D`.
- Therefore for any job within the geo radius (`dist ≤ D`), both travel quantities are `≤` their value at `D` `≤` the cap → travel passes; the only gate that can still reject is geo (`dist > D`) or the engine's **workday/route-fit** checks (`checkFeasibility`: earliest/latest propagation, `min_required_slack_minutes`, `workday.shift_*`, `max_day_utilization`). Those are the intended natural upper bound (binding decision #1), and a single empty-day round trip well inside the workday for any reasonable radius.

> **Note — `min_required_slack_minutes` is independent of this change.** The user-set **Min buffer** still maps to `feasibility.min_required_slack_minutes` (REC-SETTINGS-001) and is enforced inside `checkFeasibility` as route slack — a different gate from the edge/extra travel caps. REC-SETTINGS-002 does not touch it.

---

## Edge cases

1. **Min radius `D = 1`** → `edge = 12.64`, `extra = 15.28`; both below their engine defaults, so caps **floor to 45 / 35**. The edge cap is therefore never below the engine default of 45, and the extra cap never below 35 (AC-3). Geo gate (1 mi) binds.
2. **Max radius `D = 100`** → caps are large (302 / 592 min); travel never binds. The engine's **workday-fit** (shift 08:00–18:00, `max_day_utilization=0.95`) still bounds long routes — a 100-mi straight-line round trip (~9+ h drive alone) is rejected by `checkFeasibility`/utilization, not by a travel cap. This is the intended behavior (no hard drive-time ceiling; workday is the ceiling).
3. **Default / no row (`D = 10`)** → caps 45 / 70; empty-day coverage reaches ~10 mi (AC-5). A company that never saved a row resolves to DEFAULTS and gets exactly this.
4. **Fractional intermediate cap values** → `Math.ceil` after the ×1.10 keeps the emitted values integers; the engine accepts numeric minutes either way, but integers keep the override tidy and assertions exact.
5. **`max_distance_miles` is always an integer 1–100** (guaranteed by `validate`/`get`/`resolve` — VALIDATION range), so `K·D` is well-defined and the floors are the only special case.

---

## Backwards-compatibility

- **Saved settings rows:** unaffected — no schema or migration change; the stored `config` jsonb is still the 5 user params. The travel block is computed at build time from `max_distance_miles`, exactly like the 2 fixed values.
- **No-row companies:** `get`/`resolve` → DEFAULTS (10 mi) → `buildConfigOverride` now also emits `travel:{45,70}`; empty-day coverage improves from ~5 mi to ~10 mi with zero migration.
- **`slotEngineService` consumer:** unchanged — it already calls `settingsService.buildConfigOverride(settings)` and forwards the object verbatim to the engine; it gains the new `travel` block transparently.
- **REC-SETTINGS-001 unit tests:** two assertions become stale and are **superseded** (not merely edited away): the old `TC-RS-006` asserted `Object.keys(o).sort()` equals the 6-key list and `expect(o.travel).toBeUndefined()`. RS-002 changes the contract to **7** top-level keys including `travel`; the REC-SETTINGS-002 test cases (below) replace those two assertions. All other RS-001 assertions (geography/overlap/feasibility/planning/ranking/workload values, ONE-radius→BOTH-keys, the 2 fixed values) remain valid and must still pass.

---

## Protected (must not break)

- `slot-engine/` — `DEFAULT_CONFIG`, `mergeConfig`, `geo.js`, `engine.js`. No change, no redeploy.
- The REC-SETTINGS-001 mapping for the 5 params + 2 fixed values (extended with `travel`, otherwise byte-for-byte unchanged).
- `slotEngineService` consumption + safe-failure path; `resolve`→DEFAULTS still yields a complete override (now incl. `travel`).
- Frontend (no change); routes (no change); DB/migrations (no change).

---

## File-touch summary

- **EDIT:** `backend/src/services/slotEngineSettingsService.js` — extend `buildConfigOverride` with the derived `travel` block + the mirrored engine constants (`ENGINE_*`, `TRAVEL_HEADROOM`, `K`).
- **EDIT:** `tests/slotEngineSettings.test.js` — add REC-SETTINGS-002 `buildConfigOverride` travel assertions; supersede the RS-001 "6 keys / `o.travel` undefined" assertions.
- **No** other files (no `slot-engine/`, no routes, no frontend, no migration).
