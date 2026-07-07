# SLOT-ENGINE-NEAREST-FALLBACK-001 — Tier-2 "nearest-tech" distance fallback

**Status:** Spec (design phase). Owner-approved, binding.
**Depends on:** SLOT-ENGINE-001 (standalone engine, Phase 1–3), REC-SETTINGS-001 (`slotEngineSettingsService`), VAPI-SLOT-ENGINE-001 (Sara offers engine slots on-call).
**Touches:** `slot-engine/src/config.js`, `slot-engine/src/engine.js`, `backend/src/services/slotEngineSettingsService.js` (`buildConfigOverride`). **No migration. No Sara/VAPI change. `recommendSlots.js` (voice-agent) needs no logic change.**

---

## 1. Problem

A caller who **is inside the service area** but has **no technician within the normal radius** currently gets ZERO engine recommendations, so the voice agent falls back to the generic `checkAvailability` slots (loses the smart-routing value on exactly the calls that need it).

### 1.1 Verified root cause (confirmed against code 2026-07-07)

The engine (`slot-engine/src/engine.js`) rejects every candidate for a location like **Weston MA 02493** because of the distance gate, in two places inside the candidate loop:

- **Busy-day gate** — `engine.js:121`: `if (existing.length && nearest > config.geography.max_distance_from_existing_job_miles) reject('nearest_distance_exceeded')`. `nearest` = min haversine from the new point to any of that tech's existing jobs that day.
- **Empty-day gate** — `engine.js:107`: `if (dBase > config.geography.max_distance_from_base_if_empty_day_miles) reject`. `dBase` = haversine from the tech base to the new point. (Also `engine.js:104` rejects empty-day entirely when `allow_empty_day_candidates=false`.)

**The resolved distance on the live CRM path is 10 mi for BOTH gates.** All 5 Boston-area tech bases/jobs are ≥ 11.8 mi from Weston → no candidate survives → the engine returns an empty `recommendations` array → `recommendSlots.js` returns `SLOT_FALLBACK` → Sara offers generic slots. Raising the resolved ceiling to 12–15 mi makes Weston yield 2–3 real recs. Pure distance-gate coverage gap; the rest of the pipeline (overlap, feasibility, scoring) is healthy.

### 1.2 CORRECTION to the original briefing (verified in code)

The briefing stated the live cause is `geography.allow_empty_day_candidates=false`. **That is the engine `DEFAULT_CONFIG` value, NOT the live CRM value.** `backend/src/services/slotEngineSettingsService.js::buildConfigOverride` (line 153) **hardcodes `allow_empty_day_candidates: true`** on every request, and maps the single `max_distance_miles` (=10, from `DEFAULTS`) onto **BOTH** `max_distance_from_existing_job_miles` **AND** `max_distance_from_base_if_empty_day_miles` (line 152, "ONE radius → BOTH keys"). So on prod:

- Empty-day candidates **are** allowed, but capped at the SAME **10 mi** from base.
- Busy-day candidates are capped at **10 mi** from the nearest existing job.

Weston returns 0 because **both** paths are gated at 10 mi, not because empty-day is disabled. This changes the task list: `buildConfigOverride` **must** be extended to also emit the new `fallback_max_distance_miles` key (task T3), otherwise the CRM path keeps the fixed engine default and the fallback never widens beyond whatever the engine ships. (The standalone engine default is set in T1 so direct-to-engine callers/tests get it for free.)

---

## 2. The rule (owner-approved, binding)

### Tier-1 (UNCHANGED)
Rank techs within the normal radius (`geography.max_distance_from_existing_job_miles` for busy days, `geography.max_distance_from_base_if_empty_day_miles` for empty days; both currently 10). **MUST produce byte-identical output to today for any location that is currently covered.**

### Tier-2 (NEW) — fires ONLY when Tier-1 yields ZERO feasible candidates
Relax the distance gate to the **nearest technician(s)**, up to a fallback ceiling of **25 miles** (`geography.fallback_max_distance_miles`, a SEPARATE, larger ceiling than the normal radius). Then:
- Offer that tech's fixed candidate windows that do **not** overlap their existing jobs (overlap invariant preserved — see §4).
- If the nearest tech has an **EMPTY day**, offer from their **base** (drive base→job→base).
- **Rank Tier-2 by nearest** (the existing distance score term already does this; §5).
- Return the same `top_n` (2–3) windows in the **same slot shape** as Tier-1.

### "Nearest" definition
`nearest = min(distance to tech base, distance to that tech's nearest existing job that day)`. This is exactly what `engine.js` already computes: busy-day → `nearest` over existing jobs (`engine.js:119-120`); empty-day → `nearest = haversineMiles(base, newPoint)` (`engine.js:122`). Tier-2 reuses these unchanged; only the ceiling they are compared against widens.

### Non-negotiable invariants
1. **Tier-2 triggers ONLY when Tier-1 is empty.** Never weakens Tier-1 (Tier-1 runs first, untouched; if it returns anything, Tier-2 never runs).
2. **Non-overlap preserved** (`overlap.max_timeframe_overlap_minutes=0`). The 2-hour arrival window absorbs drive time; "don't offer 11–1 over a 10–12 job, offer 12–2" is already enforced and stays enforced.
3. **Fallback ceiling is a fixed engine config value** (no new company setting, no migration) — see §6.

---

## 3. Design — two-pass wrapper in `recommendSlots`

### 3.1 Anchor (exact)

`slot-engine/src/engine.js`, function **`recommendSlots(request)`** (starts line 48). The candidate-generation body is the nested loop `for (const date of dates) { for (const win of config.candidate_timeframes) { for (const tech of techs) { for (let idx …) { … } } } }` (lines **86–195**), which populates `evaluated`, `generated`, `rejected`. The result is then `dedupeBestPerSlot` → `rankAndDiversify` (lines 200–201).

**Refactor (mechanical, behavior-preserving):** extract lines 86–195 into a helper

```
function generateCandidates(dates, techs, snapshot, config, ctx)
  -> { evaluated, generated, rejected }
```

where `ctx` carries the already-computed per-request constants (`nowStamp`, `nr`, `newPoint`, `newGeoConf`, `newDuration`, `lowGeo`, `shiftStart`, `shiftEnd`, `shiftCapacity`). No logic inside the body changes — it is a pure cut/paste into a named function so it can be invoked twice. This is the ONLY structural change; the loop body (every `reject`/`continue`, the overlap check, the feasibility call, scoring) is copied verbatim.

### 3.2 Two-pass control flow (replaces lines 196–214)

```
// ── PASS 1: Tier-1 (config as-is) ─────────────────────────────
const p1 = generateCandidates(dates, techs, snapshot, config, ctx);
let deduped = dedupeBestPerSlot(p1.evaluated);
let generated = p1.generated;
let rejected = p1.rejected;
let usedFallback = false;

// ── PASS 2: Tier-2 (nearest-tech fallback) ────────────────────
// Fires ONLY when Tier-1 produced nothing AND a wider ceiling is configured.
const fbCap = config.geography.fallback_max_distance_miles;
const canFallback = fbCap != null
  && fbCap > config.geography.max_distance_from_existing_job_miles;
if (deduped.length === 0 && canFallback) {
  const fbConfig = deriveFallbackConfig(config, fbCap);   // §3.3
  const p2 = generateCandidates(dates, techs, snapshot, fbConfig, ctx);
  const dedupedFb = dedupeBestPerSlot(p2.evaluated)
    .map((c) => ({ ...c, fallback_tier: 2 }));             // tag
  deduped = dedupedFb;
  generated += p2.generated;
  rejected = config.debug.include_rejected_candidates ? rejected.concat(p2.rejected) : rejected;
  usedFallback = dedupedFb.length > 0;
}

const ranked = rankAndDiversify(deduped, config);          // top_n from Tier-1 cfg
```

`rankAndDiversify` uses `config.ranking.*` (unchanged) so `top_n`/per-tech/per-timeframe caps are identical in both tiers. Tag propagation: `rankAndDiversify` must pass through `fallback_tier` and the fallback reason code (§3.4).

### 3.3 `deriveFallbackConfig(config, fbCap)`

Returns a shallow-cloned config with ONLY the distance ceilings widened to `fbCap`, so the SAME loop body now admits nearest-tech candidates:

```
geography.max_distance_from_existing_job_miles     = fbCap    // busy-day gate → 25
geography.max_distance_from_base_if_empty_day_miles = fbCap   // empty-day gate → 25
geography.allow_empty_day_candidates                = true    // empty-day eligible in Tier-2
travel.max_edge_distance_miles     = max(default, fbCap + headroom)   // don't re-reject on edge dist
travel.max_edge_travel_minutes     = max(default, K*fbCap+BUF w/ headroom)
travel.max_extra_travel_minutes    = max(default, 2*K*fbCap+BUF w/ headroom)
```

Everything else (overlap=0, feasibility slack, workload cap, scoring weights, ranking) is inherited **unchanged**. Rationale for the travel widening: the edge-distance cap default is 25 mi (`travel.max_edge_distance_miles`) and the edge/extra-travel-minute caps are sized (in `buildConfigOverride`) to the NORMAL radius; at a 25 mi fallback the base→job leg can exceed those and would re-reject the very candidate Tier-2 is meant to surface. We lift them to the fallback distance with the SAME `K=2.64 min/mi`, `BUF=10`, 10% headroom formula `buildConfigOverride` already uses, floored at the engine defaults so Tier-2 is never MORE permissive on travel than a correctly-sized Tier-1 would be. **Overlap and feasibility are NOT touched** — a Tier-2 slot must still be physically drivable and non-overlapping; we only stop rejecting on raw distance.

> Note: `deriveFallbackConfig` mutates a **clone**, never `config`, so Pass-1 constants and the `config` handed to `rankAndDiversify` stay pristine.

### 3.4 Output shape

Identical to today. Additions, both optional and additive (no field renamed/removed):
- Each Tier-2 recommendation carries `fallback_tier: 2` and gains reason code **`nearest_tech_fallback`** (pushed in `reasonCodes` or in the tagging step; see T2). Tier-1 recs are unchanged (no `fallback_tier`).
- `summary` gains `used_nearest_fallback: <boolean>` and keeps `generated_candidates_count` (now the sum across passes when Pass 2 ran), `feasible_candidates_count` (= final `deduped.length`), `returned_recommendations_count`.

Consumers (`slotEngineService`, `recommendSlots.js`, `CustomTimeModal`) read `recommendations[]` + `time_frame`/`technicians`/`score`/`confidence` exactly as before; the new fields are ignore-safe.

---

## 4. Non-overlap invariant (preserved)

Tier-2 runs the identical loop body, so the overlap check at `engine.js:114-116` (`if (maxOverlap > config.overlap.max_timeframe_overlap_minutes) reject('timeframe_overlap_exceeded')`) executes with `max_timeframe_overlap_minutes=0` (inherited, NOT relaxed). A Tier-2 window that overlaps the nearest tech's existing job is rejected exactly as in Tier-1. The 2-hour candidate window + feasibility propagation (`checkFeasibility`, lines 217-241) absorb the longer drive: if base→job / job→next travel makes the window infeasible, `route_infeasible`/`insufficient_slack` still reject it. Tier-2 cannot produce an overlapping or physically-impossible slot.

---

## 5. Ranking "by nearest" (already satisfied)

No new ranking code. Tier-2 candidates are scored by the existing `scoreCandidate` (lines 243-258); the distance term `S_dist = exp(-nearest / theta.distance_miles)` (line 248) monotonically favours the nearer tech, and `nearest_existing_job_distance_miles` is the same metric (min-to-existing, or base-distance for empty day). Across a Tier-2-only set, `rankAndDiversify` sorts by `score` desc → nearest-first, subject to the per-tech/per-timeframe diversity caps (unchanged). If the owner later wants pure distance ordering regardless of slack/soonness, that's a follow-up; the approved rule ("rank Tier-2 by nearest") is met by the distance-weighted score today.

---

## 6. Config keys

Added to `slot-engine/src/config.js` `DEFAULT_CONFIG.geography`:

| Key | Default | Meaning |
|---|---|---|
| `geography.fallback_max_distance_miles` | `25` | Tier-2 ceiling. Tier-2 fires only if this `> max_distance_from_existing_job_miles`. Set to `0`/`null`/`≤ normal radius` to DISABLE the fallback (Tier-1-only, byte-identical legacy behavior). |

**Fixed-config vs per-company (CONFIRMED: fixed).** The 25 mi cap is a **fixed engine config value**, plus a one-line unconditional emit in `buildConfigOverride`. Reasons:
- No migration, no `slot_engine_settings` column, no Settings UI, no validation range — matches the owner's "prefer a fixed engine config value unless per-company is trivial."
- The 5 per-company params in `slotEngineSettingsService` are a fixed set (`KEYS`), PUT-replace-all, range-validated; adding a 6th ripples into `DEFAULTS`/`VALIDATION`/`validate`/`coerceStored`/the Settings screen/migration — NOT trivial.
- `buildConfigOverride` emits `fallback_max_distance_miles: 25` as a constant (alongside the existing fixed `allow_empty_day_candidates`/`max_day_utilization`), so every company gets it uniformly. If per-company tuning is ever wanted, it becomes a 6th settings key later without reworking the engine.

**Migration truly avoidable: YES.** Nothing is persisted. The value lives in code (engine default + CRM constant). No DB read/write added.

---

## 7. Behavior scenarios

Coords are Boston-area; distances haversine. `NORMAL=10`, `FALLBACK=25` unless noted.

| # | Scenario | Setup | Expected |
|---|---|---|---|
| **B1 Weston repro** | In-area, no tech within 10 mi | New req Weston (42.36,−71.30); 1 tech base Brookline (42.33,−71.12) ~11.8 mi, one existing job Brookline that day | **Tier-1 empty → Tier-2 fires.** ≥1 rec, tech=that tech, `fallback_tier=2`, reason `nearest_tech_fallback`, non-overlapping window. `summary.used_nearest_fallback=true`. |
| **B2 Covered ZIP — NO change** | Location already covered | Existing engine.test `baseRequest()` (new req ~1 mi from existing job) | **Byte-identical to today.** Same recs, scores, order; NO `fallback_tier`, `used_nearest_fallback=false`. (Tier-2 never runs — Tier-1 non-empty.) |
| **B3 25 mi cap rejection** | Truly out of area | New req Worcester (42.26,−71.80) ~40 mi; nearest tech Brookline | **Tier-1 empty, Tier-2 empty** (40 > 25). `recommendations=[]`, `used_nearest_fallback=false`. (Voice agent → generic fallback, correct.) |
| **B4 Non-overlap in Tier-2** | Fallback tech is busy | New req at 15 mi; nearest tech has a 10:00–12:00 job; candidate 10:00–12:00 vs 12:00–14:00 | Tier-2 **omits** 10:00 (overlaps), **offers** 12:00. No returned window overlaps an existing job. |
| **B5 Empty-day from base** | Fallback tech idle that day | New req at 15 mi; nearest tech has NO jobs that day, base 15 mi away | Tier-2 fires; candidate anchored on base (drive base→job→base); `nearest_existing_job_distance_miles` ≈ base distance; feasible windows returned. |
| **B6 Tier-1 non-empty → Tier-2 never runs** | One tech far, one near | New req near tech A (in 10 mi) and far tech B (18 mi) | Only Tier-1 (tech A) recs; tech B NOT offered even though ≤25 mi. Proves the empty-gate trigger, not "always widen." `used_nearest_fallback=false`. |
| **B7 Nearest-first ranking** | Two techs in the fallback band | New req 15 mi from tech A, 22 mi from tech B, both >10 (Tier-1 empty) | Both may appear (diversity), but the **rank-1** rec is tech A (nearer → higher `S_dist`). |
| **B8 Fallback disabled** | Legacy config | `fallback_max_distance_miles=0` (or ≤ normal), Weston req | Tier-2 **never runs**; `recommendations=[]` exactly like pre-feature. Guards the off-switch. |
| **B9 Edge/extra widened, not overlap/feasibility** | Long base leg | New req 20 mi from an empty-day tech base | Candidate NOT rejected by `edge_distance_exceeded`/`extra_travel_exceeded` (caps lifted to fallback), but a window too tight to drive+serve is STILL rejected by `route_infeasible`/`insufficient_slack`. |
| **B10 CRM path passthrough** | Full override | `buildConfigOverride(DEFAULTS)` output | Contains `geography.fallback_max_distance_miles=25` alongside `allow_empty_day_candidates=true`, `max_distance_from_existing_job_miles=10`. Proves the CRM widens Tier-2 to 25 while Tier-1 stays 10. |
| **B11 Multi-tech req unaffected** | required_technician_count>1 | New req with count=2 | Early `multi_technician_requests_not_supported_in_mvp` return (line 58) is BEFORE the two-pass block → unchanged; no fallback attempted. |
| **B12 Low-geo still flagged in Tier-2** | ZIP centroid + far | New req geo_confidence 0.4, 15 mi out | Tier-2 recs returned but every one `confidence='low'` + `requires_dispatch_confirmation` + `low_location_confidence` (the `lowGeo` logic in the loop body is inherited unchanged). |

---

## 8. Out of scope / freeze

- Sara / VAPI assistant config + prompt — untouched (memory: re-inject `VAPI_TOOLS_SECRET`, don't toggle `answerOnBridge`; N/A here, no VAPI write).
- `recommendSlots.js` (voice-agent tool) — no logic change; it already returns whatever the engine gives and falls back to `SLOT_FALLBACK` on empty, which now happens strictly less often.
- `CustomTimeModal` / Schedule UI — reads `recommendations[]` unchanged; `fallback_tier` is optional and ignore-safe (a later UI badge "outside normal area" is a follow-up, not this feature).
- Google Routes travel model, multi-tech, learning weights — still future (SLOT-ENGINE-001 §Future).
