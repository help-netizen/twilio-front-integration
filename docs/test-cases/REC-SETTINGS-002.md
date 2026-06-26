# Тест-кейсы: REC-SETTINGS-002 — derived empty-day travel caps in `buildConfigOverride`

**Spec:** `docs/specs/REC-SETTINGS-002.md` · **Requirements:** `docs/requirements.md` → REC-SETTINGS-002 (AC-1..AC-6) · **Architecture:** `docs/architecture.md` → "REC-SETTINGS-002 — design (2026-06-26)".
**Unit under test:** `slotEngineSettingsService.buildConfigOverride(settings)`.
**Test file:** `tests/slotEngineSettings.test.js` (extend the existing `describe('buildConfigOverride', …)` block).

## Покрытие

- Всего тест-кейсов: **14** (TC-RS2-001 .. TC-RS2-014).
- P0: 7 · P1: 5 · P2: 2.
- Unit: 14 · Integration: 0 · E2E: 0.
- No new API surface, no DB, no middleware → no auth/isolation tests in this follow-up (covered by REC-SETTINGS-001 TC-RS-060..). These are pure-function unit tests.

### Reference formula (for expected values)

`K = (60/25)*1.10 = 2.64`; `edge(D) = 2.64·D + 10`; `extra(D) = 5.28·D + 10`;
`max_edge = max(45, ceil(edge(D)*1.10))`; `max_extra = max(35, ceil(extra(D)*1.10))`.

| D | edge(D) | extra(D) | max_edge | max_extra |
|---|---|---|---|---|
| 1 | 12.64 | 15.28 | 45 | 35 |
| 5 | 23.20 | 36.40 | 45 | 41 |
| 10 | 36.40 | 62.80 | 45 | 70 |
| 25 | 76.00 | 142.00 | 84 | 157 |
| 100 | 274.00 | 538.00 | 302 | 592 |

---

### TC-RS2-001: `travel` block is present and well-formed (AC-1)
- **Приоритет:** P0 · **Тип:** Unit · **Сценарий:** AC-1 (travel caps emitted).
- **Входные данные:** `buildConfigOverride(DEFAULTS)` (D=10).
- **Ожидаемый результат:** result has a `travel` object; `Object.keys(o.travel).sort()` equals `['max_edge_travel_minutes','max_extra_travel_minutes']` (exactly those 2 keys — no `model`/`average_city_speed_mph`/etc.). Both values are integers.
- **Файл для теста:** `tests/slotEngineSettings.test.js`.

### TC-RS2-002: 7 top-level keys including `travel` (supersedes RS-001 TC-RS-006) (AC-1, AC-4)
- **Приоритет:** P0 · **Тип:** Unit · **Сценарий:** contract change vs REC-SETTINGS-001.
- **Входные данные:** `buildConfigOverride(DEFAULTS)`.
- **Ожидаемый результат:** `Object.keys(o).sort()` equals `['feasibility','geography','overlap','planning','ranking','travel','workload']`. (Explicitly replaces the old assertion that there were 6 keys and `o.travel` was `undefined`.)
- **Файл для теста:** `tests/slotEngineSettings.test.js`.

### TC-RS2-003: DEFAULTS (D=10) → exact caps 45 / 70 (AC-1, AC-5)
- **Приоритет:** P0 · **Тип:** Unit · **Сценарий:** default safe coverage.
- **Входные данные:** `buildConfigOverride(DEFAULTS)`.
- **Ожидаемый результат:** `o.travel.max_edge_travel_minutes === 45` AND `o.travel.max_extra_travel_minutes === 70`.
- **Файл для теста:** `tests/slotEngineSettings.test.js`.

### TC-RS2-004: D=1 → caps floor to engine defaults 45 / 35 (AC-3, edge case 1)
- **Приоритет:** P0 · **Тип:** Unit · **Сценарий:** min radius / flooring.
- **Входные данные:** `buildConfigOverride({ ...DEFAULTS, max_distance_miles: 1 })`.
- **Ожидаемый результат:** `o.travel.max_edge_travel_minutes === 45` AND `o.travel.max_extra_travel_minutes === 35` (formula yields 12.64/15.28, both floored up to the engine defaults).
- **Файл для теста:** `tests/slotEngineSettings.test.js`.

### TC-RS2-005: D=25 → exact caps 84 / 157 (AC-1)
- **Приоритет:** P1 · **Тип:** Unit · **Сценарий:** representative mid radius.
- **Входные данные:** `buildConfigOverride({ ...DEFAULTS, max_distance_miles: 25 })`.
- **Ожидаемый результат:** `o.travel.max_edge_travel_minutes === 84` AND `o.travel.max_extra_travel_minutes === 157`.
- **Файл для теста:** `tests/slotEngineSettings.test.js`.

### TC-RS2-006: D=100 → exact caps 302 / 592 (AC-1, edge case 2)
- **Приоритет:** P1 · **Тип:** Unit · **Сценарий:** max radius (workday still bounds).
- **Входные данные:** `buildConfigOverride({ ...DEFAULTS, max_distance_miles: 100 })`.
- **Ожидаемый результат:** `o.travel.max_edge_travel_minutes === 302` AND `o.travel.max_extra_travel_minutes === 592`.
- **Файл для теста:** `tests/slotEngineSettings.test.js`.

### TC-RS2-007: edge cap never < 45 across the full range (AC-3)
- **Приоритет:** P0 · **Тип:** Unit · **Сценарий:** never-more-restrictive (edge floor).
- **Входные данные:** for D in `[1,2,5,10,13,14,25,50,100]` call `buildConfigOverride({ ...DEFAULTS, max_distance_miles: D })`.
- **Ожидаемый результат:** every `o.travel.max_edge_travel_minutes >= 45`. (edge(D)*1.1 crosses 45 around D≈12.4, so D≤13 stays floored at 45 and D≥14 exceeds it — both satisfy ≥45.)
- **Файл для теста:** `tests/slotEngineSettings.test.js`.

### TC-RS2-008: extra cap never < 35 across the full range (AC-3)
- **Приоритет:** P0 · **Тип:** Unit · **Сценарий:** never-more-restrictive (extra floor).
- **Входные данные:** for D in `[1,2,3,4,5,10,25,100]` call `buildConfigOverride(...)`.
- **Ожидаемый результат:** every `o.travel.max_extra_travel_minutes >= 35`. (extra(D)*1.1 crosses 35 around D≈4.1, so D≤4 stays floored at 35 and D≥5 exceeds it.)
- **Файл для теста:** `tests/slotEngineSettings.test.js`.

### TC-RS2-009: caps are monotonic non-decreasing in D (AC-3)
- **Приоритет:** P1 · **Тип:** Unit · **Сценарий:** monotonicity (wider radius never narrows feasibility).
- **Входные данные:** D = `[1,5,10,25,50,100]`; collect `max_edge` and `max_extra` for each.
- **Ожидаемый результат:** both sequences are non-decreasing (`caps[i] <= caps[i+1]` for all i). Specifically `max_extra` is strictly increasing (`35 < 41 < 70 < 157 < ... < 592`); `max_edge` is non-decreasing (`45 = 45 = 45 < 84 < ... < 302`).
- **Файл для теста:** `tests/slotEngineSettings.test.js`.

### TC-RS2-010: caps equal the closed-form formula for representative radii (AC-1)
- **Приоритет:** P0 · **Тип:** Unit · **Сценарий:** formula fidelity (parametrized).
- **Входные данные:** table-driven over `[[1,45,35],[5,45,41],[10,45,70],[25,84,157],[100,302,592]]` as `[D, expEdge, expExtra]`.
- **Ожидаемый результат:** for each row, `o.travel.max_edge_travel_minutes === expEdge` AND `o.travel.max_extra_travel_minutes === expExtra`. (The expected values are computed by hand from `max(45, ceil((2.64·D+10)*1.1))` / `max(35, ceil((5.28·D+10)*1.1))` — assert against literals, not a re-implementation of the formula in the test, so a formula bug can't pass.)
- **Файл для теста:** `tests/slotEngineSettings.test.js`.

### TC-RS2-011: `extraTravelMinutes(5) ≈ 35` prod-data-point sanity (AC-2)
- **Приоритет:** P1 · **Тип:** Unit · **Сценарий:** reproduces the observed ~5 mi / 35 min cutoff.
- **Входные данные:** compute the raw (pre-headroom, pre-floor) extra-travel at D=5 from the same constants the implementation exposes/uses: `extra(5) = 5.28*5 + 10`.
- **Ожидаемый результат:** `extra(5)` is within ±1 of 35 (`≈ 36.4`); equivalently, solving `extra(D)=35` gives `D ≈ 4.7` mi (assert `4.5 <= (35-10)/5.28 <= 5.0`). This pins the formula to the engine's empirical empty-day cutoff so a future constant drift is caught.
- **Файл для теста:** `tests/slotEngineSettings.test.js`.
- **Примечание:** if the constants `K`/`BUF` are not exported, assert via a literal recomputation in the test comment-documented form; the goal is a guard that `extra(5)` rounds to ~35, not to re-test JS arithmetic.

### TC-RS2-012: the 2 fixed values still correct and unchanged (AC-4)
- **Приоритет:** P0 · **Тип:** Unit · **Сценарий:** REC-SETTINGS-001 invariants preserved.
- **Входные данные:** `buildConfigOverride(DEFAULTS)` and `buildConfigOverride({ max_distance_miles: 1, overlap_minutes: 0, min_buffer_minutes: 0, horizon_days: 1, recommendations_shown: 1 })`.
- **Ожидаемый результат:** in both, `o.geography.allow_empty_day_candidates === true` AND `o.workload.max_day_utilization === 0.95` (the travel block does not perturb the fixed values).
- **Файл для теста:** `tests/slotEngineSettings.test.js`.

### TC-RS2-013: geography / overlap / feasibility / planning / ranking mappings unchanged (AC-4)
- **Приоритет:** P1 · **Тип:** Unit · **Сценарий:** all REC-SETTINGS-001 mappings byte-for-byte intact.
- **Входные данные:** `buildConfigOverride({ max_distance_miles: 25, overlap_minutes: 30, min_buffer_minutes: 45, horizon_days: 7, recommendations_shown: 5 })`.
- **Ожидаемый результат:**
  - `o.geography.max_distance_from_existing_job_miles === 25` AND `o.geography.max_distance_from_base_if_empty_day_miles === 25` (ONE radius → BOTH keys);
  - `o.overlap.max_timeframe_overlap_minutes === 30`;
  - `o.feasibility.min_required_slack_minutes === 45` (Min buffer — independent of travel caps);
  - `o.planning.horizon_days === 7`;
  - `o.ranking.top_n === 5`.
- **Файл для теста:** `tests/slotEngineSettings.test.js`.

### TC-RS2-014: `travel.max_edge_distance_miles` (and other travel.* keys) NOT emitted (AC-1, AC-6)
- **Приоритет:** P2 · **Тип:** Unit · **Сценарий:** only the 2 derived caps are overridden; the rest stay at engine defaults via deep-merge.
- **Входные данные:** `buildConfigOverride({ ...DEFAULTS, max_distance_miles: 25 })`.
- **Ожидаемый результат:** `o.travel.max_edge_distance_miles === undefined` AND `o.travel.model === undefined` AND `o.travel.average_city_speed_mph === undefined` AND `o.travel.operational_buffer_minutes === undefined` (the override must not pin these — the engine keeps its defaults). Only `max_edge_travel_minutes` + `max_extra_travel_minutes` are present.
- **Файл для теста:** `tests/slotEngineSettings.test.js`.

---

## Регрессии в существующем наборе (REC-SETTINGS-001)

The two REC-SETTINGS-001 assertions inside `tests/slotEngineSettings.test.js` that hard-code the OLD shape must be updated as part of TASK-RS2-1 (they are intentionally superseded by TC-RS2-002 / TC-RS2-014):
- `Object.keys(o).sort()` expecting the **6**-key list → now **7** keys incl. `travel`.
- `expect(o.travel).toBeUndefined()` → removed (travel is now present).

All other REC-SETTINGS-001 `buildConfigOverride` assertions (TC-RS-001..005 values, ONE-radius→BOTH-keys, fixed values) remain valid and MUST still pass unchanged — verifying AC-4 (mapping unchanged).
