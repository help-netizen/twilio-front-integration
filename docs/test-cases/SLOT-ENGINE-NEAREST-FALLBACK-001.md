# SLOT-ENGINE-NEAREST-FALLBACK-001 — Test cases

**Harness:** `node --test` in `slot-engine/` (same as `test/engine.test.js`, `test/scenarios.test.js`, `test/explain.test.js`). No new framework. Boston-area coords so haversine distances are realistic.
**New file:** `slot-engine/test/fallback.test.js` (Tier-2 behavior + regression guards). Reuse the fixture style from `scenarios.test.js` (`job()`, `newReq()`, `run()` helpers) — copy them or import.
**CRM passthrough:** one case added to `backend/tests/` (see FB-P0-10). Backend suite runs under Jest; worktree note (memory JOBS-UX-RBAC-001): run with `--testPathIgnorePatterns "/node_modules/"`.

Run: `cd slot-engine && node --test` → all green. `cd backend && npx jest slotEngineSettings --testPathIgnorePatterns "/node_modules/"`.

---

## Coordinate fixture (add to `fallback.test.js`)

```
const BROOKLINE = { lat: 42.3318, lng: -71.1212 };   // tech base / existing jobs
const WESTON    = { lat: 42.3668, lng: -71.3020 };   // ~11.9 mi W of Brookline  → Tier-1 miss, Tier-2 hit
const FRAMINGHAM= { lat: 42.2793, lng: -71.4162 };   // ~18 mi W                 → Tier-2 band (>10, <25)
const WORCESTER = { lat: 42.2626, lng: -71.8023 };   // ~40 mi W                 → beyond 25, Tier-2 miss
const NEWTON    = { lat: 42.3370, lng: -71.2092 };   // ~5 mi W                  → covered (Tier-1)
```
Verify the ~11.9 / ~18 / ~40 mi assumptions in a first `console.log(haversineMiles(...))` sanity assertion (FB-P0-00) so a coord typo fails loudly rather than silently mis-tiering a case.

---

## P0 — must pass (core behavior + regression guards)

| ID | Maps to spec | Case (test name) | Assertion |
|---|---|---|---|
| **FB-P0-00** | fixture | `sanity: fixture distances are in the expected bands` | `haversineMiles(BROOKLINE,WESTON)` in (10,25); `(BROOKLINE,FRAMINGHAM)` in (10,25); `(BROOKLINE,WORCESTER) > 25`; `(BROOKLINE,NEWTON) < 10`. |
| **FB-P0-01** | B1 Weston repro | `Weston: Tier-1 empty → Tier-2 returns nearest-tech slots` | new=WESTON, 1 tech base BROOKLINE + existing 10:00–12:00 job BROOKLINE, `config_override:{geography:{fallback_max_distance_miles:25}}`. `recs.length >= 1`; every rec tech = that tech; `rec.fallback_tier===2`; `rec.reason_codes.includes('nearest_tech_fallback')`; `summary.used_nearest_fallback===true`. |
| **FB-P0-02** | B2 covered — NO change | `covered ZIP: output byte-identical, Tier-2 never runs` | Run the EXACT `engine.test.js baseRequest()` twice: once via current code path expectation, once asserting no fallback. `summary.used_nearest_fallback===false`; no rec has `fallback_tier`; `recs[0].score` and ordering unchanged. **Snapshot guard:** deep-equal the `recommendations` array to a captured baseline (see §Regression). |
| **FB-P0-03** | B3 25 mi cap | `Worcester (~40 mi): Tier-2 also empty` | new=WORCESTER, same 1 tech. `recs.length===0`; `summary.used_nearest_fallback===false`. |
| **FB-P0-04** | B4 non-overlap | `Tier-2 preserves overlap=0` | new=FRAMINGHAM (~18 mi), tech has 10:00–12:00 job. No returned rec has `time_frame.start==='10:00'`; assert none overlaps the existing window via `overlapMinutes`. |
| **FB-P0-05** | B5 empty-day-from-base | `Tier-2 empty-day anchors on base` | new=FRAMINGHAM, tech base FRAMINGHAM-ish (set base ~15 mi from BROOKLINE jobs so Tier-1 misses), `scheduled_jobs:[]`, future date, `fallback_max_distance_miles:25`. `recs.length>=1`; `recs.every(r=>r.date===futureDate)`; metric `nearest_existing_job_distance_miles` ≈ base distance (not null). |
| **FB-P0-06** | B6 trigger gate | `Tier-1 non-empty ⇒ Tier-2 never runs` | new=NEWTON (covered) with a far second tech at ~18 mi. `used_nearest_fallback===false`; NO rec has `fallback_tier`; far tech id absent from recs. |
| **FB-P0-07** | B8 off-switch | `fallback disabled ⇒ legacy behavior` | new=WESTON, `config_override:{geography:{fallback_max_distance_miles:0}}`. `recs.length===0`; `used_nearest_fallback===false`. Repeat with the key omitted entirely (engine default via override absent → uses DEFAULT_CONFIG 25, so instead assert: with `max_distance_from_existing_job_miles:25` explicitly equal to fallback, `canFallback` false → no double-run; recs come from Tier-1). |
| **FB-P0-08** | B11 multi-tech | `multi-tech request short-circuits before fallback` | `required_technician_count:2`, WESTON. `summary.note==='multi_technician_requests_not_supported_in_mvp'`; `recs.length===0`; no fallback fields. |
| **FB-P0-09** | Tier-1 regression suite | `existing engine.test.js + scenarios.test.js still 100% green` | Run the WHOLE `slot-engine` suite; every pre-existing case (S1–S8, all engine.test cases, EXP-01–12) passes unchanged. This is the primary "Tier-1 unchanged" guard. |
| **FB-P0-10** | B10 CRM passthrough | `buildConfigOverride emits fallback_max_distance_miles` (backend Jest) | `buildConfigOverride(DEFAULTS).geography.fallback_max_distance_miles === 25`; `.max_distance_from_existing_job_miles === 10`; `.allow_empty_day_candidates === true`. Guards the CRM-seam wiring (the corrected briefing gap §1.2). |

---

## P1 — should pass (ranking, low-geo, travel-cap interplay)

| ID | Maps to | Case | Assertion |
|---|---|---|---|
| **FB-P1-01** | B7 nearest-first | `nearest tech ranks first in Tier-2` | new between tech A (~15 mi) and tech B (~22 mi), both >10 (Tier-1 empty). `recs[0].technicians[0].id === A`. |
| **FB-P1-02** | B12 low-geo | `Tier-2 honors low-geo flagging` | WESTON, `geo_confidence:0.4`. `recs.length>=1`; every rec `confidence==='low'` && `requires_dispatch_confirmation===true` && `reason_codes.includes('low_location_confidence')` (AND still `nearest_tech_fallback`). |
| **FB-P1-03** | B9 caps | `Tier-2 widens travel caps but keeps feasibility` | empty-day tech, base ~20 mi. A drivable window is returned (not `edge_distance_exceeded`); then shrink the day (add bracketing jobs) so it becomes infeasible → that window drops with `route_infeasible`/`insufficient_slack`, NOT a distance code. Inspect via `config_override:{debug:{include_rejected_candidates:true}}`. |
| **FB-P1-04** | summary math | `generated_candidates_count sums both passes when Tier-2 runs` | WESTON case: `summary.generated_candidates_count` > 0 and equals Pass1+Pass2 generated (Pass1 generated some that were all rejected). `feasible_candidates_count === recommendations pre-diversity dedupe count`. |

---

## P2 — nice to have (robustness / diversity)

| ID | Maps to | Case | Assertion |
|---|---|---|---|
| **FB-P2-01** | diversity in Tier-2 | `two fallback techs both surface subject to caps` | two techs at ~15/~18 mi, empty Tier-1. `new Set(recs.map(r=>r.technicians[0].id)).size >= 2` when `top_n>=2`. |
| **FB-P2-02** | no-coord robustness | `Tier-2 robust to a job/base missing coords` | fallback tech with one coord-less job + a valid base. `assert.doesNotThrow`; recs still computed. |
| **FB-P2-03** | multi-day Tier-2 | `Tier-2 spans horizon` | WESTON, latest_allowed_date +2 days, a job on day+1 near WESTON so that day is busy-eligible. recs include >1 date. |

---

## P3 — negative control (MANDATORY sabotage guard)

| ID | Purpose | Sabotage | Expected |
|---|---|---|---|
| **FB-P3-01** | Prove the suite actually detects Tier-2 breakage | Temporarily change `deriveFallbackConfig` to NOT widen `max_distance_from_existing_job_miles` (leave it at normal), OR change the trigger to `if (deduped.length === 0 && false)`. | **FB-P0-01, FB-P0-04, FB-P0-05, FB-P1-01 FAIL** (Tier-2 yields nothing). Restore → all green. Documented as a run-once manual check in the PR, not a committed test. |
| **FB-P3-02** | Prove Tier-1 regression guard bites | Temporarily widen Tier-1 itself (set `max_distance_from_existing_job_miles=25` in DEFAULT_CONFIG). | **FB-P0-02 snapshot + FB-P0-06 + several scenarios.test cases (S3 far→0) FAIL.** Restore → green. |

---

## Regression baseline capture (for FB-P0-02 / FB-P3-02)

Before writing engine changes, run the current engine on `engine.test.js baseRequest()` and `scenarios.test.js` S1/S2/S3 inputs and capture the `recommendations` arrays (candidate_id, date, time_frame, score, confidence, rank) into an inline `const BASELINE = {...}` in `fallback.test.js`. FB-P0-02 deep-equals live output to `BASELINE`. Any Tier-1 drift (a stray shared-config mutation, a scoring change) fails immediately. This is the strongest "byte-identical for covered locations" guarantee and the reason `deriveFallbackConfig` MUST clone (never mutate `config`).

---

## Coverage → scenario map

- Weston repro → FB-P0-01, FB-P1-04
- Covered-ZIP no-change → FB-P0-02, FB-P0-09 (+ whole legacy suite)
- 25 mi cap rejection → FB-P0-03
- Non-overlap → FB-P0-04
- Empty-day-from-base → FB-P0-05
- Tier-1 non-empty ⇒ no Tier-2 → FB-P0-06
- Off-switch → FB-P0-07
- Multi-tech short-circuit → FB-P0-08
- Tier-1 unchanged (regression) → FB-P0-09, FB-P3-02
- CRM passthrough → FB-P0-10
- Nearest-first → FB-P1-01
- Low-geo → FB-P1-02
- Caps vs feasibility → FB-P1-03, FB-P2-* 
- Negative controls → FB-P3-01, FB-P3-02
