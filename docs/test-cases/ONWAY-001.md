# Test Cases: ONWAY-001 — "On the way" / ETA notification

> **Spec:** `docs/specs/ONWAY-001.md` (authoritative) · **Requirements:** `docs/requirements.md` → ONWAY-001 (OW-R1..R7 / AC-1..AC-12 / SC-01..06)
> **Backend runner:** Jest (CommonJS, tests at repo root `tests/*.test.js`). **Frontend:** no RTL harness → manual/visual checklist + `npm run build` gate.

## Coverage

- **Total:** 38 cases — Automated backend (Jest): **21** · FSM/migration: **5** · Frontend manual + build gate: **12**.
- **Priority:** P0: 11 · P1: 16 · P2: 9 · P3: 2.
- **Type:** Unit: 6 · Integration (route, supertest): 18 · Migration/integration: 3 · Manual/visual: 11 · Build gate: 1.
- **Mapped scenarios:** SC-01..06, AC-1..AC-12, edge cases E1–E16 (spec §7).

### New test files (proposed)
- `tests/jobsEtaEstimate.test.js` — `POST /api/jobs/:id/eta/estimate` (route + mocked services).
- `tests/jobsEtaNotify.test.js` — `POST /api/jobs/:id/eta/notify` (route + mocked services), incl. SMS body render.
- `tests/onwayFsmTransitions.test.js` — fallback `ALLOWED_TRANSITIONS` map + (integration) migration 127 idempotency. (Migration cases may instead extend an existing DB-integration suite — see TI-2.)

---

## Test-infra notes (how to mock — grounded in existing suites)

Read alongside `tests/slotEngineProxy.test.js` (route + supertest + permission gate + service mocks), `tests/jobsCreate.test.js` (jobs router mounting + `req.companyFilter`-only tenant), and `tests/jobsStatusUpdate.test.js` (db mock + `fsmService` mock).

- **App harness (route tests):** build a bare `express()` app, `app.use(express.json())`, inject a middleware that sets `req.user`, `req.authz = { permissions: [...] }`, `req.companyFilter = { company_id: COMPANY }`, then `app.use('/', jobsRouter)`. Drive with `supertest`'s `request(app)`. **Poison the legacy field** `req.companyId = 'LEGACY-DO-NOT-USE'` (mirrors `jobsCreate.test.js`) to prove the route reads only `req.companyFilter` (AC-12).
- **Permission gate:** the route uses `requirePermission('messages.send')`, which reads `req.authz.permissions`. 403 case = `permissions: []`; happy path = `permissions: ['messages.send']`. 401 (no token) is exercised by NOT injecting `req.user`/`req.authz` (the real middleware short-circuits) — or assert at the `requirePermission` unit level; prefer the 403 path for these route specs since the harness fakes auth.
- **`jobsService` mock:** `jest.mock('../backend/src/services/jobsService', () => ({ getJobById: jest.fn(), updateBlancStatus: jest.fn() }))`. `getJobById(id, companyId)` resolves a job row on the happy path and **`null`** for the cross-tenant/missing case (real impl returns null when `company_id` ≠ row's). Assert every call passes the company from `req.companyFilter`.
- **`conversationsService` mock:** `jest.mock('../backend/src/services/conversationsService', () => ({ getOrCreateConversation: jest.fn(), sendMessage: jest.fn() }))`. Signature is `sendMessage(conversationId, { body, author })` — **assert the SMS template on `mock.calls[0][1].body`** and `author: 'agent'`. Happy: `getOrCreateConversation` → `{ id: '<uuid>' }`, `sendMessage` → resolves.
- **`companyQueries` mock:** `jest.mock('../backend/src/db/companyQueries', () => ({ getById: jest.fn() }))` → `{ name: 'ABC Homes' }`; null-name case returns `{ name: null }` (or `null`) to exercise the `your service team` fallback.
- **`routeDistanceService` mock (estimate only):** `jest.mock('../backend/src/services/routeDistanceService', () => ({ computePair: jest.fn() }))`. **Important — `computePair` does NOT throw on NO_KEY/error; it returns** `{ status:'failed', errorCode }` (verified in `routeDistanceService.js`). Success shape: `{ status:'success', durationMinutes: 23 }` (already an integer). The notify endpoint does NOT call `computePair`.
- **Wallet block (no separate mock needed):** the wallet gate lives *inside* `conversationsService.sendMessage` (`walletService.assertServiceActive` throws `Error` with `httpStatus:402, code:'WALLET_BLOCKED'`). Because `conversationsService` is mocked at the module boundary, simulate wallet-block by `sendMessage.mockRejectedValue(Object.assign(new Error('blocked'), { httpStatus: 402, code: 'WALLET_BLOCKED' }))`. The route must classify by that code → `WALLET_BLOCKED` shape. Generic failure = `sendMessage.mockRejectedValue(new Error('twilio 500'))` → `SMS_FAILED`. **No second wallet check** is asserted (single enforcement point, Protected).
- **Proxy DID resolution** (`resolveCompanyProxyE164`, spec §4.5) reads `sms_conversations` MRU via `db.query`, then falls back to `process.env.SOFTPHONE_CALLER_ID`. For route tests, either (a) mock `db/connection` `query` to return `{ rows: [{ proxy_e164: '+1...' }] }` (MRU hit) vs `{ rows: [] }` (miss), toggling `process.env.SOFTPHONE_CALLER_ID` for the env-fallback and the NO_PROXY (both null) cases; or (b) if the helper is exported from `conversationsService`, mock it there. **GAP:** the helper's home (route-local vs `conversationsService` export) is an implementer choice — the test must mock whichever surface ships; both options are noted on each affected case.
- **Other route deps:** stub the unrelated modules the jobs router imports so `require()` is cheap (per `jobsCreate.test.js`): `zenbookerClient`, `noteAttachmentsService` (`{ MAX_FILE_SIZE:1, MAX_FILES_PER_NOTE:1 }`), `eventService`, `stripePaymentsService` (`{ StripePaymentsError: class extends Error {} }`).
- **Migration cases (TI-2 GAP):** there is **no existing Jest suite that runs `.sql` migrations against a live Postgres** in `tests/` (the closest, `tests/db/`, holds fixtures/lint, not a migration runner). Options: (1) a focused unit on the regex/`replace()` transform if the implementer extracts it to JS — preferred for CI; (2) an integration test gated behind a `DATABASE_URL`/`pg` env that applies 073→127 to a scratch DB and asserts the SCXML — heavier, may be skipped in default CI. The fallback-map cases (TC-FSM-001..002) need **no DB** and run as plain unit tests today.

---

# Part 1 — Backend (automated Jest)

## 1A. `POST /api/jobs/:id/eta/estimate` — `tests/jobsEtaEstimate.test.js`

### TC-EST-001: Permission gate — 403 without `messages.send`
- **Priority:** P0 · **Type:** Integration (route) · **AC:** AC-2, AC-12 · **Edge:** E15
- **Preconditions:** Harness app with `permissions: []`.
- **Input:** `POST /api/jobs/5/eta/estimate` body `{ origin: { lat: 42.1, lng: -71.2 } }`.
- **Mocks:** none reached.
- **Expected:** `403`. `routeDistanceService.computePair` NOT called; `jobsService.getJobById` NOT called (gate is before handler).

### TC-EST-002: Unauthenticated → 401 (no token)
- **Priority:** P1 · **Type:** Unit/Integration · **AC:** AC-2
- **Notes:** With the real `authenticate` middleware, a request with no bearer token → 401. In the faked harness this is documented as covered by the real middleware chain (`authenticate` + `requireCompanyAccess` mounted in `server.js`); assert at most via a `requirePermission`/`authenticate` unit if a fixture exists. Lower confidence than TC-EST-001; keep as a checklist assertion if a 401 fixture isn't already established in the suite.

### TC-EST-003: Cross-tenant / missing job → 404
- **Priority:** P0 · **Type:** Integration (route) · **AC:** AC-12 · **Edge:** E14
- **Preconditions:** `permissions: ['messages.send']`; `getJobById.mockResolvedValue(null)`.
- **Input:** `POST /api/jobs/999/eta/estimate` body `{ origin: { lat: 42.1, lng: -71.2 } }`.
- **Expected:** `404`. Assert `getJobById` was called with `(999/id, COMPANY)` where `COMPANY === req.companyFilter.company_id` (never the body). `computePair` NOT called.

### TC-EST-004: Origin present + job has coords → eta_minutes from computePair (happy path)
- **Priority:** P0 · **Type:** Integration (route) · **AC:** AC-3 · **Scenario:** SC-01 step 3
- **Preconditions:** `permissions: ['messages.send']`; `getJobById` → `{ id:5, company_id:COMPANY, lat:42.20, lng:-71.10 }`; `computePair.mockResolvedValue({ status:'success', durationMinutes: 23 })`.
- **Input:** body `{ origin: { lat: 42.187, lng: -71.205 } }`.
- **Expected:** `200` `{ eta_minutes: 23, status: 'success' }`. Assert `computePair` called once with `(origin, { lat:42.20, lng:-71.10 } / dest, 'driving')`.

### TC-EST-005: No origin in body → eta_minutes:null, NO Google call
- **Priority:** P1 · **Type:** Integration (route) · **AC:** AC-4 · **Scenario:** SC-02 · **Edge:** E1
- **Preconditions:** `permissions: ['messages.send']`; `getJobById` → job WITH coords.
- **Input:** body `{}` (or `{ origin: { lat: null } }` / non-numeric).
- **Expected:** `200` `{ eta_minutes: null, status: 'unavailable' }`. **`computePair` NOT called** (assert `not.toHaveBeenCalled()`).

### TC-EST-006: Job has no usable destination (no lat/lng, no geocodable address) → eta_minutes:null
- **Priority:** P1 · **Type:** Integration (route) · **AC:** AC-4 · **Scenario:** SC-04 · **Edge:** E3
- **Preconditions:** `permissions: ['messages.send']`; `getJobById` → `{ id:5, company_id:COMPANY, lat:null, lng:null, address:null }`.
- **Input:** body `{ origin: { lat: 42.1, lng: -71.2 } }`.
- **Expected:** `200` `{ eta_minutes: null, status: 'unavailable' }`. `computePair` NOT called (dest unresolved before the call).

### TC-EST-007: computePair returns failed/NO_KEY → eta_minutes:null (non-error)
- **Priority:** P1 · **Type:** Integration (route) · **AC:** AC-4 (constraint: missing key behaves like SC-02) · **Edge:** E2
- **Preconditions:** `permissions: ['messages.send']`; `getJobById` → job WITH coords; `computePair.mockResolvedValue({ status:'failed', errorCode:'NO_KEY' })`.
- **Input:** body `{ origin: { lat: 42.1, lng: -71.2 } }`.
- **Expected:** `200` `{ eta_minutes: null, status: 'unavailable' }` (NOT a 5xx). Repeat parametrically with `errorCode:'OVER_QUERY_LIMIT'`/generic Google error → same null/unavailable.

### TC-EST-008: computePair success with null durationMinutes → eta_minutes:null
- **Priority:** P2 · **Type:** Integration (route) · **AC:** AC-4 · **Edge:** E2
- **Preconditions:** `computePair.mockResolvedValue({ status:'success', durationMinutes: null })` (Matrix returned no duration element).
- **Expected:** `200` `{ eta_minutes: null, status: 'unavailable' }` (route must not echo a null as a "success" eta).

### TC-EST-009: Malformed body (not an object) → 400
- **Priority:** P3 · **Type:** Integration (route)
- **Input:** raw body `"not-json-object"` / array.
- **Expected:** `400` (spec §4.1: 400 only for a body that isn't an object). Distinct from the null-origin path (which is 200/unavailable).

### TC-EST-010: company_id sourced only from req.companyFilter (isolation)
- **Priority:** P1 · **Type:** Integration (route) · **AC:** AC-12
- **Preconditions:** harness sets `req.companyId = 'LEGACY-DO-NOT-USE'` and `req.companyFilter.company_id = COMPANY`; body smuggles `company_id: 'OTHER'`.
- **Expected:** `getJobById` called with `COMPANY`, never `'OTHER'` nor `'LEGACY-DO-NOT-USE'`.

## 1B. `POST /api/jobs/:id/eta/notify` — `tests/jobsEtaNotify.test.js`

> Common happy-path preconditions (unless overridden): `permissions:['messages.send']`; `getJobById` → `{ id:5, company_id:COMPANY, customer_phone:'+16175551234', assigned_techs:[{ name:'Mike' }] }`; `companyQueries.getById` → `{ name:'ABC Homes' }`; proxy resolvable (MRU `{ rows:[{ proxy_e164:'+16175550000' }] }` OR `SOFTPHONE_CALLER_ID` set); `getOrCreateConversation` → `{ id:'conv-uuid' }`; `sendMessage` resolves; `updateBlancStatus` resolves.

### TC-NOT-001: Permission gate — 403 without `messages.send`
- **Priority:** P0 · **Type:** Integration (route) · **AC:** AC-2 · **Edge:** E15
- **Input:** `permissions: []`, body `{ eta_minutes: 25 }`.
- **Expected:** `403`. `sendMessage` NOT called; `updateBlancStatus` NOT called.

### TC-NOT-002: Cross-tenant / missing job → 404
- **Priority:** P0 · **Type:** Integration (route) · **AC:** AC-12 · **Edge:** E14
- **Preconditions:** `getJobById.mockResolvedValue(null)`.
- **Input:** body `{ eta_minutes: 25 }`.
- **Expected:** `404`. `getJobById` called with `(id, COMPANY)`. No send, no status change.

### TC-NOT-003: Happy path — sends EXACT SMS body, then advances status (ordering)
- **Priority:** P0 · **Type:** Integration (route) · **AC:** AC-6, AC-7, AC-9 · **Scenario:** SC-01 step 6
- **Input:** body `{ eta_minutes: 25 }`.
- **Expected:**
  - `200` `{ ok:true, status:'On the way', eta_minutes:25, conversation_id:'conv-uuid' }`.
  - `getOrCreateConversation` called with `('+16175551234' /customerE164, proxyE164, COMPANY)`.
  - `sendMessage` called once with `('conv-uuid', { body: <EXACT>, author:'agent' })` where **`body` === `"Hi! Your technician Mike from ABC Homes is on the way and should arrive in about 25 minutes."`** (assert the full rendered string — incl. `{tech}`=Mike, `{company}`=ABC Homes, `{eta}`=25).
  - `updateBlancStatus` called once with `(5, 'On the way', COMPANY)`.
  - **Order assertion:** `sendMessage`'s invocation order precedes `updateBlancStatus` (e.g. via `mock.invocationCallOrder` — SMS-first, AC-7).

### TC-NOT-004: NO_PHONE — job.customer_phone null → 422, no send, no status change
- **Priority:** P0 · **Type:** Integration (route) · **AC:** AC-8 · **Scenario:** SC-03 · **Edge:** E4
- **Preconditions:** `getJobById` → `{ ..., customer_phone: null }` (also test `''`).
- **Input:** body `{ eta_minutes: 25 }`.
- **Expected:** `422` `{ ok:false, error:'NO_PHONE', message:'No phone number on file for this customer.' }`. `getOrCreateConversation`/`sendMessage`/`updateBlancStatus` NOT called (checked before any send).

### TC-NOT-005: NO_PROXY — no MRU + no SOFTPHONE_CALLER_ID → 422, no send
- **Priority:** P1 · **Type:** Integration (route) · **AC:** AC-12 (server-side proxy) · **Edge:** E5
- **Preconditions:** proxy MRU empty (`db.query` → `{ rows: [] }`) AND `delete process.env.SOFTPHONE_CALLER_ID`. **GAP:** mock at the surface where `resolveCompanyProxyE164` lives (route-local `db.query` vs `conversationsService` export).
- **Input:** body `{ eta_minutes: 25 }`.
- **Expected:** `422` `{ ok:false, error:'NO_PROXY', message:'No sending number configured.' }`. `sendMessage`/`updateBlancStatus` NOT called.

### TC-NOT-006: NO_PROXY env fallback — MRU empty but SOFTPHONE_CALLER_ID set → proceeds
- **Priority:** P2 · **Type:** Integration (route) · **Edge:** E5 (inverse) · **Spec:** §4.5 step 2
- **Preconditions:** MRU `{ rows: [] }`; `process.env.SOFTPHONE_CALLER_ID = '+16175559999'`.
- **Expected:** `200 ok:true`; `getOrCreateConversation` called with `proxyE164 === '+16175559999'`.

### TC-NOT-007: Wallet-blocked (sendMessage throws wallet error) → status unchanged, WALLET_BLOCKED surfaced
- **Priority:** P0 · **Type:** Integration (route) · **AC:** AC-7 · **Scenario:** SC-05 · **Edge:** E6
- **Preconditions:** `sendMessage.mockRejectedValue(Object.assign(new Error('blocked'), { httpStatus:402, code:'WALLET_BLOCKED' }))`.
- **Input:** body `{ eta_minutes: 25 }`.
- **Expected:** `402` (passthrough) `{ ok:false, error:'WALLET_BLOCKED', message:'Messaging is paused — top up your balance.' }`. **`updateBlancStatus` NOT called** (status unchanged). Assert NO second/duplicate wallet check is introduced (single enforcement point — Protected; behavioral proxy: route does not import/call `walletService` directly).

### TC-NOT-008: Generic SMS send failure (sendMessage throws non-wallet) → status unchanged, SMS_FAILED
- **Priority:** P0 · **Type:** Integration (route) · **AC:** AC-7 · **Scenario:** SC-06 · **Edge:** E7
- **Preconditions:** `sendMessage.mockRejectedValue(new Error('twilio 500'))`.
- **Expected:** `502`/`500` `{ ok:false, error:'SMS_FAILED', message:'Couldn't send the message.' }`. **`updateBlancStatus` NOT called.**

### TC-NOT-009: Status-set throws AFTER successful send → {ok:true, warning:'status_not_advanced'} (no SMS rollback)
- **Priority:** P0 · **Type:** Integration (route) · **AC:** AC-7 · **Edge:** E8, E9
- **Preconditions:** `sendMessage` resolves; `updateBlancStatus.mockRejectedValue(new Error('transition not allowed'))`.
- **Input:** body `{ eta_minutes: 25 }`.
- **Expected:** `200` `{ ok:true, warning:'status_not_advanced', eta_minutes:25, conversation_id:'conv-uuid' }` (NO `status` field, or unchanged). `sendMessage` WAS called once (SMS not rolled back / not re-sent).

### TC-NOT-010: SMS body — {tech} = first of multiple assigned techs
- **Priority:** P1 · **Type:** Integration (route) · **AC:** AC-9 · **Edge:** E10
- **Preconditions:** `assigned_techs: [{ name:'Mike' }, { name:'Sara' }]`.
- **Expected:** body === `"Hi! Your technician Mike from ABC Homes is on the way and should arrive in about 25 minutes."` (only the first; "Sara" absent).

### TC-NOT-011: SMS body — no assigned tech / empty name → "your technician" lead-in, no double word
- **Priority:** P1 · **Type:** Integration (route) · **AC:** AC-9 · **Edge:** E12 · **Spec:** §3.1
- **Preconditions:** `assigned_techs: []` (also test `[{ name:'' }]`).
- **Expected:** body === `"Hi! Your technician from ABC Homes is on the way and should arrive in about 25 minutes."` (the word "technician" stays once; the name is omitted — NOT "your technician your technician").

### TC-NOT-012: SMS body — missing company name → "your service team" fallback
- **Priority:** P1 · **Type:** Integration (route) · **AC:** AC-9 · **Edge:** E11 · **Spec:** §3.1
- **Preconditions:** `companyQueries.getById` → `{ name: null }` (also test `''` / null row).
- **Expected:** body === `"Hi! Your technician Mike from your service team is on the way and should arrive in about 25 minutes."`

### TC-NOT-013: Invalid eta_minutes (defense-in-depth) → 400 invalid_eta, no side effects
- **Priority:** P1 · **Type:** Integration (route) · **Edge:** E16 · **Spec:** §4.2
- **Input (parametric):** `{ eta_minutes: 0 }`, `{ eta_minutes: 601 }`, `{ eta_minutes: 25.5 }`, `{ eta_minutes: 'soon' }`, `{}` (missing).
- **Expected:** each → `400` `{ ok:false, error:'invalid_eta' }`. `getOrCreateConversation`/`sendMessage`/`updateBlancStatus` NOT called. Boundary-valid `1` and `600` → NOT rejected (proceed past validation).

### TC-NOT-014: company_id sourced only from req.companyFilter (isolation, all calls)
- **Priority:** P1 · **Type:** Integration (route) · **AC:** AC-12
- **Preconditions:** body smuggles `company_id:'OTHER'`; harness `req.companyId='LEGACY-DO-NOT-USE'`.
- **Expected:** `getJobById`, `companyQueries.getById`, `getOrCreateConversation`, `updateBlancStatus` all receive `COMPANY` (from `req.companyFilter`) — never `'OTHER'`/`'LEGACY-DO-NOT-USE'`.

### TC-NOT-015: Idempotency — already "On the way" → updateBlancStatus is FSM __NOOP__ (no double-flip)
- **Priority:** P2 · **Type:** Integration (route) · **AC:** AC-8 · **Edge:** E13 · **Spec:** §4.4
- **Preconditions:** `getJobById` → job already `blanc_status:'On the way'`; `updateBlancStatus` resolves as a no-op (status unchanged, no throw).
- **Expected:** `200 ok:true` (server-side is `__NOOP__`-safe). Documents that double-send prevention is **client-owned** (in-flight disable) — this case asserts the server does not error/double-flip, NOT that it dedups the SMS.

---

# Part 2 — FSM / Migration

### TC-FSM-001: Fallback `ALLOWED_TRANSITIONS` allows Submitted→On the way & Rescheduled→On the way
- **Priority:** P0 · **Type:** Unit (no DB) · **AC:** AC-10 · **Spec:** §5.4(3) · **File:** `tests/onwayFsmTransitions.test.js`
- **Preconditions:** require `jobsService` (or the exported transition map). Today `ALLOWED_TRANSITIONS['Submitted']` = `['Follow Up with Client','Waiting for parts','Canceled']` and `['Rescheduled']` = `['Submitted','Canceled']` — this case asserts the ONWAY edit added `'On the way'` to both.
- **Expected:** `BLANC_STATUSES` includes `'On the way'`; `ALLOWED_TRANSITIONS['Submitted']` includes `'On the way'`; `ALLOWED_TRANSITIONS['Rescheduled']` includes `'On the way'`. Assert via `isTransitionAllowed`/the validation path if exported, else inspect the map. (Ensures unseeded tenants — fallback path — can reach the status.)

### TC-FSM-002: Fallback map — On the way → Visit completed & Canceled; existing transitions intact
- **Priority:** P1 · **Type:** Unit (no DB) · **AC:** AC-10 (non-terminal, sensible onward) · **Spec:** §5.1, §5.4(3)
- **Expected:** `ALLOWED_TRANSITIONS['On the way']` === `['Visit completed','Canceled']`. **Regression:** every pre-existing key/target still present and unchanged (deep-compare the prior map minus the additions) — On the way is purely additive, no status/transition dropped (Protected, FSM-001 §8). `OUTBOUND_MAP` untouched (no ZB mapping for On the way).

### TC-FSM-003: Migration 127 — published job machine gains the On the way state + correct transitions
- **Priority:** P0 · **Type:** Integration (migration, needs Postgres) · **AC:** AC-10, AC-11 · **Spec:** §5.3 · **GAP:** see TI-2 (no migration runner in `tests/` today)
- **Preconditions:** scratch DB with 073 applied (a `fsm_machines machine_key='job'` row + published `fsm_versions.scxml_source` lacking `id="On_the_way"`). Apply `127_job_fsm_on_the_way.sql`.
- **Expected (assert on the new active published `scxml_source`):**
  - contains `<state id="On_the_way" … blanc:statusName="On the way">` with child transitions `TO_VISIT_COMPLETED → Visit_completed` and `TO_CANCELED → Canceled`.
  - `Submitted` state now has child `TO_ON_THE_WAY → On_the_way`; `Rescheduled` state now has child `TO_ON_THE_WAY → On_the_way`.
  - `fsm_machines.active_version_id` repointed to a NEW `fsm_versions` row (`status='published'`, `version_number = prev+1`, `change_note='Add On the way status (ONWAY-001)'`); the previously-published row is now `status='archived'`.

### TC-FSM-004: Migration 127 — idempotent (re-run = no-op via NOT LIKE guard)
- **Priority:** P1 · **Type:** Integration (migration) · **Spec:** §5.3 (guard `WHERE v.scxml_source NOT LIKE '%id="On_the_way"%'`) · **GAP:** TI-2
- **Steps:** apply 127 twice; capture `active_version_id` + version count after first run.
- **Expected:** the second run changes nothing — same `active_version_id`, no new `fsm_versions` row inserted, no extra archive (the guard skips rows already containing `id="On_the_way"`). Also convergent with 073/`fsm/job.scxml` edits (running both is safe).

### TC-FSM-005: Migration 127 — markers-not-found row is skipped (RAISE NOTICE, no partial write)
- **Priority:** P3 · **Type:** Integration (migration) · **Spec:** §5.3 (`IF new_scxml == scxml_source → NOTICE; CONTINUE`) · **GAP:** TI-2
- **Preconditions:** a `machine_key='job'` row whose SCXML lacks the expected `Submitted`/`Rescheduled`/`Canceled` markers (e.g. a customized graph).
- **Expected:** that row is left unchanged (no new version, no archive) and a NOTICE is emitted; other well-formed rows still update (loop continues). No exception aborts the migration.

---

# Part 3 — Frontend (manual / visual checklist + build gate)

> No RTL harness. Each item = a manual verification step in the running app (`OnTheWayModal.tsx` + `JobStatusTags.tsx`/`JobOpsSection`). Exact copy strings per spec §3. Verify on a mobile PWA viewport for geolocation items.

### TC-FE-001: CTA visibility gated on status (Submitted/Rescheduled only)
- **Priority:** P0 · **AC:** AC-1 · **Edge:** E9
- **Check:** Primary orange-gradient **"On the way"** CTA renders on a job in **Submitted** and in **Rescheduled**. It is **hidden** for `Waiting for parts`, `Follow Up with Client`, `Visit completed`, `Job is Done`, `Canceled`, and `On the way` itself. (The FSM `ActionsBlock` transition button may still exist; the styled CTA is the gated entry point.)

### TC-FE-002: CTA hidden without `messages.send`
- **Priority:** P0 · **AC:** AC-2 · **Edge:** E15
- **Check:** As a user lacking `messages.send`, the primary CTA does NOT render on a Submitted/Rescheduled job (and the endpoints 403 — covered server-side by TC-NOT-001/TC-EST-001).

### TC-FE-003: Modal opens → single geolocation request
- **Priority:** P0 · **AC:** AC-3 · **Scenario:** SC-01 · **Spec:** §2.2
- **Check:** Tapping the CTA opens the modal (title **"On the way"**), which immediately fires **one** `navigator.geolocation.getCurrentPosition` (8s timeout, no `watchPosition`). State (a): spinner + **"Finding your location…"** with tiles already visible/selectable underneath. Close+reopen re-requests once.

### TC-FE-004: ETA-computed state (b) → pre-selected "Google ETA · ~N min"
- **Priority:** P0 · **AC:** AC-3, AC-5 · **Scenario:** SC-01 step 4
- **Check:** With permission granted + a fix + a job address, the modal calls `jobsApi.estimateEta` and shows a highlighted, **pre-selected** row **"Google ETA · ~{N} min"** at the top (N = returned integer). Tiles + custom also present. "Notify client" is enabled (Google value pre-selected).

### TC-FE-005: ETA-unavailable state (c) — denied / desktop / no address
- **Priority:** P1 · **AC:** AC-4 · **Scenario:** SC-02, SC-04 · **Edge:** E1, E2, E3
- **Check:** When geolocation is denied/unavailable/timed-out (or `estimateEta` → null), show muted **"ETA unavailable — location is off."** + hint **"Allow location access to get a live travel-time estimate, or pick a time below."**, with **NO Google option row** and **nothing pre-selected**. "Notify client" stays disabled until a tile/custom is chosen. (On a denied/no-API path, NO `estimate` call is made — E1.)

### TC-FE-006: Preset tiles render 10 / 15 / 20 / 30 / 45 / 60
- **Priority:** P1 · **AC:** AC-5 · **Spec:** §2.1
- **Check:** Exactly the six tiles `10, 15, 20, 30, 45, 60` (minutes) plus a **"Set custom time"** affordance are present in all states (a)/(b)/(c).

### TC-FE-007: Custom-minutes entry — integer 1–600 validation
- **Priority:** P1 · **AC:** AC-5 · **Edge:** E16 · **Spec:** §2.1
- **Check:** "Set custom time" reveals a numeric **Minutes** field (placeholder `e.g. 25`). Valid integer 1–600 becomes the active selection. Empty / 0 / 601 / non-integer → shows hint **"Enter 1–600 minutes."** and CANNOT be the active selection ("Notify client" stays disabled). Boundary `1` and `600` accepted.

### TC-FE-008: Exactly one selection active across {Google | tile | custom}
- **Priority:** P1 · **AC:** AC-5 · **Spec:** §2.1
- **Check:** Selecting a tile clears the Google pre-selection and any custom value; typing a valid custom deselects tiles/Google; selecting Google (state b) clears tiles/custom. Never two highlighted at once.

### TC-FE-009: Notify disabled until chosen + disabled in-flight (no double-send)
- **Priority:** P0 · **AC:** AC-8 · **Edge:** E13 · **Spec:** §2.3
- **Check:** "Notify client" is disabled with no selection. On tap it enters in-flight (disabled + label **"Sending…"**); rapid second taps do not fire a second `notifyOnTheWay`. No silent auto-retry on network timeout.

### TC-FE-010: Success → toast + status flips to On the way + SMS in timeline
- **Priority:** P0 · **AC:** AC-6, AC-7, AC-11 · **Scenario:** SC-01 step 7
- **Check:** On `{ ok:true }`: success toast **"Customer notified — you're marked On the way."**, modal closes, `onNotified(job.id)` refetches; the card now shows the **On the way** badge (color `#0EA5E9`) and the CTA is no longer primary. The outbound SMS appears in the customer's conversation timeline (written server-side by `sendMessage`).

### TC-FE-011: Error & warning toasts map to the right copy
- **Priority:** P1 · **AC:** AC-7 · **Edge:** E4, E5, E6, E7, E8 · **Spec:** §3, §5.4
- **Check (modal stays open + button re-enabled on error; closes+refreshes on warning):**
  - 422 NO_PHONE → **"No phone number on file for this customer."**
  - 422 NO_PROXY → **"No sending number configured for your company."**
  - WALLET_BLOCKED → **"Messaging is paused — top up your balance."**
  - SMS_FAILED → **"Couldn't send the message. Please try again."**
  - `{ ok:true, warning:'status_not_advanced' }` → **"SMS sent, but the job status didn't update. You can change it manually."** (still closes + refreshes).

### TC-FE-012: Build gate — `npm run build` green
- **Priority:** P0 · **Type:** Build gate
- **Check:** From `frontend/`, `npm run build` (i.e. `tsc -b` + Vite) passes with no type/lint errors — covers the new `OnTheWayModal.tsx`, `jobsApi.ts` methods (`estimateEta`/`notifyOnTheWay`), and the `jobHelpers.tsx` status+color additions. (Per project memory: use `npm run build`, not just `tsc --noEmit`; prod Docker build is stricter — `noUnusedLocals`.)

---

## Traceability matrix (condensed)

| Req / Scenario | Cases |
|---|---|
| AC-1 (CTA gating) | TC-FE-001 |
| AC-2 (permission) | TC-EST-001, TC-NOT-001, TC-FE-002 |
| AC-3 / AC-4 (geo ETA / fallback) | TC-EST-004..008, TC-FE-003..005 |
| AC-5 (selection model) | TC-FE-004,006,007,008 |
| AC-6 (SMS via conversationsService) | TC-NOT-003, TC-FE-010 |
| AC-7 (SMS-first ordering, best-effort status) | TC-NOT-003,007,008,009, TC-FE-011 |
| AC-8 (no-phone block, idempotency) | TC-NOT-004,015, TC-FE-009 |
| AC-9 (exact SMS template) | TC-NOT-003,010,011,012 |
| AC-10 / AC-11 (new status, FSM) | TC-FSM-001..005, TC-FE-010 |
| AC-12 (tenant isolation) | TC-EST-003,010, TC-NOT-002,005,014 |
| SC-01..06 | TC-EST-004(SC1), TC-EST-005/007(SC2), TC-NOT-004(SC3), TC-EST-006(SC4), TC-NOT-007(SC5), TC-NOT-008(SC6) |
| Edge E1–E16 | mapped inline per case |
