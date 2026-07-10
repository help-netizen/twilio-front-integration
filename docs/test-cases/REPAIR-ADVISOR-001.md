# REPAIR-ADVISOR-001 — Test Cases

Derived from `Docs/specs/REPAIR-ADVISOR-001.md` + the FR/AC/UC/E-cases in `Docs/requirements.md › REPAIR-ADVISOR-001` and `Docs/architecture.md › REPAIR-ADVISOR-001`. Covers the outbound RAG client (parse + transport), the `kbDiagnosticsService` orchestrator (`buildQuestion`, `formatNote`, idempotency, `runForJob`), the `job.created` emit sites + `kb-diagnostics` subscriber offload, the migration-161 seed/gate, and the mandatory tenant-isolation contract.

**Feature = backend-only, best-effort.** Marketplace app `ai-repair-advisor`; on human-path job creation (`createDirectJob`, `convertLead`) with the app connected → `job.created` → `kb-diagnostics` subscriber → `setImmediate(runForJob)` → `ragClient.ask` → append **one** 3-section diagnostic note. Any failure ⇒ no note, logged, job untouched.

**Run (backend Jest, from the worktree):**
```
npx jest --runTestsByPath tests/<file>.test.js --testPathIgnorePatterns "/node_modules/"
```
> ⚠️ **Worktree gotcha (must-know):** the root `package.json` jest config sets `testPathIgnorePatterns: ["/node_modules/", "/\\.claude/worktrees/"]`. A bare `npm test` run **silently skips every test inside this worktree**. New test files here MUST be run with the explicit `--testPathIgnorePatterns "/node_modules/"` override shown above (which replaces the config array and drops the worktree-ignore). This is the established house workaround (see the run header in `tests/googleEmailMarketplace.test.js`).

**Framework/idioms:** Jest 30, CommonJS, tests live in **root `tests/*.test.js`** (there is no `backend/**/__tests__`). External HTTP is mocked at the `axios` seam (`jest.doMock('axios', …)` + `jest.resetModules()` + `require()` after — mirror `tests/zenbookerClient.test.js`). Service collaborators are mocked with `jest.mock('../backend/src/services/…')`; the DB is mocked at `jest.mock('../backend/src/db/connection', () => ({ query: jest.fn() }))`. `ragClient.js` and `kbDiagnosticsService.js` are **new**; they mirror `zenbookerClient.js` (lazy axios singleton + `retryRequest`).

## Coverage
- **Total: 59** — **P0: 23** | **P1: 25** | **P2: 9** | **P3: 2**
- **Unit: 32** | **Integration: 23** | **Manual/E2E: 3** | **Covered-by-existing: 1** (401/403 marketplace lifecycle)
- Mapped to **FR-01…FR-12**, **AC-01…AC-10**, **UC-01…UC-07**, **E-01…E-11**. Traceability table at the end.

**Assumptions for testability** (state these to the Planner/Implementer):
1. `kbDiagnosticsService.js` **exports** `buildQuestion`, `formatNote` (and `runForJob`) so the pure functions are unit-testable directly — same pattern as `rulesEngine.evaluateConditions`/`ruleActions.render` in `tests/rulesEngine.test.js`. If they stay module-private, groups **B** and **C** collapse into black-box assertions through `runForJob` (weaker, still possible).
2. `ragClient.js` reads `RAG_API_URL`/`RAG_TIMEOUT_MS` at **module-eval time** (like `zenbookerClient`'s `getClient()`), so env must be set **before** `require()` and the module re-required per case under `jest.resetModules()`.
3. Lazy `require('./ragClient' | './jobsService' | './marketplaceService')` inside `runForJob` is still intercepted by top-level `jest.mock(...)` (jest hoists the mock over the later `require`).

---

## A. `ragClient.ask` — parse + transport (Unit) — NEW file `tests/ragClient.test.js`

**Mock seam (all A-cases):** `jest.doMock('axios', () => ({ create: jest.fn(() => ({ post })) }))` where `const post = jest.fn()`; `jest.resetModules()`; `const ragClient = require('../backend/src/services/ragClient')` **after** the mock + env set. `afterEach`: `jest.resetModules(); jest.dontMock('axios')` and restore `process.env.RAG_API_URL` / `RAG_TIMEOUT_MS` (mirror the `afterEach` in `tests/zenbookerClient.test.js`).

### TC-RA-001: Blank `RAG_API_URL` → `null`, zero HTTP (inert)
- **Priority:** P0 · **Type:** Unit · **File:** `tests/ragClient.test.js`
- **Scenario:** E-10 / FR-12 config-inert.
- **Setup:** `delete process.env.RAG_API_URL` (or set `''`). axios `create`/`post` spied.
- **Action:** `await ragClient.ask({ question: 'washer wont drain' })`.
- **Expected:** returns `null`; **`axios.create` not called AND `post` not called** (`expect(post).not.toHaveBeenCalled()`). No throw.

### TC-RA-002: Happy path — full envelope → exact normalized object
- **Priority:** P0 · **Type:** Unit · **File:** `tests/ragClient.test.js`
- **Scenario:** FR-05 parse; UC-03 payload.
- **Setup:** `RAG_API_URL='https://rag.test/api'`; `post.mockResolvedValue({ data })` where `data` has top-level `summary:'…'`, `likely_causes:[{cause:'Clogged filter',probability:0.55},{cause:'Failed pump',probability:0.3}]`, and `answer` string embedding a fenced ` ```json {"diagnosis_steps":["Unplug unit",{"step":"Open filter panel","expected":"debris"}],"diagnostic_mode":"Hold Spin+Soil 3s","confidence":0.8,"grounded":true} ``` `.
- **Action:** `ask({ question, filters:{ brand:'LG' } })`.
- **Expected:** returns exactly `{ summary:'…', causes:[{cause:'Clogged filter',likelihood:0.55},{cause:'Failed pump',likelihood:0.3}], steps:[{step:'Unplug unit'},{step:'Open filter panel',expected:'debris'}], diagnosticMode:'Hold Spin+Soil 3s', confidence:0.8, grounded:true }`. Assert `post` called once with `('/ask', { question, filters:{ brand:'LG' } })` (or `filters:{brand:'LG',unitType:undefined}` per shaping).

### TC-RA-003: Fenced block present but no `diagnostic_mode` → `diagnosticMode:null`
- **Priority:** P1 · **Type:** Unit · **File:** `tests/ragClient.test.js`
- **Scenario:** E-04.
- **Setup:** fenced block with `diagnosis_steps` + `confidence` but **no** `diagnostic_mode`/`diagnostic_mode_entry`/`service_mode`; top-level `likely_causes` non-empty.
- **Expected:** object with `diagnosticMode:null`, `causes.length>0`, `steps.length>0` (not empty⇒null because groundable content exists).

### TC-RA-004: Alias `repair_instructions` used instead of `diagnosis_steps` → `steps` populated
- **Priority:** P1 · **Type:** Unit · **File:** `tests/ragClient.test.js`
- **Scenario:** FR-05 alias.
- **Setup:** fenced block has `repair_instructions:["Check hose"]`, no `diagnosis_steps`.
- **Expected:** `steps:[{step:'Check hose'}]`.

### TC-RA-005: Step normalization — string vs object; empty steps dropped
- **Priority:** P1 · **Type:** Unit · **File:** `tests/ragClient.test.js`
- **Scenario:** §3.1 step shaping.
- **Setup:** `diagnosis_steps:['Do X', {step:'Do Y', expected:'Z'}, {instruction:'Do W'}, '', {step:''}]`.
- **Expected:** `steps` = `[{step:'Do X'},{step:'Do Y',expected:'Z'},{step:'Do W'}]` (text pulled from `text|step|instruction`; empty/blank entries removed).

### TC-RA-006: No fence, but a raw `{…}` in answer text → first-`{`/last-`}` fallback extraction
- **Priority:** P1 · **Type:** Unit · **File:** `tests/ragClient.test.js`
- **Scenario:** tolerant parse (§3.1 fallback), E-06 boundary.
- **Setup:** `answer` = `Prefix text {"diagnosis_steps":["Reseat connector"],"diagnostic_mode":"Menu>Test"} trailing`.
- **Expected:** substring first-`{`…last-`}` is `JSON.parse`d → `steps:[{step:'Reseat connector'}]`, `diagnosticMode:'Menu>Test'`.

### TC-RA-007: Totally unparseable body (no fence, no braces, non-JSON) → `null`
- **Priority:** P2 · **Type:** Unit · **File:** `tests/ragClient.test.js`
- **Scenario:** E-06 / AC-05.
- **Setup:** `data.answer='Sorry, I have no information.'`, no top-level `likely_causes`.
- **Expected:** `null`; no throw.

### TC-RA-008: 200 but `causes[]==0 && steps[]==0 && !diagnosticMode` → `null` (empty⇒null)
- **Priority:** P0 · **Type:** Unit · **File:** `tests/ragClient.test.js`
- **Scenario:** E-03.
- **Setup:** `likely_causes:[]`, fenced block with `diagnosis_steps:[]` and no diagnostic mode.
- **Expected:** `null` even on HTTP 200.

### TC-RA-009: Summary present but no causes/steps/diag-mode → `null` (summary alone insufficient)
- **Priority:** P1 · **Type:** Unit · **File:** `tests/ragClient.test.js`
- **Scenario:** §3.1 empty⇒null (summary exclusion).
- **Setup:** top-level `summary:'Might be the pump.'`; empty causes/steps; no diag mode.
- **Expected:** `null`.

### TC-RA-010: Timeout → `null`, single attempt
- **Priority:** P0 · **Type:** Unit · **File:** `tests/ragClient.test.js`
- **Scenario:** E-05 / UC-06 / AC-04.
- **Setup:** `post.mockRejectedValue(Object.assign(new Error('timeout'), { code:'ECONNABORTED' }))`.
- **Expected:** returns `null`; **`post` called exactly once** (`retryRequest(fn,1)` = single attempt); `console.warn('[RAG] …')` logged (spy `console.warn`); no throw.

### TC-RA-011: 5xx (502) → `null`; NOT retried under `retryRequest(fn,1)`
- **Priority:** P1 · **Type:** Unit · **File:** `tests/ragClient.test.js`
- **Scenario:** UC-06 / AC-04.
- **Setup:** `post.mockRejectedValue({ response:{ status:502 } })`.
- **Expected:** returns `null`; **`post` called exactly once**.
- **⚠️ DISCREPANCY FLAG:** the task brief says "5xx ⇒ retried per retryRequest then null", but the spec pins `ragClient` to `retryRequest(fn, 1)`, and `retryRequest` (`zenbookerClient.js:540`) loops `for attempt in [0, maxRetries)` → **maxRetries=1 makes exactly one attempt** for *every* error class (5xx retry only happens at `maxRetries ≥ 2`). Pinned to the spec ⇒ single attempt. **Implementer decision needed:** keep `maxRetries=1` (this assertion), or, if 5xx/timeout retries ARE wanted, call `retryRequest(fn, N>1)` — then re-point this case to `post` called `N` times and keep TC-RA-012's 4xx at one call. See "Hard-to-test / open decisions".

### TC-RA-012: 4xx (400/404, non-429) → short-circuit `null`, never retried
- **Priority:** P1 · **Type:** Unit · **File:** `tests/ragClient.test.js`
- **Scenario:** §3.1 4xx short-circuit.
- **Setup:** `post.mockRejectedValue({ response:{ status:400 } })`.
- **Expected:** returns `null`; **`post` called exactly once**; assert the short-circuit holds **even if the impl ever raises `maxRetries`** (4xx throws immediately in `retryRequest`).

### TC-RA-013: 429 is treated as retryable class (not short-circuited)
- **Priority:** P3 · **Type:** Unit · **File:** `tests/ragClient.test.js`
- **Scenario:** `retryRequest` 429 exception (`status !== 429` guard).
- **Setup:** `post.mockRejectedValue({ response:{ status:429 } })`.
- **Expected:** returns `null`; at `maxRetries=1` → one attempt (documents that 429 does NOT short-circuit like other 4xx; observable only if `maxRetries>1`).

### TC-RA-014: Likelihood passthrough — numeric kept, non-numeric/absent → `null`
- **Priority:** P1 · **Type:** Unit · **File:** `tests/ragClient.test.js`
- **Scenario:** FR-05 / §3.1 `likelihood = probability if numeric else null`.
- **Setup:** `likely_causes:[{cause:'A',probability:0.4},{cause:'B',probability:'high'},{cause:'C'},{cause:'',probability:0.9}]`.
- **Expected:** `causes:[{cause:'A',likelihood:0.4},{cause:'B',likelihood:null},{cause:'C',likelihood:null}]` (the empty-`cause` entry is dropped).

### TC-RA-015: Never throws — internal fault path returns `null`
- **Priority:** P2 · **Type:** Unit · **File:** `tests/ragClient.test.js`
- **Scenario:** best-effort (§3.1 "does not throw"), FR-10 defense.
- **Setup:** force an internal fault after the request resolves, e.g. `data.answer` is a non-string (number/object) or `getClient()`/`axios.create` throws.
- **Expected:** returns `null`; no exception escapes `ask`.

### TC-RA-016: Fenced-block `confidence`/`grounded` override top-level on conflict
- **Priority:** P2 · **Type:** Unit · **File:** `tests/ragClient.test.js`
- **Scenario:** §3.1 "fenced-block wins on conflict".
- **Setup:** top-level `confidence:0.2, grounded:false`; fenced block `confidence:0.9, grounded:true` + non-empty causes.
- **Expected:** `confidence:0.9, grounded:true`.

> **Group A = 16 unit cases, all in the one NEW file `tests/ragClient.test.js`.**

---

## B. `buildQuestion(job)` (Unit) — NEW file `tests/kbDiagnosticsService.test.js`

**Mock seam:** pure function — **no mocks**. `const { buildQuestion } = require('../backend/src/services/kbDiagnosticsService')` (per Assumption 1). Job objects are plain fixtures shaped like `rowToJob` output (`description`, `comments`, `job_type`, `service_name`, `metadata`).

### TC-RA-020: Description is the primary problem text
- **Priority:** P0 · **Type:** Unit · **Scenario:** FR-06.
- **Input:** `{ description:'Fridge not cooling', comments:'call before', job_type:'Refrigerator repair' }`.
- **Expected:** `question` contains `Fridge not cooling` and `Service type: Refrigerator repair`; does NOT use `comments` (description present).

### TC-RA-021: Empty description → falls back to `comments`
- **Priority:** P1 · **Type:** Unit · **Scenario:** FR-06 / UC-07.
- **Input:** `{ description:'   ', comments:'leaking from bottom', service_name:'Dishwasher' }`.
- **Expected:** `question` built from `leaking from bottom` + `Service type: Dishwasher`.

### TC-RA-022: Both problem sources empty → `''` (skip) unless service present
- **Priority:** P1 · **Type:** Unit · **Scenario:** UC-07 / §3.4 step-4 stop.
- **Input A:** `{ description:'', comments:'', job_type:null, service_name:null, metadata:{} }` → **Expected:** returns `''` (signals `runForJob` step-4 STOP).
- **Input B:** `{ description:'', comments:'', job_type:'Oven repair' }` → **Expected:** non-empty `question` formed from the service context alone (thin-description path).

### TC-RA-023: `job_type` / `service_name` folded in; `job_type` wins
- **Priority:** P1 · **Type:** Unit · **Scenario:** FR-06.
- **Input:** `{ description:'noise', job_type:'Washer repair', service_name:'Appliance' }`.
- **Expected:** `Service type: Washer repair` (job_type precedence over service_name).

### TC-RA-024: `filters.brand` / `filters.unitType` from metadata
- **Priority:** P1 · **Type:** Unit · **Scenario:** E-08 / FR-06.
- **Input:** `{ description:'x', metadata:{ brand:'Samsung', unit_type:'Front-load washer' } }`.
- **Expected:** `filters === { brand:'Samsung', unitType:'Front-load washer' }`. Also assert the alias order: `make` used when `brand` absent; `appliance`/`unitType` used when `unit_type` absent (first non-empty wins).

### TC-RA-025: Metadata key match is case-insensitive
- **Priority:** P1 · **Type:** Unit · **Scenario:** E-08 (lowercase/trim normalization).
- **Input:** `{ description:'x', metadata:{ 'Brand':'LG', ' UNIT_TYPE ':'Dryer' } }`.
- **Expected:** `filters === { brand:'LG', unitType:'Dryer' }`.

### TC-RA-026: `model` folded into question TEXT, never into `filters`
- **Priority:** P1 · **Type:** Unit · **Scenario:** E-08 / §3.4.
- **Input:** `{ description:'x', metadata:{ model:'WF45' } }`.
- **Expected:** `question` contains `Model: WF45.`; `filters` has **no** `model` key (and no `brand`/`unitType`).

### TC-RA-027: No brand/unit metadata → `filters === {}` (no empty-string keys)
- **Priority:** P0 · **Type:** Unit · **Scenario:** E-09 / FR-06.
- **Input:** `{ description:'x', metadata:{} }` (and separately `metadata:null`).
- **Expected:** `filters` is `{}` — never `{ brand:'', unitType:'' }`; RAG is then called without brand/unit filters.

---

## C. `formatNote(normalized)` (Unit) — NEW file `tests/kbDiagnosticsService.test.js`

**Mock seam:** pure — **no mocks**. `const { formatNote } = require('../backend/src/services/kbDiagnosticsService')`. Input = the normalized object from §3.1. Output = markdown `string` or `null`.
> **Author note:** the literal `author:'AI Repair Advisor'` string is applied by `addNote(…, 'AI Repair Advisor', 'system')`, **not** by `formatNote`. `formatNote` returns only the note **text**; the exact author is asserted in **TC-RA-052** (the `addNote` call).

### TC-RA-030: Full 3-section render (title + summary + causes + steps + diagnostic mode + disclaimer)
- **Priority:** P0 · **Type:** Unit · **Scenario:** FR-07 / AC-09.
- **Input:** object with `summary`, 3 `causes` (likelihoods 0.55/0.30/0.15), 4 `steps` (one with `expected`), `diagnosticMode` non-empty.
- **Expected:** string contains, in order: `**AI Repair Advisor — diagnostic starting point**`, the summary line, `**Probable causes**` with bullets `- <cause> — ~55% likely` etc., `**Diagnosis steps**` numbered `1. … 2. … (expected: …)`, `**Diagnostic mode**` + entry text, footer `_AI-generated from service-manual knowledge base — verify on-site before acting._`.

### TC-RA-031: 2-section variant — `diagnosticMode:null` omits the header entirely
- **Priority:** P0 · **Type:** Unit · **Scenario:** E-04 / AC-09.
- **Input:** causes + steps present, `diagnosticMode:null`.
- **Expected:** string has Probable causes + Diagnosis steps + disclaimer, and **contains no `Diagnostic mode` substring** (no empty section, no placeholder).

### TC-RA-032: Summary optional — no `summary` → no summary line, title still present
- **Priority:** P1 · **Type:** Unit · **Scenario:** §3.5.
- **Input:** `summary:null`, causes present.
- **Expected:** title line present; the line between title and `**Probable causes**` is absent.

### TC-RA-033: Likelihood rendering — ≤1 ×100, >1 as-is, null/NaN omits suffix
- **Priority:** P1 · **Type:** Unit · **Scenario:** §3.5 pct rule.
- **Input:** causes with `likelihood` = `0.55` → `~55% likely`; `70` (>1) → `~70% likely`; `null` → bare `- <cause>` (no `— ~…% likely`).
- **Expected:** each bullet rendered per rule; `Math.round` applied.

### TC-RA-034: Step `expected` optional
- **Priority:** P1 · **Type:** Unit · **Scenario:** §3.5.
- **Input:** steps `[{step:'A'},{step:'B',expected:'debris'}]`.
- **Expected:** `1. A` (no suffix) and `2. B (expected: debris)`.

### TC-RA-035: No Stage-2 sections ever (parts / dispatcher-questions / safety)
- **Priority:** P2 · **Type:** Unit · **Scenario:** AC-09 / Non-goals.
- **Input:** object that additionally carries `parts:[…]`, `safety:[…]` (should be ignored).
- **Expected:** rendered note contains none of "Parts", "Safety", "Questions" headers — only the ≤3 defined sections + disclaimer.

### TC-RA-036: Defensive `null` — if no section renders, return `null`
- **Priority:** P2 · **Type:** Unit · **Scenario:** §3.5 defensive.
- **Input:** an object where causes/steps/diagnosticMode are all empty/falsy (shouldn't occur post-`ask`, but defense-in-depth).
- **Expected:** returns `null` (so `runForJob` step 6 STOPs — no title/disclaimer-only note).

---

## D. Idempotency guard (Unit, via `runForJob`) — file `tests/kbDiagnosticsService.test.js`

**Mock seam:** group-E mocks (below). Focus: step-3 guard.

### TC-RA-040: Existing advisor note → early STOP, no RAG, no addNote
- **Priority:** P0 · **Type:** Unit · **Scenario:** FR-09 / E-02 / AC-07.
- **Setup:** `isAppConnected→true`; `getJobById` returns a job whose `notes:[{ author:'AI Repair Advisor', text:'…' }, { author:'Someone' }]`.
- **Action:** `await runForJob({ jobId, companyId })`.
- **Expected:** `ragClient.ask` **not called**; `jobsService.addNote` **not called** (one advisor note per job, ever). Also cover `notes:[null, {author:'AI Repair Advisor'}]` (the `n && n.author` null-guard).

---

## E. `kbDiagnosticsService.runForJob` (Integration) — file `tests/kbDiagnosticsService.test.js`

**Mock seams (all E-cases):**
```
jest.mock('../backend/src/services/ragClient',        () => ({ ask: jest.fn() }));
jest.mock('../backend/src/services/jobsService',       () => ({ getJobById: jest.fn(), addNote: jest.fn() }));
jest.mock('../backend/src/services/marketplaceService',() => ({ isAppConnected: jest.fn(), AI_REPAIR_ADVISOR_APP_KEY:'ai-repair-advisor' }));
```
`const { runForJob } = require('../backend/src/services/kbDiagnosticsService')`. `beforeEach` resets the three mocks. `COMPANY_A = '00000000-0000-0000-0000-00000000000a'`.

### TC-RA-050: App NOT connected → STOP @ step 1 (no read, no RAG, no note)
- **Priority:** P0 · **Type:** Integration · **Scenario:** UC-05 / AC-03 / FR-02.
- **Setup:** `isAppConnected.mockResolvedValue(false)`.
- **Expected:** `getJobById` **not called**, `ragClient.ask` **not called**, `addNote` **not called**. `isAppConnected` called with `(COMPANY_A, 'ai-repair-advisor')`.

### TC-RA-051: Connected but `getJobById` → `null` (deleted/foreign) → no RAG, no note, no throw
- **Priority:** P0 · **Type:** Integration · **Scenario:** E-07 / AC-08.
- **Setup:** `isAppConnected→true`; `getJobById.mockResolvedValue(null)`.
- **Expected:** `ragClient.ask` not called; `addNote` not called; `runForJob` resolves (no throw).

### TC-RA-052: Connected + job + `ask`→object → `addNote` called ONCE with exact args
- **Priority:** P0 · **Type:** Integration · **Scenario:** UC-03 / FR-07 / FR-08 / AC-01.
- **Setup:** `isAppConnected→true`; `getJobById→{ id:jobId, description:'washer wont drain', notes:[] }`; `ragClient.ask.mockResolvedValue({ causes:[…], steps:[…], diagnosticMode:'…', summary:'…' })`.
- **Expected:** `addNote` called **exactly once** with `(jobId, <string>, [], 'AI Repair Advisor', 'system')` — assert the 4th arg is the literal author, 5th is `'system'`, 3rd is `[]`; 2nd arg is a non-empty markdown string (the formatted note).

### TC-RA-053: Connected + `ask`→`null` → no note
- **Priority:** P0 · **Type:** Integration · **Scenario:** UC-06 / E-03 / E-10 / AC-04.
- **Setup:** `isAppConnected→true`; `getJobById→{…, notes:[] }`; `ragClient.ask.mockResolvedValue(null)`.
- **Expected:** `addNote` not called; resolves.

### TC-RA-054: `ask` throws → swallowed, no note, no re-throw
- **Priority:** P0 · **Type:** Integration · **Scenario:** FR-10 / AC-04 (defense-in-depth).
- **Setup:** `ragClient.ask.mockRejectedValue(new Error('boom'))`; spy `console.warn`.
- **Expected:** `runForJob` resolves (does not reject); `addNote` not called; `console.warn('[kb-diagnostics] …')` logged.

### TC-RA-055: Company scoping — reads/gate use the event's `companyId`
- **Priority:** P0 · **Type:** Integration · **Scenario:** FR-11 / AC-08 / §5.
- **Setup:** `runForJob({ jobId:'J1', companyId:COMPANY_A })`, connected + job + good payload.
- **Expected:** `isAppConnected` called with `COMPANY_A`; `getJobById` called with `('J1', COMPANY_A)` (company-scoped); no other companyId reaches any collaborator.

### TC-RA-056: Empty question → STOP @ step 4 (no RAG, no note)
- **Priority:** P1 · **Type:** Integration · **Scenario:** UC-07 / §3.3 step 4.
- **Setup:** connected; `getJobById→{ description:'', comments:'', job_type:null, service_name:null, metadata:{}, notes:[] }` (so `buildQuestion` returns `''`).
- **Expected:** `ragClient.ask` not called; `addNote` not called.

### TC-RA-057: `formatNote` → `null` → STOP @ step 6 (no note)
- **Priority:** P1 · **Type:** Integration · **Scenario:** AC-05 / §3.3 step 6.
- **Setup:** connected + job; `ragClient.ask` returns an object but `formatNote` yields `null` (drive via a payload that formats to nothing, or spy `formatNote` to return `null`).
- **Expected:** `addNote` not called; no throw.

### TC-RA-058: `addNote` throws (DB) → outer guard swallows, no re-throw
- **Priority:** P1 · **Type:** Integration · **Scenario:** FR-10 / §4 (`addNote` throws row).
- **Setup:** connected + job + good payload; `jobsService.addNote.mockRejectedValue(new Error('db down'))`; spy `console.warn`.
- **Expected:** `runForJob` resolves; error logged; nothing propagates (job-create already returned success).

### TC-RA-059: Ordered gate — not-connected short-circuits BEFORE `getJobById`
- **Priority:** P1 · **Type:** Integration · **Scenario:** E-01 mid-flight re-check / §3.3 ordering.
- **Setup:** `isAppConnected→false`.
- **Expected:** assert `getJobById` never invoked (proves the gate is step 1 and is re-evaluated at `runForJob` start, honoring a mid-flight disconnect).

---

## F. Event wiring — emit sites + subscriber offload (Integration) — NEW file `tests/repairAdvisorEvents.test.js`

**Emit-site seam:** reuse the `jest.isolateModules` + `jest.doMock` "load the REAL service against mocked deps" idiom from `tests/jobsCreate.test.js` (`loadService`). Add `jest.doMock('../backend/src/services/eventBus', () => ({ emit: jest.fn().mockResolvedValue({}) }))` and run the REAL `createDirectJob` / `convertLead`; spy `eventBus.emit`. (Or **ADD** these two assertions to the existing `tests/jobsCreate.test.js` and `tests/leadsService.convert.test.js` — noted as the lighter-touch alternative.)
**Subscriber seam:** real `eventBus.subscribe`/`emit` with `jest.mock('../backend/src/db/connection', () => ({ query: jest.fn() }))` (mirror `tests/rulesEngine.test.js`), plus `jest.mock('../backend/src/services/kbDiagnosticsService', () => ({ runForJob: jest.fn() }))`; flush the detached dispatch with `await new Promise(r => setImmediate(r))` **twice** (once for eventBus dispatch, once for the subscriber's own `setImmediate`).

### TC-RA-060: `createDirectJob` emits `job.created` ONCE, post-commit, with load-bearing payload
- **Priority:** P0 · **Type:** Integration · **Scenario:** FR-03 / AC-01 / §3.2.
- **Setup:** REAL `createDirectJob` (via `loadService`) with the ZB-failure fallback path so a local job row (`id:42`) is created without external calls (mirror `tests/jobsCreate.test.js` "ZB failure" test); `eventBus.emit` mocked.
- **Expected:** `emit` called **once** with `(COMPANY, 'job.created', expect.objectContaining({ id:42, jobId:42, companyId:COMPANY }), expect.objectContaining({ aggregateType:'job', aggregateId:42 }))`; the create return value/shape is unchanged.

### TC-RA-061: `createDirectJob` success is unaffected when `emit` rejects/throws
- **Priority:** P0 · **Type:** Integration · **Scenario:** FR-10 / §3.2 additive-only.
- **Setup:** `eventBus.emit.mockRejectedValue(new Error('bus down'))` (emit site wraps in `.catch(()=>{})`).
- **Expected:** `createDirectJob` still resolves with the same `{ job_id, … }`; no rejection surfaces; byte-for-byte latency/txn behavior unchanged (no extra awaited DB work in the create path).

### TC-RA-062: `convertLead` emits `job.created` when `localJobCreated===true`
- **Priority:** P0 · **Type:** Integration · **Scenario:** FR-03 / AC-02 / UC-04.
- **Setup:** REAL `convertLead` driven down the branch that creates a new local job (`localJobCreated=true`, `localJobId` set); `eventBus.emit` mocked. (Extend `tests/leadsService.convert.test.js` fixtures.)
- **Expected:** `emit` called **once** with `(companyId, 'job.created', objectContaining({ id:localJobId, jobId:localJobId, companyId }), …)`.

### TC-RA-063: `convertLead` does NOT emit when an existing local job is reused (`localJobCreated===false`)
- **Priority:** P0 · **Type:** Integration · **Scenario:** UC-04 / AC-07 / §3.2 guard.
- **Setup:** REAL `convertLead` down the reuse branch (`localJobCreated=false`).
- **Expected:** `eventBus.emit` **not called** with `'job.created'` (prevents a duplicate advisor note on reuse).

### TC-RA-064: Subscriber matches `'job.created'` only
- **Priority:** P0 · **Type:** Integration · **Scenario:** FR-04 / §3.8.
- **Setup:** register real `eventSubscribers` (which subscribes `kb-diagnostics`); `runForJob` mocked. Emit an **unrelated** type, e.g. `job.status_changed`.
- **Expected:** after setImmediate flushes, `runForJob` **not called** for the unrelated type.

### TC-RA-065: Subscriber returns FAST — schedules `setImmediate(runForJob)`, does not await RAG
- **Priority:** P0 · **Type:** Integration · **Scenario:** FR-04 / architecture §2 (sequential-dispatch offload).
- **Setup:** `runForJob` mocked to return a **never-resolving / long** promise (`() => new Promise(()=>{})`). Emit `job.created` with `payload.id=J1`, `company_id=COMPANY_A`.
- **Expected:** the subscriber `handle` **resolves before** `runForJob` settles (assert the dispatch promise resolves while `runForJob`'s promise is still pending); after a `setImmediate` flush, `runForJob` was invoked once with `{ jobId:'J1', companyId:COMPANY_A }`. This proves the ~30s RAG round-trip is fully detached and never blocks sibling subscribers.
- **How to assert the offload without real RAG:** the mocked `runForJob` (jest.fn) is the seam — check (a) it is invoked only **after** a `setImmediate` tick, not synchronously inside `handle`, and (b) `handle`'s returned promise resolves independently of `runForJob`'s. Fake timers (`jest.useFakeTimers()`) are an alternative to drive `setImmediate` deterministically.

### TC-RA-066: Subscriber guards missing `jobId`/`companyId` → does not schedule
- **Priority:** P1 · **Type:** Integration · **Scenario:** §3.8 guard.
- **Setup:** emit `job.created` with `payload:{}` (no `id`) and separately `company_id:null`.
- **Expected:** `runForJob` **not called** (early `return`).

### TC-RA-067: Detached `runForJob` rejection is swallowed by call-site `.catch`
- **Priority:** P1 · **Type:** Integration · **Scenario:** architecture §2 / FR-10.
- **Setup:** `runForJob.mockRejectedValue(new Error('x'))`; register a global `unhandledRejection` listener in the test.
- **Expected:** no `unhandledRejection` fires (the `.catch(()=>{})` at the `setImmediate` call site absorbs it).

> **Emit-site cases (060–063) may instead be filed as ADDITIONS to `tests/jobsCreate.test.js` (createDirectJob) and `tests/leadsService.convert.test.js` (convertLead)** — both already load the real services with the exact mock scaffolding needed. Keeping them in `tests/repairAdvisorEvents.test.js` centralizes the feature; either is acceptable.

---

## G. Migration 161 seed + gate (Integration + Manual) — file `tests/repairAdvisorEvents.test.js` (registration) / manual (SQL)

> **House practice:** no existing test **executes** a raw `.sql` migration under Jest — `tests/arConfigMigration.test.js` tests the JS builder (`rulesSeed.buildRulesFromConfig`) with `db.query` mocked, not the SQL file. So migration-161's SQL seed/rollback is **manual/psql smoke** (marked below); the only Jest-observable surface is the `ensureMarketplaceSchema` registration and the runtime gate.

### TC-RA-070: `ensureMarketplaceSchema` registers seed 161 via `readMigration`
- **Priority:** P1 · **Type:** Integration · **File:** `tests/repairAdvisorEvents.test.js`
- **Scenario:** FR-01 / §3.7.
- **Setup:** `jest.mock('../backend/src/db/connection', () => ({ query: jest.fn().mockResolvedValue({ rows:[] }) }))`; spy the module's `readMigration` (or assert on the SQL text passed to `query`).
- **Action:** `await marketplaceQueries.ensureMarketplaceSchema()`.
- **Expected:** a `query(...)` call carries the contents of `161_seed_ai_repair_advisor_marketplace_app.sql` (i.e. `readMigration('161_seed_ai_repair_advisor_marketplace_app.sql')` was invoked), alongside the existing 126/132/145 seed registrations. Idempotent (safe to run twice).

### TC-RA-071: SQL seed inserts the marketplace app row (idempotent) — **MANUAL/psql**
- **Priority:** P2 · **Type:** Manual (integration DB) · **Scenario:** FR-01 / UC-01.
- **Action:** run `161_seed_…sql` against a test DB.
- **Expected:** `marketplace_apps` has one row `app_key='ai-repair-advisor'`, `status='published'`, `provisioning_mode='none'`, `app_type='internal'`, `requires_credential_input:false`, **no `setup_path`** (structural copy of seed 126). Re-running is a no-op (`ON CONFLICT (app_key) DO UPDATE … updated_at=NOW()`).

### TC-RA-072: Rollback removes the app row — **MANUAL/psql**
- **Priority:** P2 · **Type:** Manual (integration DB) · **Scenario:** FR-01.
- **Action:** run `rollback_161_seed_…sql`.
- **Expected:** `DELETE FROM marketplace_apps WHERE app_key='ai-repair-advisor'` removes exactly that row; idempotent, FK-safe (gate-only app, no installations depend structurally).

### TC-RA-073: Tile renders + connect lifecycle — **MANUAL/E2E**
- **Priority:** P3 · **Type:** Manual/E2E · **Scenario:** UC-01 / UC-02 / FR-01.
- **Action:** Settings → Integrations → "AI Repair Advisor" tile (status *Available*) → Connect → Disconnect.
- **Expected:** connect drives `marketplace_installations.status='connected'`; disconnect leaves `connected`; no new route, no FE code (tile renders from the seed).

### TC-RA-074: Gate resolves via the GENERIC install path (not special-cased)
- **Priority:** P1 · **Type:** Integration · **File:** `tests/repairAdvisorEvents.test.js`
- **Scenario:** FR-02 / §3.7.
- **Mock seam:** mirror `tests/googleEmailMarketplace.test.js` — `jest.mock('../backend/src/db/marketplaceQueries', () => ({ getPublishedAppByKey: jest.fn(), findActiveInstallation: jest.fn(), listPublishedAppsWithInstallation: jest.fn() }))`; run the REAL `marketplaceService`.
- **Action:** `isAppConnected(COMPANY_A, 'ai-repair-advisor')`.
- **Expected:** `true` iff `getPublishedAppByKey`→app and `findActiveInstallation`→`{ status:'connected' }`; `false` for `disconnected`/absent. Assert the **generic** path is used (NOT the `google-email` mailbox special-case, NOT the `telephony-twilio` overlay) — `getMailboxStatus`-style overlays are never consulted for this key.

---

## H. Security & tenant isolation (Integration) — file `tests/repairAdvisorEvents.test.js` / `tests/kbDiagnosticsService.test.js`

### TC-RA-080: Tenant isolation — A-connected / B-not → note attaches to A's job only
- **Priority:** P0 · **Type:** Integration · **Scenario:** AC-08 / FR-11 / §5 (MANDATORY isolation test).
- **Setup:** `isAppConnected.mockImplementation((co)=> co===COMPANY_A)`; `getJobById.mockImplementation((id,co)=> co===COMPANY_A ? { id, notes:[], description:'x' } : null)`; `ragClient.ask` → good payload.
- **Action:** `runForJob({ jobId:'JA', companyId:COMPANY_A })` then `runForJob({ jobId:'JB', companyId:COMPANY_B })`.
- **Expected:** for A → `addNote('JA', …)` called once; for B → gate `false` ⇒ `getJobById`/`ask`/`addNote` never called. A connected-A / not-connected-B pair proves no cross-tenant note; `getJobById` for A was scoped by `COMPANY_A`.

### TC-RA-081: `companyId` provenance — subscriber uses `event.company_id`, never client/ambient
- **Priority:** P0 · **Type:** Integration · **Scenario:** FR-11 / §5.
- **Setup:** emit `job.created` with `company_id=COMPANY_A` and a **decoy** `payload.companyId=COMPANY_B` (adversarial); `runForJob` mocked.
- **Expected:** `runForJob` invoked with `companyId=COMPANY_A` (the authoritative `event.company_id`), not the payload decoy — confirming the subscriber reads `event.company_id` and `event.payload.id` only.

### TC-RA-082: 401/403 on connect/disconnect — **covered by existing marketplace tests (no new route)**
- **Priority:** P2 · **Type:** Covered-by-existing · **Scenario:** AC-10 / §5.
- **Note:** REPAIR-ADVISOR-001 adds **no** HTTP route — connect/disconnect reuses `/api/marketplace/*` (`authenticate` + `requirePermission('tenant.integrations.manage')` + `requireCompanyAccess`), already covered (`tests/marketplaceTelephonyOverlay.test.js`, `tests/googleEmailMarketplace.test.js`, F016/F018 suites). No new 401/403 case required; **no regression** expected. Documented for the AC-10 checklist.

### TC-RA-083: AC-06 out-of-scope triggers stay note-free (ZB-sync / scheduler)
- **Priority:** P2 · **Type:** Integration · **Scenario:** AC-06 / E-11 / architecture §2.
- **Setup:** exercise a Zenbooker-webhook-sync job insert path and the scheduler/`agentWorker` insert path (whichever the codebase exposes for jobs created outside `createDirectJob`/`convertLead`); `eventBus.emit` spied.
- **Expected:** neither path emits `job.created` (they don't call the two human create sites) ⇒ no advisor note. Guards against accidental coupling (e.g. a future `AFTER INSERT` trigger).

---

## Traceability (scenario / AC / FR → test IDs)

| Requirement / scenario | Test IDs |
|---|---|
| **FR-01** seed 161 + `ensureMarketplaceSchema` | TC-RA-070, TC-RA-071, TC-RA-072, TC-RA-073 |
| **FR-02** `isAppConnected` gate (generic path) | TC-RA-050, TC-RA-074 |
| **FR-03** `job.created` at both create sites | TC-RA-060, TC-RA-062, TC-RA-063 |
| **FR-04** `kb-diagnostics` subscriber + `setImmediate` offload | TC-RA-064, TC-RA-065, TC-RA-066, TC-RA-067 |
| **FR-05** `ragClient` POST `/ask` + tolerant parse | TC-RA-002…009, TC-RA-014, TC-RA-016 |
| **FR-06** question build + optional filters | TC-RA-020…027 |
| **FR-07** exactly one note, 3 sections, (c) conditional | TC-RA-030, TC-RA-031, TC-RA-052 |
| **FR-08** `addNote(… 'AI Repair Advisor','system')` | TC-RA-052 |
| **FR-09** idempotency | TC-RA-040 |
| **FR-10** best-effort isolation from create | TC-RA-054, TC-RA-058, TC-RA-061, TC-RA-067, TC-RA-015 |
| **FR-11** company scoping | TC-RA-055, TC-RA-080, TC-RA-081 |
| **FR-12** `RAG_API_URL`/`RAG_TIMEOUT_MS`, inert if blank | TC-RA-001 |
| **AC-01** manual create → 1 note | TC-RA-052, TC-RA-060 |
| **AC-02** convertLead → 1 note | TC-RA-062 |
| **AC-03** not connected → no note/no RAG | TC-RA-050 |
| **AC-04** RAG down/timeout/non-2xx → no note, logged, no fail | TC-RA-010, TC-RA-011, TC-RA-053, TC-RA-054, TC-RA-061 |
| **AC-05** thin/unusable → graceful, never malformed | TC-RA-007, TC-RA-022, TC-RA-056, TC-RA-057, TC-RA-036 |
| **AC-06** ZB-sync / scheduler note-free | TC-RA-083 |
| **AC-07** redelivery idempotent | TC-RA-040, TC-RA-063 |
| **AC-08** company isolation | TC-RA-051, TC-RA-055, TC-RA-080, TC-RA-081 |
| **AC-09** 3-section format, diag-mode conditional, no Stage-2 | TC-RA-030, TC-RA-031, TC-RA-033, TC-RA-035 |
| **AC-10** tests: 401/403 + isolation + gating + RAG-down + format | TC-RA-082 (401/403), TC-RA-080, TC-RA-050, TC-RA-010/053, TC-RA-030 |
| **UC-01/02** connect/disconnect | TC-RA-073 |
| **UC-03/04** note appears | TC-RA-052, TC-RA-060, TC-RA-062 |
| **UC-05** not connected | TC-RA-050 |
| **UC-06** RAG down | TC-RA-010, TC-RA-053, TC-RA-054 |
| **UC-07** thin description | TC-RA-021, TC-RA-022, TC-RA-056 |
| **E-01** disconnect mid-flight (re-check) | TC-RA-059 |
| **E-02** redelivery / idempotency | TC-RA-040 |
| **E-03** empty causes+steps → null | TC-RA-008 |
| **E-04** no diagnostic mode → 2 sections | TC-RA-003, TC-RA-031 |
| **E-05** RAG timeout, single attempt | TC-RA-010 |
| **E-06** malformed / non-JSON body | TC-RA-006, TC-RA-007 |
| **E-07** job deleted before run | TC-RA-051 |
| **E-08** brand/model/unit_type in metadata | TC-RA-024, TC-RA-025, TC-RA-026 |
| **E-09** no brand/unit metadata → filters `{}` | TC-RA-027 |
| **E-10** `RAG_API_URL` blank → inert | TC-RA-001 |
| **E-11** out-of-scope create paths | TC-RA-083 |

---

## Minimal test files to create

| File | New/Add | Groups | Mock seams |
|---|---|---|---|
| `tests/ragClient.test.js` | **NEW** | A (16 unit) | `jest.doMock('axios', () => ({ create }))` + `jest.resetModules()` + `require()` after; env `RAG_API_URL`/`RAG_TIMEOUT_MS`; spy `console.warn`. Mirrors `tests/zenbookerClient.test.js`. |
| `tests/kbDiagnosticsService.test.js` | **NEW** | B, C, D, E (26 cases) | pure fns for B/C (no mocks); for D/E `jest.mock` `ragClient` + `jobsService` (`getJobById`,`addNote`) + `marketplaceService` (`isAppConnected`,`AI_REPAIR_ADVISOR_APP_KEY`). |
| `tests/repairAdvisorEvents.test.js` | **NEW** | F, G(070/074), H (14 cases) | emit sites via `jest.isolateModules`+`jest.doMock('eventBus',{emit})` (mirror `tests/jobsCreate.test.js` `loadService`); subscriber via real `eventBus`+`jest.mock('db/connection')`+`jest.mock('kbDiagnosticsService',{runForJob})` + `setImmediate` flush (mirror `tests/rulesEngine.test.js`); gate via `jest.mock('db/marketplaceQueries')` (mirror `tests/googleEmailMarketplace.test.js`). |
| `tests/jobsCreate.test.js`, `tests/leadsService.convert.test.js` | **ADD (optional)** | F(060–063) alt-home | reuse each file's existing real-service scaffolding; add `eventBus.emit` spy assertions. |
| Manual/psql | — | G(071/072/073) | run `161_…sql` / `rollback_161_…sql`; verify `marketplace_apps` row + tile connect. |

**Mock seams summary (exact strings):**
- `jest.doMock('axios', () => ({ create: jest.fn(() => ({ post })) }))`
- `jest.mock('../backend/src/services/ragClient', () => ({ ask: jest.fn() }))`
- `jest.mock('../backend/src/services/jobsService', () => ({ getJobById: jest.fn(), addNote: jest.fn() }))`
- `jest.mock('../backend/src/services/marketplaceService', () => ({ isAppConnected: jest.fn(), AI_REPAIR_ADVISOR_APP_KEY: 'ai-repair-advisor' }))`
- `jest.mock('../backend/src/db/connection', () => ({ query: jest.fn() }))`
- `jest.mock('../backend/src/db/marketplaceQueries', () => ({ getPublishedAppByKey: jest.fn(), findActiveInstallation: jest.fn(), listPublishedAppsWithInstallation: jest.fn() }))`
- `jest.doMock('../backend/src/services/eventBus', () => ({ emit: jest.fn().mockResolvedValue({}) }))`
- `jest.mock('../backend/src/services/kbDiagnosticsService', () => ({ runForJob: jest.fn() }))`

---

## Hard-to-test / open decisions (flag to Implementer + Reviewer)

1. **Worktree jest-ignore (RUN-BLOCKER).** Root `package.json` ignores `/\.claude/worktrees/`. Every new file above **must** be run with `npx jest --runTestsByPath tests/<file> --testPathIgnorePatterns "/node_modules/"`, or the whole suite is skipped and shows a false green. Bake this into the run docs / CI for the worktree.
2. **5xx retry vs `retryRequest(fn,1)` (SPEC vs BRIEF conflict).** `retryRequest` (`zenbookerClient.js:540`) makes **one** attempt at `maxRetries=1` for *every* error class — 5xx is retried only at `maxRetries≥2`. Cases pin to the spec's `retryRequest(fn,1)` → single attempt (TC-RA-010/011/012). If the Implementer chooses to retry 5xx/timeouts, they must call `retryRequest(fn, N>1)`; then update TC-RA-011 to `post` called `N` times while TC-RA-012 (4xx) stays at one. **Decision belongs to the Implementer; test asserts whichever arg ships.**
3. **`buildQuestion`/`formatNote` export.** Groups B/C assume these are exported (Assumption 1). If kept private, they can only be black-box tested through `runForJob` (fewer, weaker assertions). Recommend exporting for unit-testability (house precedent: `rulesEngine`, `ruleActions`).
4. **`setImmediate` offload assertion (TC-RA-065).** Proving "returns fast, doesn't await RAG" is inherently timing-shaped — done via a mocked `runForJob` that never resolves + a double `setImmediate` flush (or fake timers). Deterministic but relies on the mock seam, not a real 30s call.
5. **Exact-simultaneous double detached run.** §3.6 declares a truly concurrent double-`runForJob` on the same job out of scope for Stage 1 (best-effort; the read-time idempotency guard covers all realistic redelivery). **Not testable deterministically → intentionally uncovered; documented, not a gap.**
6. **Raw SQL migration not Jest-executed.** House has no precedent for running `.sql` under Jest; TC-RA-071/072 are manual/psql. Only the `ensureMarketplaceSchema` registration (TC-RA-070) and runtime gate (TC-RA-074) are automated.
7. **Migration number drift.** Architecture chose **161** (worktree local max = 151; all-refs max = 160). Re-verify the true max immediately before the Implementer creates the file — parallel branches drift (existing known gotcha).
8. **`addNote` → Zenbooker mirror.** `addNote` also mirrors note text to ZB when `job.zenbooker_job_id` is set (`jobsService.js:1179`). In the `runForJob` unit tests `addNote` is mocked, so this is invisible/irrelevant; a future full-integration test would need the ZB client mocked to avoid a live call. Noted, not covered in Stage 1 unit scope.

---

## Document placement note

Saved to **`Docs/test-cases/REPAIR-ADVISOR-001.md`** — the established house location (46 existing test-case docs, e.g. `EMAIL-TIMELINE-001.md`, `SLOT-ENGINE-001-UX-POLISH.md`), which is also the path in the Test-Cases agent instruction file. The orchestration brief nominated `Docs/tests/…` with an explicit "if the house keeps test-case docs elsewhere, match that" escape hatch — exercised here.
