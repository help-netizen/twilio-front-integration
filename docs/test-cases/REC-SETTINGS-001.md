# Test Cases: REC-SETTINGS-001 — Configurable Recommendation Settings

**Spec:** `docs/specs/REC-SETTINGS-001.md` (authoritative) · **Requirements:** `docs/requirements.md` → REC-SETTINGS-001 (RS-R1..RS-R6, AC-1..AC-12)
**Sibling reference (harness + patterns):** `tests/technicianBaseLocations.test.js`, `tests/slotEngineProxy.test.js`

## Coverage

- **Total cases:** 56 (44 automated Jest + 12 frontend manual)
- **Automated (44):** service/buildConfigOverride 6 · service/resolve+get 6 · validate 14 · routes 9 · integration (slotEngineService) 4 · migration 128 5
- **Manual (12):** frontend checklist + `npm run build` gate
- **P0:** 22 | **P1:** 18 | **P2:** 12 | **P3:** 4
- **Unit:** 26 | **Integration:** 18 | **Manual/E2E:** 12

### Test files
- **NEW** `tests/slotEngineSettings.test.js` — service (`buildConfigOverride`, `resolve`, `get`, `validate`), queries (company-scoping), routes (`GET`/`PUT`).
- **EDIT/NEW** integration in `tests/slotEngineSettings.test.js` (or extend `tests/slotEngineProxy.test.js`) — `slotEngineService.getRecommendations` consuming resolved settings.
- Migration 128 = case specs (structural assertions; no DB harness in repo — verified by reading `128_*.sql` + a `replaySchema`/`ensureSchema` smoke against the mocked `db.query`).

**Run:** `npx jest --runTestsByPath tests/slotEngineSettings.test.js --testPathIgnorePatterns "/node_modules/"`

### Test-infra note (how to mock the settings resolve in the slotEngineService integration test)
In `tests/slotEngineProxy.test.js` the real `slotEngineService` is `require`d unmocked and drives `getRecommendations`. To assert the engine request reflects settings, **mock the settings module, not the DB**:

```
jest.mock('../backend/src/services/slotEngineSettingsService', () => ({
  resolve: jest.fn(),
  buildConfigOverride: jest.requireActual('../backend/src/services/slotEngineSettingsService').buildConfigOverride,
}));
```

Then per-test `settingsSvc.resolve.mockResolvedValue({ max_distance_miles, overlap_minutes, min_buffer_minutes, horizon_days, recommendations_shown })`, drive `global.fetch.mockResolvedValue({ ok:true, json: async () => ({ recommendations: [] }) })`, call `getRecommendations(COMPANY, { new_job: { lat, lng } })`, then read `JSON.parse(global.fetch.mock.calls[0][1].body)` and assert `body.config_override` deep-equals `buildConfigOverride(resolved)` **and** `body.new_request.latest_allowed_date === addDaysLocal(today, settings.horizon_days)`. Keeping `buildConfigOverride` as the real impl (via `requireActual`) makes the assertion a true equality against production logic, not a copy. (For the date assertion, freeze "today" the same way the service derives it — pass an explicit `new_job` without `latest_allowed_date` so the `addDaysLocal(today, horizon_days)` branch is exercised; AC-5.)

For service/validate/queries unit tests, follow `technicianBaseLocations.test.js`: `jest.mock('../backend/src/db/connection', () => ({ query: jest.fn() }))`, reset in `beforeEach`, `db.query.mockResolvedValue({ rows: [...] })`. For routes, reuse the `appWith({ permissions, companyId })` factory that injects `req.user`, `req.authz.permissions`, and `req.companyFilter = { company_id }`, then mount `require('../backend/src/routes/slotEngineSettings')` at `/` and call with `supertest`.

---

## 1. Service — `buildConfigOverride(settings)` (engine key mapping)

### TC-RS-001: DEFAULTS → exact override
- **Priority:** P0 · **Type:** Unit · **Scenario:** Spec §buildConfigOverride / AC-3 · **File:** `tests/slotEngineSettings.test.js`
- **Input:** `buildConfigOverride(DEFAULTS)` where `DEFAULTS = {10, 0, 15, 3, 3}`.
- **Expected:** deep-equals
  ```
  { geography: { max_distance_from_existing_job_miles: 10, max_distance_from_base_if_empty_day_miles: 10, allow_empty_day_candidates: true },
    overlap: { max_timeframe_overlap_minutes: 0 },
    feasibility: { min_required_slack_minutes: 15 },
    planning: { horizon_days: 3 },
    ranking: { top_n: 3 },
    workload: { max_day_utilization: 0.95 } }
  ```

### TC-RS-002: custom set → exact override
- **Priority:** P0 · **Type:** Unit · **Scenario:** Spec §buildConfigOverride
- **Input:** `{ max_distance_miles: 25, overlap_minutes: 30, min_buffer_minutes: 45, horizon_days: 7, recommendations_shown: 5 }`.
- **Expected:** `geography.max_distance_from_existing_job_miles === 25`, `overlap.max_timeframe_overlap_minutes === 30`, `feasibility.min_required_slack_minutes === 45`, `planning.horizon_days === 7`, `ranking.top_n === 5`; fixed keys unchanged.

### TC-RS-003: ONE radius → BOTH geography keys
- **Priority:** P0 · **Type:** Unit · **Scenario:** AC-4 (mapping table, parameter #1)
- **Input:** `max_distance_miles: 42` (others default).
- **Expected:** `geography.max_distance_from_existing_job_miles === 42` **AND** `geography.max_distance_from_base_if_empty_day_miles === 42` (same value in both keys from one input).

### TC-RS-004: two fixed values always present (DEFAULTS)
- **Priority:** P0 · **Type:** Unit · **Scenario:** AC-2
- **Input:** `buildConfigOverride(DEFAULTS)`.
- **Expected:** `geography.allow_empty_day_candidates === true` and `workload.max_day_utilization === 0.95` present.

### TC-RS-005: two fixed values present regardless of input (no overlap/no buffer)
- **Priority:** P1 · **Type:** Unit · **Scenario:** AC-2 ("regardless of stored content")
- **Input:** `{ max_distance_miles: 1, overlap_minutes: 0, min_buffer_minutes: 0, horizon_days: 1, recommendations_shown: 1 }`.
- **Expected:** `allow_empty_day_candidates === true`, `max_day_utilization === 0.95` still emitted; not overridable/strippable by input. (Guards against an impl that only emits fixed keys "when present".)

### TC-RS-006: output carries no extra/exposed keys
- **Priority:** P2 · **Type:** Unit · **Scenario:** Spec §buildConfigOverride notes (only the 8 paths)
- **Input:** `buildConfigOverride(DEFAULTS)`.
- **Expected:** top-level keys are exactly `{geography, overlap, feasibility, planning, ranking, workload}`; `geography` has exactly the 3 keys; no `travel`/`scoring`/`candidate_timeframes` injected (engine defaults left untouched by the merge).

---

## 2. Service — `resolve(companyId)` / `get(companyId)` (safe-failure, partial-fill)

### TC-RS-010: no row → DEFAULTS
- **Priority:** P0 · **Type:** Unit · **Scenario:** Сценарий 1 / AC-3 · **Mocks:** `db.query` → `{ rows: [] }`
- **Input:** `resolve(COMPANY)` (and `get(COMPANY)`).
- **Expected:** returns `{10,0,15,3,3}` (a full 5-key object equal to DEFAULTS); no `undefined`/partial.

### TC-RS-011: full row → its 5 values
- **Priority:** P0 · **Type:** Unit · **Scenario:** Сценарий 2/3 · **Mocks:** `db.query` → `{ rows: [{ config: { max_distance_miles:20, overlap_minutes:30, min_buffer_minutes:0, horizon_days:10, recommendations_shown:8 } }] }`
- **Expected:** returns exactly those 5 values, integer-typed.

### TC-RS-012: missing individual key → that key falls back to default
- **Priority:** P0 · **Type:** Unit · **Scenario:** Граничные случаи #2 (partial jsonb) · **Mocks:** row `config` = `{ max_distance_miles: 20 }` (4 keys absent).
- **Expected:** `{ max_distance_miles:20, overlap_minutes:0, min_buffer_minutes:15, horizon_days:3, recommendations_shown:3 }` (merge `{...DEFAULTS, ...row.config}`); only the missing keys defaulted.

### TC-RS-013: corrupt/non-numeric key → that key falls back to default
- **Priority:** P1 · **Type:** Unit · **Scenario:** Граничные случаи #2 / error-handling · **Mocks:** row `config` = `{ max_distance_miles: "abc", overlap_minutes: null, horizon_days: 7 }`.
- **Expected:** corrupt `max_distance_miles`→10, `overlap_minutes`→0, kept `horizon_days`→7, untouched `min_buffer_minutes`→15, `recommendations_shown`→3; result is complete and integer-typed (re-coerce after merge).

### TC-RS-014: DB error in `resolve` → DEFAULTS, never throws
- **Priority:** P0 · **Type:** Unit · **Scenario:** §resolve safe-failure / Обработка ошибок #1 / RS-R2 · **Mocks:** `db.query` → `mockRejectedValue(new Error('db down'))`.
- **Expected:** `await resolve(COMPANY)` resolves to DEFAULTS (does NOT reject). Assert with `.resolves.toEqual(DEFAULTS)`.

### TC-RS-015: DB error in `get` → surfaces (does NOT swallow)
- **Priority:** P1 · **Type:** Unit · **Scenario:** §resolve/get split / Обработка ошибок #2 · **Mocks:** `db.query` → reject.
- **Expected:** `get(COMPANY)` rejects (so the GET route can map it to 500); contrast with `resolve` which degrades. (Guards the get-vs-resolve distinction.)

---

## 3. Service — `validate(payload)` (server-enforced, all-or-nothing)

> Boundary matrix below. Each "ok" case → returns coerced integers; each "reject" → throws `{ httpStatus:422, code:'INVALID_SETTINGS', field:'<key>' }`. Valid baseline for single-field cases = DEFAULTS with the one field overridden.

### TC-RS-020: all-fields-valid baseline → coerced integers returned
- **Priority:** P0 · **Type:** Unit · **Scenario:** RS-R5 / Сценарий 2
- **Input:** `{ max_distance_miles: 15, overlap_minutes: 0, min_buffer_minutes: 30, horizon_days: 5, recommendations_shown: 5 }`.
- **Expected:** returns the same 5 as integers (the object stored as `config`).

### TC-RS-021: string coercion `"15"` → 15
- **Priority:** P1 · **Type:** Unit · **Scenario:** §validate ("`"15"`→15 allowed")
- **Input:** all 5 as numeric strings e.g. `max_distance_miles:"15"`, `horizon_days:"5"`.
- **Expected:** coerced to integers; passes.

### TC-RS-022: max_distance_miles boundaries — 1 ok, 100 ok
- **Priority:** P0 · **Type:** Unit · **Scenario:** AC-10 · **Input:** `max_distance_miles` = 1, then 100. · **Expected:** both accepted.

### TC-RS-023: max_distance_miles out of range — 0 reject, 101 reject
- **Priority:** P0 · **Type:** Unit · **Scenario:** AC-10 · **Input:** 0, then 101.
- **Expected:** throws `{422, INVALID_SETTINGS, field:'max_distance_miles'}` for each; nothing returned.

### TC-RS-024: overlap_minutes boundaries — 0 ok, 240 ok / -1 reject, 241 reject
- **Priority:** P0 · **Type:** Unit · **Scenario:** AC-10 · **Expected:** 0 & 240 accept; -1 & 241 → `field:'overlap_minutes'`.

### TC-RS-025: min_buffer_minutes boundaries — 0 ok, 240 ok / -1 reject, 241 reject
- **Priority:** P0 · **Type:** Unit · **Scenario:** AC-10 · **Expected:** 0 & 240 accept; -1 & 241 → `field:'min_buffer_minutes'`.

### TC-RS-026: horizon_days boundaries — 1 ok, 14 ok / 0 reject, 15 reject
- **Priority:** P0 · **Type:** Unit · **Scenario:** AC-10 · **Expected:** 1 & 14 accept; 0 & 15 → `field:'horizon_days'`.

### TC-RS-027: recommendations_shown boundaries — 1 ok, 10 ok / 0 reject, 11 reject
- **Priority:** P0 · **Type:** Unit · **Scenario:** AC-10 · **Expected:** 1 & 10 accept; 0 & 11 → `field:'recommendations_shown'`.

### TC-RS-028: non-integer rejected (float)
- **Priority:** P1 · **Type:** Unit · **Scenario:** §validate / Граничные случаи #3 · **Input:** `overlap_minutes: 30.5` (in-range but non-integer).
- **Expected:** reject `{422, INVALID_SETTINGS, field:'overlap_minutes'}` (range pass ≠ integer pass).

### TC-RS-029: non-numeric rejected (`"abc"`, `NaN`)
- **Priority:** P1 · **Type:** Unit · **Scenario:** §validate · **Input:** `max_distance_miles: "abc"`; separately `horizon_days: NaN`.
- **Expected:** reject with the matching `field`.

### TC-RS-030: missing field rejected
- **Priority:** P1 · **Type:** Unit · **Scenario:** AC-10 ("missing values rejected") / PUT replaces all 5 · **Input:** body omits `recommendations_shown`.
- **Expected:** reject `{422, INVALID_SETTINGS, field:'recommendations_shown'}`.

### TC-RS-031: all-or-nothing — one bad field, nothing returned/saved
- **Priority:** P0 · **Type:** Unit · **Scenario:** Граничные случаи #3 / RS-R5 · **Input:** 4 valid + `horizon_days: 0`.
- **Expected:** throws (no object returned); validate runs fully before any side effect — assert `queries.upsert` is NOT reached when wired through `save` (covered also in TC-RS-046).

### TC-RS-032: unknown keys stripped (not persisted)
- **Priority:** P1 · **Type:** Unit · **Scenario:** Граничные случаи #4 / §validate · **Input:** 5 valid keys + `company_id`, `top_n`, `evil: 1`.
- **Expected:** returns only the 5 known keys; `company_id`/`top_n`/`evil` absent from the validated result (never reach `config`).

### TC-RS-033: custom picker value out of range rejected (no bypass)
- **Priority:** P1 · **Type:** Unit · **Scenario:** AC-11 / Граничные случаи #5 · **Input:** `overlap_minutes: 300` (a "custom" value).
- **Expected:** reject `{422, field:'overlap_minutes'}` — custom path obeys 0–240 exactly like presets.

---

## 4. Queries — company-scoping (`getByCompany` / `upsert`)

### TC-RS-040: `getByCompany` filters by company_id; selects config
- **Priority:** P1 · **Type:** Unit · **Scenario:** §Безопасность / RS-R1 · **Mocks:** `db.query` → row.
- **Expected:** SQL matches `WHERE company_id = $1`; bound param `[0] === COMPANY`; reads `config`/`updated_at`. (Mirrors `technicianBaseLocationQueries` `ensureSchema` replay then SELECT.)

### TC-RS-041: `upsert` binds company_id first, ON CONFLICT (company_id)
- **Priority:** P1 · **Type:** Unit · **Scenario:** Сценарий 2 / §storage · **Mocks:** `db.query` → returning row.
- **Expected:** `INSERT INTO slot_engine_settings`; first bound param === COMPANY; SQL matches `ON CONFLICT (company_id) DO UPDATE`; `config` written as jsonb; `updated_at` bumped (trigger or `NOW()`).

---

## 5. Routes — `GET` / `PUT /api/settings/slot-engine-settings`

> Harness: `appWith({ permissions, companyId })` injecting `req.companyFilter` (per `technicianBaseLocations.test.js`); mount `slotEngineSettings` router at `/`. Service may be real over mocked `db.query`, or `svc` mocked — assert the chosen seam.

### TC-RS-042: 401 without auth context
- **Priority:** P0 · **Type:** Integration · **Scenario:** AC-8 / §security · **Setup:** no `req.user` / unauthenticated chain.
- **Expected:** GET and PUT → 401. (Asserts the mount `authenticate` gate; in the unit app, model "no user" → the auth middleware rejects.)

### TC-RS-043: 403 without `tenant.company.manage`
- **Priority:** P0 · **Type:** Integration · **Scenario:** AC-8 · **Setup:** `permissions: []`.
- **Expected:** GET → 403; PUT → 403. (Direct analog of the sibling's "403 without permission".)

### TC-RS-044: GET no row → defaults
- **Priority:** P0 · **Type:** Integration · **Scenario:** Сценарий 1 / AC-3 · **Mocks:** `db.query` → `{ rows: [] }`; `permissions:['tenant.company.manage']`.
- **Expected:** 200 `{ ok:true, data: {10,0,15,3,3} }`; no row created (GET is read-only).

### TC-RS-045: GET row → saved values
- **Priority:** P0 · **Type:** Integration · **Scenario:** Сценарий 2 (reload) · **Mocks:** row `config` = custom 5.
- **Expected:** 200 `{ ok:true, data: <those 5> }`.

### TC-RS-046: PUT valid → upsert + returns saved
- **Priority:** P0 · **Type:** Integration · **Scenario:** Сценарий 2 / AC-7 · **Input body:** `{15,0,30,5,5}`; **Mocks:** upsert returns the saved config.
- **Expected:** 200 `{ ok:true, data: {15,0,30,5,5} }`; `db.query` shows an INSERT…ON CONFLICT was issued with `config` carrying the 5 values.

### TC-RS-047: PUT invalid → 422, nothing saved
- **Priority:** P0 · **Type:** Integration · **Scenario:** Граничные случаи #3 / AC-10 · **Input body:** `max_distance_miles: 250` (rest valid).
- **Expected:** 422 `{ ok:false, error:{ code:'INVALID_SETTINGS', field:'max_distance_miles', message } }`; **no** `INSERT INTO slot_engine_settings` call recorded (validate before upsert).

### TC-RS-048: company_id ONLY from req.companyFilter (poison ignored)
- **Priority:** P0 · **Type:** Integration · **Scenario:** AC-9 / §security · **Setup:** `companyFilter.company_id = COMPANY_A`; also set `req.companyId = COMPANY_B` and PUT body includes `company_id: COMPANY_B`.
- **Expected:** the upsert's bound company param === COMPANY_A; neither the poisoned `req.companyId` nor body `company_id` is used. (Mirrors the slotEngineProxy isolation-poisoning pattern.)

### TC-RS-049: cross-tenant isolation — B cannot read A's row
- **Priority:** P0 · **Type:** Integration · **Scenario:** AC-9 / §security · **Setup:** caller `companyId: COMPANY_B`; GET.
- **Expected:** the SELECT is scoped with `[0] === COMPANY_B` (so A's row is never returned to B). PUT analog: write scoped to B only. No `:id` path exists → no direct-ID cross-tenant surface (documented; no test needed for a route that doesn't exist).

### TC-RS-050: GET hard DB error → 500
- **Priority:** P2 · **Type:** Integration · **Scenario:** Обработка ошибок #2 · **Mocks:** `db.query` reject (so `get` throws).
- **Expected:** 500 `{ ok:false, error:{ code:'INTERNAL'|... } }` (GET uses `get`, not `resolve`).

---

## 6. Integration — `slotEngineService.getRecommendations` consumes resolved settings

> See **Test-infra note** above for the `jest.mock(slotEngineSettingsService)` seam (mock `resolve`, keep real `buildConfigOverride` via `requireActual`). All cases mock `global.fetch` 200 with `{ recommendations: [] }` and assert on `JSON.parse(global.fetch.mock.calls[0][1].body)`.

### TC-RS-051: config_override equals buildConfigOverride(resolved)
- **Priority:** P0 · **Type:** Integration · **Scenario:** Сценарий 3 / AC-4 · **Setup:** `resolve` → `{20,30,45,7,5}`; `new_job:{lat,lng}`.
- **Expected:** `body.config_override` deep-equals `buildConfigOverride({20,30,45,7,5})` — i.e. `geography.max_distance_from_existing_job_miles===20`, both radii ===20, `overlap===30`, `feasibility===45`, `planning.horizon_days===7`, `ranking.top_n===5`, `allow_empty_day_candidates===true`, `max_day_utilization===0.95`. **Guards removal of the hardcoded `{allow_empty_day_candidates:true, max_distance_from_base_if_empty_day_miles:40}` literal.**

### TC-RS-052: date window uses settings.horizon_days (replaces HORIZON_DAYS=2)
- **Priority:** P0 · **Type:** Integration · **Scenario:** AC-5 / Сценарий 3 step 2 · **Setup:** `resolve` → `horizon_days:7`; `new_job` has **no** `latest_allowed_date`.
- **Expected:** `body.new_request.latest_allowed_date === addDaysLocal(today, 7)` (today + 7), **not** today+2. Assert against the service's own `addDaysLocal`/today derivation. **Guards removal of the module constant `HORIZON_DAYS=2`.**

### TC-RS-053: explicit latest_allowed_date wins over horizon
- **Priority:** P2 · **Type:** Integration · **Scenario:** §slotEngineService edits (`newJob.latest_allowed_date || addDaysLocal(...)`) · **Setup:** `resolve` → `horizon_days:7`; `new_job.latest_allowed_date = '2026-07-01'`.
- **Expected:** `body.new_request.latest_allowed_date === '2026-07-01'` (caller override precedes the horizon-derived default).

### TC-RS-054: resolve DB-fault path still recommends (no engine regression)
- **Priority:** P1 · **Type:** Integration · **Scenario:** Обработка ошибок #1 / RS-R2 / §protected safe-failure · **Setup:** `resolve.mockResolvedValue(DEFAULTS)` (simulating its internal degrade — `resolve` never throws); fetch 200.
- **Expected:** `body.config_override` deep-equals `buildConfigOverride(DEFAULTS)`; `body.new_request.latest_allowed_date === addDaysLocal(today, 3)`; the call proceeds normally (settings fault never propagates to a thrown recommendation). Existing engine-fault safe-failure (`engine_status:'unavailable'`, `recommendations:[]`) remains covered by `slotEngineProxy.test.js` and must not regress.

---

## 7. Migration 128 — `slot_engine_settings` (case specs)

> No live-DB harness in this repo; these are verified by (a) reading `backend/db/migrations/128_create_slot_engine_settings.sql` and (b) a `ensureSchema()` replay smoke against mocked `db.query` (the SQL string is passed to `db.query`, mirroring `technicianBaseLocationQueries.ensureSchema`). Assertions are structural string/shape checks.

### TC-RS-060: table created with company_id PK + FK cascade
- **Priority:** P0 · **Type:** Migration (structural) · **Scenario:** AC-1 / RS-R1
- **Expected:** `CREATE TABLE ... slot_engine_settings` with `company_id UUID PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE`. (PK = FK; one row per company.)

### TC-RS-061: config jsonb NOT NULL + timestamps
- **Priority:** P0 · **Type:** Migration (structural) · **Scenario:** AC-1/AC-2
- **Expected:** `config JSONB NOT NULL`; `created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`; `updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`. The 2 fixed values are NOT columns (injected at build time).

### TC-RS-062: updated_at trigger wired
- **Priority:** P1 · **Type:** Migration (structural) · **Scenario:** Сценарий 2 (`updated_at` bumped) / §storage
- **Expected:** `CREATE TRIGGER trg_slot_engine_settings_updated_at BEFORE UPDATE ... EXECUTE FUNCTION update_updated_at_column()`. (Function pre-exists from `010_create_companies.sql`; reused, not redefined.)

### TC-RS-063: idempotent (IF NOT EXISTS) — safe replay
- **Priority:** P1 · **Type:** Migration (structural) · **Scenario:** §storage `ensureSchema` replays 128 on every query · **Expected:** `CREATE TABLE IF NOT EXISTS`; trigger creation guarded so a second `ensureSchema()` run does not error (e.g. `DROP TRIGGER IF EXISTS` before `CREATE TRIGGER`, or `DO $$ ... IF NOT EXISTS`). Replaying the file twice must not throw.

### TC-RS-064: FK cascade deletes settings with company
- **Priority:** P2 · **Type:** Migration (structural) · **Scenario:** AC-1 (`ON DELETE CASCADE`)
- **Expected:** deleting a `companies` row removes its `slot_engine_settings` row (asserted via the `ON DELETE CASCADE` clause; no orphan rows). Highest existing migration = 127, so 128 is the correct next number (no collision).

---

## 8. Frontend — Manual checklist + `npm run build` gate

> No RTL harness. Each item is a manual pass on Settings → Technicians (`TechnicianPhotosPage.tsx`) with `RecommendationSettings.tsx` mounted under `<CompanyBaseAddress>`. **Pre-req:** logged in with `tenant.company.manage`. **Verify build:** `npm run build` (tsc -b, strict — `noUnusedLocals`) is **green** (per memory: build, not just `tsc --noEmit`).

### TC-RS-070: block renders with 5 controls (and only 5)
- **Priority:** P0 · **Scenario:** AC-12 / Сценарий 1 · **Steps:** open Settings → Technicians.
- **Expected:** "Recommendation settings" block (header `.blanc-eyebrow`, no `<hr>`) under base-address; exactly 5 controls: Max distance (mi), Allow overlapping arrival windows, Min buffer between jobs, Planning horizon (days), Recommendations shown. The 2 fixed values are NOT shown.

### TC-RS-071: first-run shows defaults 10 / 0 / 15 / 3 / 3
- **Priority:** P0 · **Scenario:** Сценарий 1 / AC-3 · **Pre:** company with no row · **Expected:** fields populated 10 / 0 / 15 / 3 / 3; Network shows `GET /api/settings/slot-engine-settings` → `data:{10,0,15,3,3}`; no row created.

### TC-RS-072: minute-pickers = {0 / 30 / 60 / Custom}; Custom reveals input
- **Priority:** P1 · **Scenario:** §Frontend states / AC-11 · **Steps:** inspect Allow-overlap & Min-buffer pickers; click Custom.
- **Expected:** segmented presets 0/30/60/Custom; selecting Custom reveals a number input; a server value not in {0,30,60} (e.g. 45) pre-selects Custom showing 45.

### TC-RS-073: Save disabled until changed; "Saving…" in flight
- **Priority:** P1 · **Scenario:** §Save button / Сценарий 2 · **Steps:** load → observe Save disabled; change a field → Save enables; click → label "Saving…", disabled; on complete re-enables/disables per dirty.
- **Expected:** dirty-gated Save; in-flight disabled "Saving…".

### TC-RS-074: save persists + success toast + reload reflects
- **Priority:** P0 · **Scenario:** Сценарий 2 / AC-7 · **Steps:** change Max distance 10→15, Recommendations shown 3→5, Save.
- **Expected:** `PUT` with all 5 keys; toast "Recommendation settings saved"; reload shows 15…5.

### TC-RS-075: out-of-range → inline hint + server 422 toast, nothing saved
- **Priority:** P0 · **Scenario:** Граничные случаи #3 / AC-10 / §toasts · **Steps:** type Max distance 250 (or bypass client to force server) → Save.
- **Expected:** inline range hint ("must be between 1 and 100"); on server reject, 422 toast surfacing `field`+`message`; no persisted change (reload shows prior value).

### TC-RS-076: Custom picker out-of-range rejected (no bypass)
- **Priority:** P2 · **Scenario:** AC-11 / Граничные случаи #5 · **Steps:** Allow-overlap → Custom → 300 → Save.
- **Expected:** rejected like any 0–240 violation (client hint + server 422); not saved.

### TC-RS-077: loading state usable; load failure falls back to DEFAULTS
- **Priority:** P2 · **Scenario:** §Loading state / Обработка ошибок #2 · **Steps:** simulate slow/failed GET (throttle / 500).
- **Expected:** controls disabled/skeleton while pending; on failure, form falls back to local DEFAULTS mirror (10/0/15/3/3) and stays editable; non-blocking error toast.

### TC-RS-078: saved change reflected in next recommendation fetch
- **Priority:** P1 · **Scenario:** Сценарий 3 / AC-4/AC-5 · **Steps:** raise Max distance + horizon, Save; trigger a new-job slot recommendation.
- **Expected:** next fetch reflects the change (wider radius surfaces farther techs; more days in window; `top_n` caps cards) — no engine redeploy, no cache bust.

### TC-RS-079: reset-to-defaults via saving defaults
- **Priority:** P3 · **Scenario:** Сценарий 4 · **Steps:** from a non-default row, restore 10/0/15/3/3, Save.
- **Expected:** row config equals DEFAULTS; recommendations behave as untouched first-run (no separate DELETE/reset route).

### TC-RS-080: English copy + Albusto tokens (design canon)
- **Priority:** P2 · **Scenario:** AC-12 / §Frontend copy · **Expected:** all labels/helpers/toasts English; uses `--blanc-*` tokens; `.blanc-eyebrow` header; no horizontal separators; no user-facing "Blanc"; helper texts match spec (e.g. Max-distance helper notes it bounds both base + nearest-job radii).

### TC-RS-081: `npm run build` green (strict gate)
- **Priority:** P0 · **Scenario:** build gate (memory: prod Docker build is stricter) · **Steps:** `npm run build` in `frontend/`.
- **Expected:** tsc -b passes with no errors (incl. `noUnusedLocals`); new files `RecommendationSettings.tsx` + `slotEngineSettingsApi.ts` typecheck; `SlotEngineSettings` interface + DEFAULTS/ranges export resolve.

---

## Traceability (AC → cases)

| AC | Cases |
|----|-------|
| AC-1 (table/PK/FK) | TC-RS-060, 061, 064 |
| AC-2 (fixed values always; config jsonb) | TC-RS-004, 005, 061 |
| AC-3 (defaults no-row) | TC-RS-001, 010, 044, 071 |
| AC-4 (hardcode removed; mapping) | TC-RS-002, 003, 051, 078 |
| AC-5 (horizon drives window) | TC-RS-052, 053, 054, 078 |
| AC-6 (no engine change) | covered by integration asserting only `config_override` body (TC-RS-051) — no engine file touched |
| AC-7 (GET/PUT upsert) | TC-RS-044..047, 074 |
| AC-8 (RBAC) | TC-RS-042, 043 |
| AC-9 (company_id from companyFilter only; isolation) | TC-RS-048, 049 |
| AC-10 (validation ranges/integer/missing) | TC-RS-022..031, 047, 075 |
| AC-11 (picker custom no-bypass) | TC-RS-033, 072, 076 |
| AC-12 (UI on Tech page, English, tokens, canon) | TC-RS-070, 072, 080, 081 |
