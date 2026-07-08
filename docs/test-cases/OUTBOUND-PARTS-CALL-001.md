# Тест-кейсы: OUTBOUND-PARTS-CALL-001 — outbound VAPI "part arrived → book the finish visit," driven by a Task with typed action buttons (+ TASK-ACTIONS sub-component)

**Source spec:** `Docs/specs/OUTBOUND-PARTS-CALL-001.md` (S1–S14, PART A–D, API/VAPI contracts, edge cases) + `Docs/requirements.md` §OUTBOUND-PARTS-CALL-001 (D1–D7, FR-TA1…4, FR-1…14, AC-1…12, OQ-1…5) + `Docs/architecture.md` §OUTBOUND-PARTS-CALL-001 (§0–§11, Decisions A–F, OQ-resolutions §10, Deviations §11 — all binding).

**Change points (backend):** NEW `backend/src/services/partsCallService.js` (`onPartArrived`, `startRobotCall`); NEW `backend/src/services/outboundCallService.js` (`placeCall` → VAPI `POST /call`); NEW `backend/src/services/outboundCallWorker.js` (claim loop, business-hours clamp); NEW `backend/src/services/taskActions/registry.js` (closed `{robot_call, manual_call}` map); NEW skill `backend/src/services/agentSkills/skills/confirmPartsVisit.js` + additive `agentSkills/registry.js` entry (L0, kind write); NEW route `POST /api/tasks/:id/actions/:type` in `backend/src/routes/tasks.js`; NEW webhook `POST /api/vapi/call-status` in `backend/src/routes/vapi.js`; NEW `backend/src/services/outboundCallSettings.js` (`resolve(companyId)` safe-fail). **Modified (protected):** `jobsService.js` (`BLANC_STATUSES` +`Part arrived`, `ALLOWED_TRANSITIONS`, fire-and-forget `updateBlancStatus` hook); `tasksQueries.createTask` (additive `kind`+`actions` passthrough, `tasksQueries.js:213–232`); `scheduleService.rescheduleItem` (AR-4 ZB write-through, verified present `scheduleService.js:240`); `src/server.js` (additive worker bootstrap, env-gated `FEATURE_OUTBOUND_CALL_WORKER`, `src/server.js:422–448`). **Frontend:** `frontend/src/components/tasks/TaskCard.tsx` (render `actions[]`), `frontend/src/services/tasksApi.ts` (`runTaskAction`, `Task.actions`), `SoftPhoneContext.openDialer` consumer (unchanged, `SoftPhoneContext.tsx:18,46`). **Migrations:** `156_job_fsm_part_arrived.sql` (SCXML per-company, modeled on `127_job_fsm_on_the_way.sql`), `157_tasks_actions.sql` (`tasks.actions jsonb`), `158_outbound_call_attempts.sql` (+partial-unique `(job_id) WHERE status IN ('pending','dialing')`), `159_outbound_call_settings.sql`. Max existing migration = **155** (`backend/db/migrations/155_backfill_outbound_email_links.sql`) — re-verify max before applying (parallel branches).

**House lesson (LIST-PAGINATION-001 / created_by-FK, binding):** mocked jest validates the SQL **string / dispatch shape** and branch taken only — it mocks `db`/`client`, so it can NOT prove a row moved, a task was re-homed, a partial-unique index actually blocked a second row, a status transition survived a thrown hook, or a ZB conflict left NO false success. Every behavior claim below therefore has a real-DB integration case. The unit section pins dispatch + contract + call-order; the integration section pins behavior against real Postgres (`scripts/verify-outbound-parts-call-001.js`, tag `OPC1`, self-seeding/self-cleaning, PASS/FAIL per case + sabotage control), exactly as `scripts/verify-agent-skills-002.js` / `scripts/verify-contact-email-merge-001.js` do (`CheckError`/`check`/`sabotageTrips` kit, `--section`, non-zero exit on any FAIL).

**Jest gotcha:** in a worktree run with `--testPathIgnorePatterns "/node_modules/"` (JOBS-UX-RBAC-001 lesson).

**External services — MOCKED everywhere in unit + real-DB (NO real HTTP to `api.vapi.ai` / Zenbooker, ever):**
- **VAPI `POST https://api.vapi.ai/call`** and **VAPI webhook signing** — stub `outboundCallService.placeCall` (or the `fetch`/`axios` seam it uses) to return a canned `{ id: 'vapi_call_test' }` and to record calls/args; assert URL, `Bearer VAPI_API_KEY` header, body shape. Never dial.
- **Zenbooker `rescheduleJob`** — the SAME `Module._load` ZB stub used by `verify-agent-skills-002.js` (records calls, `_throwReschedule` to inject a `{ statusCode:409 }`). Never touch a real ZB account (ZB-ISO-001).
- **slot-engine `recommendSlots`** — for real-DB it is the REAL function gated on a seeded `smart-slot-engine` marketplace connection OR stubbed at the module boundary to return the frozen `{available,slots,fallback}` shape (both variants exercised); for unit it is mocked.

---

## Scenario map (spec S-id → cases)

| S-id | Meaning | Source | Priority focus |
|------|---------|--------|----------------|
| **S1** | `Waiting for parts → Part arrived` creates ONE task w/ 2 actions; **idempotent** (re-entry / dup event → no 2nd task) | FR-2/FR-3, AC-2, §B2/B3 | **P0 (idempotence gate)** |
| **S2** | `robot_call` happy path: pre-compute slot → dial → agree → `confirmPartsVisit` → reschedule(+ZB)+flip Rescheduled+note+task Done | FR-5/FR-8, AC-3, S2 | **P0 (happy path)** |
| **S3** | Decline offered slot → live `recommendSlots` alternatives → book (same terminal state as S2) | FR-7, AC-4, S3 | P1 |
| **S4** | No-answer / voicemail → per-attempt job note + retry (immediate / +2h / next-biz-morning), biz-hours clamp | FR-10/FR-11, AC-5, S4 | P1 |
| **S5** | After ×3 unsuccessful → attempt `exhausted`, task stays w/ dispatcher, job stays `Part arrived` | FR-12, AC-5, S5 | P1 |
| **S6** | No-slots / engine error BEFORE call → NO call, NO attempt row, task reason, `robot_call` state `failed` | FR-9, AC-6, S6 | **P0 (no-call gate)** |
| **S7** | `manual_call` → `openDialer` (desktop) / native `tel:` (mobile); backend no-op returns `{client:'openDialer'}` | FR-14, AC-7, S7 | P1 |
| **S8** | ZB 409 at booking → graceful conflict, status NOT flipped, task NOT closed, NO false success | FR-8, S8, edge-4 | **P0 (no-false-success gate)** |
| **S9** | VAPI `call-status` webhook classifies `endedReason` → booked/no-answer/voicemail/declined/failed; dup webhook idempotent | FR-10…12, OQ-1, S9, edge-6 | P1 |
| **S10** | Cross-tenant / isolation: foreign task/job → 404; webhook company from attempt row not body; in-skill ownership pre-check | AC-10/AC-11, §8, S10 | **P0 (security gate)** |
| **S11** | Unknown action `:type` → 400 (no handler invoked) | AC-10, S11 | P1 |
| **S12** | Permission / auth: no token → 401; lacks `tasks.manage` → 403 | AC-10, §8, S12 | P1 |
| **S13** | Fail-safe: `onPartArrived` throws during the hook → status transition STILL commits | FR-2, AC-11, S13 | **P0 (fail-safe gate)** |
| **S14** | Idempotency: double `robot_call` while attempt `pending`/`dialing` → ONE call, 2nd → in-flight-existing (partial-unique) | FR-TA4, OQ-5, S14 | **P0 (dup-call gate)** |
| **FSM** | Migration 156: `Part arrived` valid state; `Waiting→Part arrived` (blanc:action) + `Part arrived→{Rescheduled,Canceled,Follow Up}` allowed; invalid rejected | FR-1, AC-1, §1 | **P0 (FSM gate)** |

**The seven P0 must-pass gates:** **S13** (fail-safe — status survives a thrown hook), **S1** (task idempotence — no second open task), **S14** (call idempotence — partial-unique blocks a 2nd dial), **S8** (ZB-409 — no false success), **S10** (cross-tenant), **S6** (no-slots → no call), and **FSM-mig-156** (`Part arrived` is a valid, correctly-connected state). A red on any blocks the release.

---

## Покрытие / Coverage

- Всего тест-кейсов: **42** (numbered) + **8** regression/protected items = **50**.
- **Numbered cases by priority — P0: 16 | P1: 16 | P2: 8 | P3: 2.** Regression items — P0: 1 | P1: 3 | P2: 2 | P3: 2.
- **Unit (jest, mocked db + mocked VAPI/ZB): 18** | **Integration (real DB, `scripts/verify-outbound-parts-call-001.js`, VAPI+ZB stubbed): 18** | **Frontend (manual + build): 6**.
- **External-service mocks required:** VAPI `POST /call` (`outboundCallService.placeCall` / fetch seam) — in every case that dials (U-side + I-side). Zenbooker `rescheduleJob` (Module._load stub) — S2/S3/S8 booking cases. `recommendSlots` — S2/S3/S6 (real gated OR module-boundary stub). VAPI webhook secret — S9/S10 webhook cases.
- Security (cross-tenant + auth): **6** (TC-OPC-I13/I14 real-DB + TC-OPC-U15/U16/U17 dispatch/auth guards + TC-OPC-I18 webhook company-from-row). Sabotage negative control: **1** (TC-OPC-ISAB).

---

## Shared fixtures & harness (Integration section)

House pattern of `scripts/verify-agent-skills-002.js` / `verify-contact-email-merge-001.js` (**VAPI + ZB are the ONLY mocks; every DB/service leg is real**):

- **Script:** `scripts/verify-outbound-parts-call-001.js`, sections `fsm | s1 | s2 | s3 | s4 | s5 | s6 | s8 | s9 | s10 | s14 | sab` selectable via `--section=<id>|all`. `DATABASE_URL` defaults to `postgresql://localhost/twilio_calls` (house default; **never** point at prod). Assert kit = `CheckError`/`check`/`eq`/`sabotageTrips` (mirror `verify-agent-skills-002.js:111–126`). Exit 0 only when no case FAILs.
- **ZB stub** installed on `Module._load` BEFORE any service importing `zenbookerClient` loads (mirror `verify-agent-skills-002.js` `zbStub`): records `rescheduleJob(zbJobId,payload)` calls, `_throwReschedule` injects `{ statusCode:409 }` for S8. **VAPI stub:** monkeypatch `outboundCallService.placeCall` (or its `fetch` seam) to record `{ url, headers, body }` and return `{ id:'vapi_call_<case>' }` — assert the request never leaves the process.
- **Unique tag `OPC1`** on every seeded row for self-cleaning: jobs by tagged company + `title/customer LIKE 'OPC1 %'`, tasks `kind='part_arrived_call'` on tagged jobs, `outbound_call_attempts` by tagged job_id, contacts `full_name LIKE 'OPC1 %'`, timelines by tagged company/contact, notes/events by tagged job. **Cleanup runs at process start, before EACH case, and at end**, FK order: outbound_call_attempts → tasks → notes/events → jobs → timelines → contacts → crm_users → companies (leave `outbound_call_settings` row for company A in place).
- **Companies:** A = seed `00000000-0000-0000-0000-000000000001` (= `DEFAULT_COMPANY_ID`, the v1 dial gate; real dev rows coexist → assertions are delta / tagged-scoped, never absolute whole-company counts); **B** = tagged `c0000000-0000-4000-8000-0000000000f1`, CREATED + deleted here (cross-tenant, S10).
- **Seed builders (tagged OPC1):** `mkContact(company,{name,phone})`, `mkJob(company,{contactId, blancStatus, zenbookerJobId?, addressZip})` (ZB-linked variant sets `zenbooker_job_id` for the ZB write-through), `seedPartArrivedTask(company,{jobId})` (open `kind='part_arrived_call'` w/ `actions=[robot_call,manual_call]`), `mkAttempt(company,{jobId,taskId,status,scheduledAt,vapiCallId,slotJson})`, `mkSettings(company,{maxAttempts,backoff,nextMorningHour,enabled})`, `mkBusinessHours(group,{tz, openHours})` (for the biz-hours clamp). Business-hours source = `groupRouting.isBusinessHours(group, now)`.
- **Real functions exercised (unmocked):** `jobsService.updateBlancStatus` (incl. the fire-and-forget hook), `partsCallService.onPartArrived` / `startRobotCall`, `taskActions/registry` handlers, the REAL `POST /api/tasks/:id/actions/:type` handler mounted in an express app with stub auth middleware injecting `req.user` / `req.authz` (`tasks.manage`) / `req.companyFilter={company_id:A}` (same harness shape as the jest route layer, real `db/connection`), `outboundCallWorker` tick (claim loop, biz-hours clamp), `confirmPartsVisit` skill via `agentSkills.runSkill`, `scheduleService.rescheduleItem`, the REAL `POST /api/vapi/call-status` webhook handler (secret-auth), `fsmService.resolveTransition`, `outboundCallSettings.resolve`.

---

## 1. Unit — jest, mocked db + mocked VAPI/ZB

`jest.mock('../backend/src/db/connection')` (+ `zenbookerClient`, `outboundCallService`, `recommendSlots`, `fetch` as needed); dispatch/contract/call-order assertions read the mocked query/handler calls and the branch taken. These pin the **decision tree, request contract, and call ordering** — never "a row moved / a status survived" (that is the integration section's job).

### TC-OPC-U01: `onPartArrived` — SELECT-guard finds NO open task → `createTask` once with `kind`+`actions`
- **Приоритет:** P0
- **Тип:** Unit
- **Связанный сценарий:** S1; FR-3; §B3; Deviation 2
- **Предусловия:** `SELECT 1 FROM tasks WHERE company_id=$1 AND job_id=$2 AND kind='part_arrived_call' AND status='open'` mocked → 0 rows; job lookup returns `{customer:'Jane', contact_id, phone}`.
- **Входные данные:** `onPartArrived(jobId=50, companyId=A)`.
- **Ожидаемый результат:** exactly one `createTask` call with `parentType:'job'`, `job_id:50`, `kind:'part_arrived_call'`, title `"Part arrived — schedule completion visit for Jane"`, `actions=[{type:'robot_call',label:'🤖 Let the robot call'},{type:'manual_call',label:"📞 I'll call myself"}]`. No lead/job created (D7).
- **Файл для теста:** `tests/partsCallService.test.js`

### TC-OPC-U02: `onPartArrived` — SELECT-guard finds an OPEN task → no-op (app-upsert)
- **Приоритет:** P0
- **Тип:** Unit
- **Связанный сценарий:** S1 idempotence; FR-3; §B3 ("createTask has no built-in upsert — the SELECT IS the upsert")
- **Предусловия:** the dedup `SELECT` mocked → 1 row.
- **Ожидаемый результат:** `createTask` is **NOT** called; function returns a no-op. Confirms re-entry / duplicate event never spawns a second task at the dispatch level.
- **Файл для теста:** `tests/partsCallService.test.js`

### TC-OPC-U03: `createTask` additive passthrough — `kind`+`actions` when present, existing callers untouched
- **Приоритет:** P0
- **Тип:** Unit
- **Связанный сценарий:** Deviation 2; FR-TA1; `tasksQueries.js:213–232`
- **Входные данные:** (a) `createTask({..., kind:'part_arrived_call', actions:[…]})`; (b) a legacy `createTask({...})` with neither.
- **Ожидаемый результат:** (a) the built `cols`/`vals` include `kind` and `actions` (jsonb); (b) the emitted SQL is **byte-identical** to today's legacy insert (no `kind`/`actions` columns) — no existing caller shape changes.
- **Файл для теста:** `tests/tasksCreateActions.test.js`

### TC-OPC-U04: `startRobotCall` — slots present → store top-1 `slot_json` + insert ONE `pending` attempt (immediate `scheduled_at`)
- **Приоритет:** P0
- **Тип:** Unit
- **Связанный сценарий:** S2; FR-5; §6
- **Предусловия:** `recommendSlots` mocked → `{available:true, slots:[{key,date,start,end,label}]}`; `isAppConnected` → true; no existing active attempt.
- **Ожидаемый результат:** an `INSERT INTO outbound_call_attempts` with `status='pending'`, `scheduled_at<=now()`, `slot_json`=the top-1 slot, `job_id`/`task_id`/`contact_id`/`phone` resolved from the job; `outboundCallService.placeCall` is **NOT** called synchronously (worker dials, not `startRobotCall`).
- **Файл для теста:** `tests/partsCallService.test.js`

### TC-OPC-U05: `startRobotCall` — v1 company gate short-circuits a non-default company
- **Приоритет:** P1
- **Тип:** Unit
- **Связанный сценарий:** §C1 v1 gate; §8; NFR isolation
- **Входные данные:** `startRobotCall(companyId = 'some-other-company', taskId)`.
- **Ожидаемый результат:** short-circuit (or `enabled=false` via `outboundCallSettings.resolve`) → no `recommendSlots`, no attempt row, no dial. Code path stays parameterized on `job.company_id` (assert the guard reads companyId, not a hardcode).
- **Файл для теста:** `tests/partsCallService.test.js`

### TC-OPC-U06: `startRobotCall` — no slots (`available:false`/`fallback:true`) → NO call, NO attempt, task reason + action `state:'failed'`
- **Приоритет:** P0
- **Тип:** Unit
- **Связанный сценарий:** S6; FR-9; AC-6; edge-2
- **Предусловия:** `recommendSlots` mocked → `{available:false, slots:[], fallback:true}`.
- **Ожидаемый результат:** **no** `INSERT INTO outbound_call_attempts`, **no** `placeCall`, no job status change; a task update writes a human-readable reason + dispatcher action; the `robot_call` action's `state` set to `'failed'` with the reason. Same branch when `recommendSlots` **throws** (safe-fail).
- **Файл для теста:** `tests/partsCallService.test.js`

### TC-OPC-U07: `startRobotCall` — job has no phone / no contact → NO call, task reason "no reachable number"
- **Приоритет:** P2
- **Тип:** Unit
- **Связанный сценарий:** edge-1; FR-9 analogue
- **Предусловия:** job lookup returns `phone=null`.
- **Ожидаемый результат:** no `recommendSlots` dial path taken; no attempt row; task reason "no reachable number"; job unchanged.
- **Файл для теста:** `tests/partsCallService.test.js`

### TC-OPC-U08: `outboundCallService.placeCall` — correct VAPI request contract
- **Приоритет:** P0
- **Тип:** Unit (mocked fetch)
- **Связанный сценарий:** S2; FR-5d; §4; Decision D; OQ-3
- **Предусловия:** `fetch`/http seam mocked to capture the request and return `{ id:'vapi_call_x' }`. Env `VAPI_API_KEY`, `VAPI_OUTBOUND_ASSISTANT_ID`, `VAPI_OUTBOUND_PHONE_NUMBER_ID` set.
- **Входные данные:** `placeCall({companyId:A, jobId, contactId, phone:'+1617…', customerName:'Jane', slot:{date,start,end,label}})`.
- **Ожидаемый результат:** POST to `https://api.vapi.ai/call`, header `Authorization: Bearer <VAPI_API_KEY>`; body `{ assistantId:<VAPI_OUTBOUND_ASSISTANT_ID>, phoneNumberId:<VAPI_OUTBOUND_PHONE_NUMBER_ID>, customer:{number:'+1617…'}, assistantOverrides:{ variableValues:{ jobId, contactId, customerName, companyId, slotLabel, slotDate, slotStart, slotEnd } } }`; returns the VAPI `call.id` for the caller to store. Assert `phoneNumberId` comes from env, not a literal.
- **Файл для теста:** `tests/outboundCallService.test.js`

### TC-OPC-U09: `outboundCallWorker` — claims only `pending && scheduled_at<=now()` with `FOR UPDATE SKIP LOCKED`
- **Приоритет:** P1
- **Тип:** Unit (mocked db)
- **Связанный сценарий:** S2/S4; FR-13; §6 (agentWorker claim pattern)
- **Ожидаемый результат:** the claim `UPDATE` filters `status='pending' AND scheduled_at<=now()` and uses `FOR UPDATE SKIP LOCKED`; a claimed in-hours row → `status='dialing'` + `placeCall` + store `vapi_call_id`. A row `scheduled_at` in the future is NOT claimed.
- **Файл для теста:** `tests/outboundCallWorker.test.js`

### TC-OPC-U10: `outboundCallWorker` — outside business hours → push `scheduled_at`, do NOT dial
- **Приоритет:** P0
- **Тип:** Unit (mocked db + `groupRouting.isBusinessHours`)
- **Связанный сценарий:** S4; FR-10 clamp; NFR business-hours
- **Предусловия:** `isBusinessHours(group, now)` mocked → false.
- **Ожидаемый результат:** the claimed row's `scheduled_at` is pushed to the next open time; **no** `placeCall`; `status` stays `pending` (not `dialing`). No call outside business hours (hard rule).
- **Файл для теста:** `tests/outboundCallWorker.test.js`

### TC-OPC-U11: `outboundCallWorker` — a thrown `placeCall` is an isolated failed attempt (feeds retry), never corrupts job state
- **Приоритет:** P1
- **Тип:** Unit
- **Связанный сценарий:** S4; FR-13 fail-safe; error-handling §
- **Предусловия:** `placeCall` mocked to throw.
- **Ожидаемый результат:** the per-row `try/catch` marks that attempt failed (feeds the retry classifier) and continues; no exception escapes the tick; the job row is not mutated by the worker.
- **Файл для теста:** `tests/outboundCallWorker.test.js`

### TC-OPC-U12: `confirmPartsVisit` — ownership pre-check: contact match → proceed; mismatch/foreign → safe refusal, NO write
- **Приоритет:** P0
- **Тип:** Unit (mocked deps)
- **Связанный сценарий:** S10; Deviation 1; §5.1; mirrors `rescheduleAppointment.js:174–182`
- **Входные данные:** (a) `getJobById(jobId,A)` returns job whose `contact_id` === `variableValues.contactId` → proceed; (b) job's `contact_id` ≠ `contactId` (or job belongs to company B) → refuse.
- **Ожидаемый результат:** (a) proceeds to `rescheduleItem`; (b) returns a safe refusal, **no** `rescheduleItem`, **no** `updateBlancStatus`, **no** note, **no** task-close. Runs at `requiredLevel:'L0'` but is NOT gated behind the inbound `verificationGate` (Deviation 1).
- **Файл для теста:** `tests/confirmPartsVisit.test.js`

### TC-OPC-U13: `confirmPartsVisit` — confirmed-slot guard rejects malformed `{date,start,end}` (soft refusal, no write)
- **Приоритет:** P1
- **Тип:** Unit
- **Связанный сценарий:** S8/edge-9; §5.2; reuse `isConfirmedSlot`
- **Входные данные:** parametrize — bad date `2026/07/07`, bad start `25:99`, and `slot.end < slot.start`.
- **Ожидаемый результат:** each → soft refusal, no `rescheduleItem`, no status flip. `arrival_window_minutes = end − start` is only derived once the slot passes the guard (OQ-4).
- **Файл для теста:** `tests/confirmPartsVisit.test.js`

### TC-OPC-U14: `confirmPartsVisit` — success order: `rescheduleItem` FIRST, THEN `updateBlancStatus('Rescheduled')`, THEN note + task-close
- **Приоритет:** P0
- **Тип:** Unit (call-order)
- **Связанный сценарий:** S2; FR-8; §5.3–5.5; AC-3
- **Предусловия:** capture the ordered mock call sequence; `rescheduleItem` resolves ok.
- **Ожидаемый результат:** call order is exactly `getJobById` → `rescheduleItem(companyId,'job',jobId,newStartAt,newEndAt)` → `updateBlancStatus(jobId,'Rescheduled',companyId)` → `addNote(jobId, "...via AI Phone.", [], 'AI Phone','AI Phone')` + `eventService.logEvent(..., 'system')` → `updateTask(companyId, taskId, {status:'done'})`. Any flip BEFORE a resolved reschedule = FAIL. Note/event are guarded (a note throw does not fail the landed booking).
- **Файл для теста:** `tests/confirmPartsVisit.test.js`

### TC-OPC-U15: Action route — unknown `:type` → 400 (no handler invoked)
- **Приоритет:** P1
- **Тип:** Unit (route, db mocked)
- **Связанный сценарий:** S11; AC-10
- **Входные данные:** `POST /api/tasks/:id/actions/frobnicate`.
- **Ожидаемый результат:** 400; the registry lookup misses → no `robot_call`/`manual_call` handler runs; response carries an "unknown action type" error, no stack leak.
- **Файл для теста:** `tests/tasksActionsRoute.test.js`

### TC-OPC-U16: Action route — auth/permission: 401 no token, 403 without `tasks.manage`
- **Приоритет:** P0
- **Тип:** Unit (route middleware)
- **Связанный сценарий:** S12; AC-10; §8; middleware canon
- **Ожидаемый результат:** no/invalid token → **401** (before any handler); authenticated but `req.authz` lacks `tasks.manage` → **403**; in neither case does a registry handler run. Confirms the route is gated `authenticate + requireCompanyAccess + requirePermission('tasks.manage')`.
- **Файл для теста:** `tests/tasksActionsRoute.test.js`

### TC-OPC-U17: Action route — `manual_call` is a pure no-op returning `{ client:'openDialer', phone, contactName }` (no mutation)
- **Приоритет:** P1
- **Тип:** Unit (route)
- **Связанный сценарий:** S7; FR-14; §A2/A3
- **Ожидаемый результат:** 200 `{ ok:true, state, client:'openDialer', phone, contactName }` (resolved from the job's customer); **no** DB mutation, **no** attempt row, **no** status change. (An optional audit event is allowed but not required.)
- **Файл для теста:** `tests/tasksActionsRoute.test.js`

### TC-OPC-U18: `call-status` webhook classifier — `endedReason` → correct attempt next-state (table-driven)
- **Приоритет:** P0
- **Тип:** Unit (parametrized, mocked db)
- **Связанный сценарий:** S9; FR-10…12; OQ-1; §6
- **Входные данные:** parametrize `endedReason`: `assistant booked/success`→terminal `booked`; `customer-did-not-answer`→`no_answer`+retry; `customer-busy`→`no_answer`+retry; `voicemail`→`voicemail`+retry; `assistant-forwarded`/hang-up/`failed-to-place`→`failed`+retry; `customer-declined-all`→retry (owner default).
- **Ожидаемый результат:** each maps to the stated attempt status; transient → schedules the next attempt AND writes a per-attempt job note via `addNote(…, 'AI Phone')` + a domain event; terminal `booked` → no retry. company_id is read from the **correlated attempt row** (looked up by `vapi_call_id`), never from the body.
- **Файл для теста:** `tests/vapiCallStatusWebhook.test.js`

---

## 2. Integration — real DB, `scripts/verify-outbound-parts-call-001.js` (VAPI + ZB stubbed only)

All cases run the REAL services/routes/worker/skill/FSM against seeded Postgres, self-seeding/self-cleaning with tag `OPC1`. Every case is also re-run once against a prod-copy restore before deploy (requirements §"Verify against a real DB / real ZB") — owner-consent-gated.

### TC-OPC-I01 (fsm): **FSM-MIG-156 P0** — after mig 156, `Part arrived` is a valid state; `Waiting→Part arrived` (blanc:action) + `Part arrived→{Rescheduled,Canceled,Follow Up}` allowed; invalid rejected
- **Приоритет:** **P0 (must-pass)**
- **Тип:** Integration (FSM)
- **Связанный сценарий:** FR-1; AC-1; §1; models `127_job_fsm_on_the_way.sql`
- **Предусловия:** apply mig 156 against seeded `fsm_machines`/`fsm_versions` for company A; a fresh published version with a bumped `version_number` and repointed `active_version_id`.
- **Шаги:** 1) run mig 156 (idempotency guard `WHERE v.scxml_source NOT LIKE '%id="Part_arrived"%'`); 2) `fsmService.resolveTransition(A,'job', currentState, target)` for each transition; 3) re-run mig 156.
- **Ожидаемый результат:** published SCXML now contains `<state id="Part_arrived" blanc:label="Part arrived" blanc:statusName="Part arrived">` with `TO_RESCHEDULED/TO_CANCELED/TO_FOLLOW_UP` transitions AND a `TO_PART_ARRIVED` (`blanc:action="true"`) child of `Waiting_for_parts`; `resolveTransition` **accepts** `Waiting for parts→Part arrived`, `Part arrived→Rescheduled`, `Part arrived→Canceled`, `Part arrived→Follow Up with Client`; **rejects** an invalid target (e.g. `Part arrived→Completed`). Re-running mig 156 is a no-op (guard trips, `RAISE NOTICE`). The hardcoded `ALLOWED_TRANSITIONS` fallback carries the same edges.
- **Файл для теста:** `scripts/verify-outbound-parts-call-001.js` (section fsm)

### TC-OPC-I02 (s1): **S1 P0** — real `updateBlancStatus('Part arrived')` fires the hook → exactly ONE open `part_arrived_call` task with 2 actions
- **Приоритет:** **P0 (must-pass — idempotence gate)**
- **Тип:** Integration
- **Связанный сценарий:** S1; FR-2/FR-3; AC-2; §B2/B3
- **Предусловия:** job J in `Waiting for parts`, company A, real customer contact.
- **Шаги:** 1) `updateBlancStatus(J,'Part arrived',A)` (or `PATCH /api/jobs/:id/status`); 2) await the fire-and-forget hook to settle; 3) query tasks for J.
- **Ожидаемый результат:** exactly **one** open task, `job_id=J`, `kind='part_arrived_call'`, `status='open'`, `actions` jsonb = `[robot_call, manual_call]`, title contains the customer name; surfaces as Action Required (open task on a job parent, AR-TASK-UNIFY-001). `job.blanc_status='Part arrived'`. No new lead/job (D7).
- **Файл для теста:** `scripts/verify-outbound-parts-call-001.js` (section s1)

### TC-OPC-I03 (s1): **S1 idempotence** — re-enter `Part arrived` (and a duplicate event) → NO second open task
- **Приоритет:** **P0 (must-pass)**
- **Тип:** Integration
- **Связанный сценарий:** S1 idempotency; FR-3; §B3 SELECT-guard
- **Шаги:** with J already `Part arrived` + its open task, 1) call `updateBlancStatus(J,'Part arrived',A)` a second time; 2) directly call `onPartArrived(J,A)` again (simulate a duplicate event).
- **Ожидаемый результат:** the open-task count for J stays **1** (the `SELECT 1 … status='open'` guard hits, `createTask` not invoked); no duplicate row, no error. (Edge-3: a task already **Done** no longer blocks — a fresh open task IS created when re-entering; asserted as a sub-case.)
- **Файл для теста:** `scripts/verify-outbound-parts-call-001.js` (section s1)

### TC-OPC-I04 (s13): **S13 P0 FAIL-SAFE** — `onPartArrived` throws → the `Part arrived` transition STILL commits
- **Приоритет:** **P0 (must-pass — fail-safe gate)**
- **Тип:** Integration (fault-injection)
- **Связанный сценарий:** S13; FR-2; AC-11; NFR fail-safe
- **Предусловия:** inject a fault into `onPartArrived` (a section flag monkeypatching `partsCallService.onPartArrived` to throw, or forcing `createTask` to fault).
- **Шаги:** `updateBlancStatus(J,'Part arrived',A)` with the injected throw; await settle.
- **Ожидаемый результат:** `SELECT blanc_status FROM jobs WHERE id=J` → **`'Part arrived'`** (the transition committed; the thrown hook was swallowed by its own `try/catch` + `.catch`); no exception propagated to the caller; the auto-task is simply absent (a later re-entry retries the SELECT-guard). The transition is **NEVER** rolled back. **Sabotage inversion (in `sab`):** remove the hook's `try/catch` → the throw must now surface / roll back → the harness records the fail-safe as RED, proving the assertion is live.
- **Файл для теста:** `scripts/verify-outbound-parts-call-001.js` (section s13)

### TC-OPC-I05 (s2): **S2 P0 HAPPY PATH** — `robot_call` → attempt enqueued → worker dials (VAPI stub) → `confirmPartsVisit` → reschedule(+ZB) + flip Rescheduled + note + task Done + attempt `booked`
- **Приоритет:** **P0 (must-pass — happy path)**
- **Тип:** Integration
- **Связанный сценарий:** S2; FR-5/FR-8; AC-3; §C/§5
- **Предусловия:** ZB-linked job J (`zenbooker_job_id` set) in `Part arrived` + its open task; `smart-slot-engine` connected (or `recommendSlots` stubbed to a valid top-1 slot); VAPI `placeCall` stubbed → `{id:'vapi_call_s2'}`; ZB stub records `rescheduleJob`.
- **Шаги:** 1) `POST /api/tasks/:id/actions/robot_call` → assert a `pending` attempt with `slot_json`; 2) run one `outboundCallWorker` tick (in business hours) → attempt `dialing`, VAPI stub recorded, `vapi_call_id` stored; 3) invoke `confirmPartsVisit` via `agentSkills.runSkill` with the confirmed slot (simulating the in-call tool); 4) POST `/api/vapi/call-status` with `booked`.
- **Ожидаемый результат:** `rescheduleItem` mutated the SAME job J (start/end updated, no new job), ZB stub `rescheduleJob` called once with `start_date` ISO + `arrival_window_minutes = end−start` (OQ-4); `job.blanc_status='Rescheduled'`; an `addNote` "…via AI Phone." + a `job_rescheduled` event exist; the `part_arrived_call` task is `status='done'`; the attempt row is `booked`. VAPI stub confirms the request never left the process.
- **Файл для теста:** `scripts/verify-outbound-parts-call-001.js` (section s2)

### TC-OPC-I06 (s14): **S14 P0 DUP-CALL** — double `robot_call` while an attempt is `pending`/`dialing` → ONE call, 2nd → in-flight-existing (partial-unique proven on real DB)
- **Приоритет:** **P0 (must-pass — dup-call gate)**
- **Тип:** Integration
- **Связанный сценарий:** S14; FR-TA4; OQ-5; §C2
- **Предусловия:** job J with its open task; first `robot_call` created a `pending` attempt (VAPI not yet dialed).
- **Шаги:** press `robot_call` a **second** time (and a third) via the route.
- **Ожидаемый результат:** the partial-unique index `(job_id) WHERE status IN ('pending','dialing')` blocks a second active row → exactly **one** active attempt for J (`SELECT count(*) … WHERE job_id=J AND status IN('pending','dialing')` = 1); the route returns `state:'in_flight_existing'` (graceful, no 500 leaking the unique violation). **This is exactly what a mocked jest cannot prove** — the real index is what enforces it.
- **Файл для теста:** `scripts/verify-outbound-parts-call-001.js` (section s14)

### TC-OPC-I07 (s6): **S6 P0 NO-CALL** — no slots / engine error BEFORE call → NO attempt row, NO VAPI call, task reason + action `state:'failed'`, job unchanged
- **Приоритет:** **P0 (must-pass — no-call gate)**
- **Тип:** Integration
- **Связанный сценарий:** S6; FR-9; AC-6; edge-2
- **Предусловия:** job J in `Part arrived` + open task; `recommendSlots` returns `{available:false,fallback:true}` (and a sub-case where it throws / the `smart-slot-engine` app is disconnected).
- **Шаги:** `POST /api/tasks/:id/actions/robot_call`.
- **Ожидаемый результат:** `SELECT count(*) FROM outbound_call_attempts WHERE job_id=J` → **0** (no dialing attempt inserted); VAPI stub `placeCall` **never** called; task stays open with a human-readable reason + dispatcher action written; the `robot_call` action `state='failed'`; `job.blanc_status` still `'Part arrived'` (unchanged).
- **Файл для теста:** `scripts/verify-outbound-parts-call-001.js` (section s6)

### TC-OPC-I08 (s8): **S8 P0 ZB-409** — reschedule FIRST then flip; ZB `rescheduleJob` throws 409 → status NOT flipped, task NOT closed, attempt NOT `booked`, no false success
- **Приоритет:** **P0 (must-pass — no-false-success gate)**
- **Тип:** Integration
- **Связанный сценарий:** S8; FR-8; §5.2; edge-4; mirrors `rescheduleAppointment.js:206–221`
- **Предусловия:** ZB-linked job J in `Part arrived` + open task; ZB stub `_throwReschedule = { statusCode:409 }`.
- **Шаги:** invoke `confirmPartsVisit` with a valid confirmed slot.
- **Ожидаемый результат:** the skill returns `{ ok:false, success:false, conflict:true, speak:'…teammate…' }`; `job.blanc_status` is **still `'Part arrived'`** (NOT flipped — the flip is downstream of a resolved reschedule); the `part_arrived_call` task is **still `open`** (NOT `done`); no "via AI Phone" reschedule note claiming success; the attempt is **NOT** `booked`. State is recoverable, nothing falsely committed.
- **Файл для теста:** `scripts/verify-outbound-parts-call-001.js` (section s8)

### TC-OPC-I09 (s3): S3 decline → live `recommendSlots` alternatives → book identically to S2
- **Приоритет:** P1
- **Тип:** Integration
- **Связанный сценарий:** S3; FR-7; AC-4
- **Предусловия:** as S2 but the first offered slot is declined; the in-call tool re-pulls `recommendSlots` (live) returning 2–3 alternatives; customer picks one.
- **Шаги:** invoke `recommendSlots` via the skill (live), then `confirmPartsVisit` with the chosen `{date,start,end}`.
- **Ожидаемый результат:** identical terminal state to TC-OPC-I05 — job J rescheduled (Albusto + ZB), status `Rescheduled`, note + event, task `done`, attempt `booked`. Confirms the decline branch reuses the EXISTING `recommendSlots` skill verbatim (no re-implementation).
- **Файл для теста:** `scripts/verify-outbound-parts-call-001.js` (section s3)

### TC-OPC-I10 (s4): S4 no-answer → per-attempt job note + retry schedule (immediate / +2h / next-biz-morning), business-hours clamp
- **Приоритет:** P1
- **Тип:** Integration
- **Связанный сценарий:** S4; FR-10/FR-11; AC-5; OQ-1
- **Предусловия:** job J with a `dialing` attempt (attempt_no=1); `outbound_call_settings` default (`max_attempts=3`, backoff `["immediate","+2h","next_business_morning"]`, `next_morning_hour=9`); business hours seeded for the company group/tz.
- **Шаги:** POST `/api/vapi/call-status` with `customer-did-not-answer` for attempt 1, then again for attempt 2.
- **Ожидаемый результат:** attempt 1 → `no_answer`; a job note ("tried to reach {name}, no answer — next attempt at {time}") + a domain event exist; a NEW attempt row scheduled at `+2h`; attempt 3 scheduled `next_morning_hour` (09:00) company-local, clamped into business hours. Each attempt writes exactly one note. All timing is company-tz-aware (commit 6d5975a discipline).
- **Файл для теста:** `scripts/verify-outbound-parts-call-001.js` (section s4)

### TC-OPC-I11 (s5): S5 exhaustion after ×3 → attempt `exhausted`, task stays open with dispatcher, job stays `Part arrived` (no flip)
- **Приоритет:** P1
- **Тип:** Integration
- **Связанный сценарий:** S5; FR-12; AC-5
- **Предусловия:** job J on its 3rd attempt (`attempt_no=3`), `max_attempts=3`.
- **Шаги:** POST `/api/vapi/call-status` with `customer-did-not-answer` for attempt 3.
- **Ожидаемый результат:** the attempt is marked `exhausted`; a final job note "automated attempts exhausted — please follow up" + event; **no further attempt row** for J; the `part_arrived_call` task is **still `open`**; `job.blanc_status` **still `'Part arrived'`** (no flip). Dispatcher owns it.
- **Файл для теста:** `scripts/verify-outbound-parts-call-001.js` (section s5)

### TC-OPC-I12 (s9): S9 webhook idempotence — a duplicate end-of-call webhook for a terminal `call.id` is a no-op
- **Приоритет:** P1
- **Тип:** Integration
- **Связанный сценарий:** S9; edge-6; §6
- **Предусловия:** an attempt already `booked` (terminal) for `vapi_call_id='vapi_call_dup'`.
- **Шаги:** POST `/api/vapi/call-status` twice with the same `booked` payload.
- **Ожидаемый результат:** the second POST is a no-op (a `booked`/`exhausted` attempt is terminal) — no second note, no second retry, no duplicate event; response `200 {ok:true}`. Also asserts an **unknown `call.id`** → `200` no-op (don't leak).
- **Файл для теста:** `scripts/verify-outbound-parts-call-001.js` (section s9)

### TC-OPC-I13 (s10): **S10 P0 SECURITY** — foreign task/job id → 404 (route + in-skill), not 403; no cross-tenant read/write
- **Приоритет:** **P0 (must-pass — security)**
- **Тип:** Integration (Security)
- **Связанный сценарий:** S10; AC-10/AC-11; §8; ZB-ISO-001 / tenant-isolation precedents
- **Предусловия:** company B (tagged, created here) owns job JB + its `part_arrived_call` task TB. The route + skill are exercised with `req.companyFilter={company_id:A}` / `variableValues.companyId=A`.
- **Шаги:** 1) `POST /api/tasks/TB/actions/robot_call` scoped to A; 2) `confirmPartsVisit({jobId:JB, contactId:<B's>, companyId:A})`.
- **Ожидаемый результат:** (1) the task loads WHERE `company_id=A` → **404** (foreign id, NOT 403, no leak); no attempt row created for JB. (2) in-skill `getJobById(JB, A)` → no match → **safe refusal**, no `rescheduleItem`, no status flip, no write. Company B's job/task/attempt rows are byte-unchanged. No B row is read, moved, or deleted by any leg.
- **Файл для теста:** `scripts/verify-outbound-parts-call-001.js` (section s10)

### TC-OPC-I14 (s10): **S10 webhook company-from-row** — `call-status` derives company_id from the correlated attempt row, NEVER the body
- **Приоритет:** **P0 (must-pass — security)**
- **Тип:** Integration (Security)
- **Связанный сценарий:** S10; §8 data-isolation; OQ-5
- **Предусловия:** an attempt row for company A with `vapi_call_id='vc_iso'`.
- **Шаги:** POST `/api/vapi/call-status` with `call.id='vc_iso'` but a **spoofed** `companyId=B` (or a B-tagged field) embedded in the body.
- **Ожидаемый результат:** every write (note, event, retry) is scoped to company **A** (from the correlated attempt row) — the spoofed body company is **ignored**; no B-scoped row is touched. Secret-auth verified first; a bad secret → reject.
- **Файл для теста:** `scripts/verify-outbound-parts-call-001.js` (section s10)

### TC-OPC-I15 (s10): Webhook secret-auth — missing/wrong shared secret → rejected (no session)
- **Приоритет:** P1
- **Тип:** Integration (Security)
- **Связанный сценарий:** S9/S10; §8; error-handling "webhook auth failure → reject"
- **Шаги:** POST `/api/vapi/call-status` with no secret header, then a wrong secret.
- **Ожидаемый результат:** both rejected (401/403 per the secret-auth contract); no attempt mutated; the route is NOT gated by a user session (a valid session without the secret still fails).
- **Файл для теста:** `scripts/verify-outbound-parts-call-001.js` (section s10)

### TC-OPC-I16 (s5): Worker skips a row whose job/task was Canceled meanwhile → attempt `canceled`, no dial
- **Приоритет:** P2
- **Тип:** Integration
- **Связанный сценарий:** edge-5; §6
- **Предусловия:** a `pending` attempt whose job was moved to `Canceled` (a valid FSM state) after enqueue.
- **Шаги:** run one worker tick.
- **Ожидаемый результат:** the worker skips + marks the attempt `canceled`; VAPI `placeCall` never called; the job stays in its (valid) Canceled state; no dial, no error.
- **Файл для теста:** `scripts/verify-outbound-parts-call-001.js` (section s4)

### TC-OPC-I17 (s2): `outbound_call_settings.resolve` — no row → safe defaults (never 500); Boston-Masters row overrides
- **Приоритет:** P2
- **Тип:** Integration
- **Связанный сценарий:** PART D; FR-10 configurable; §7 (mirrors REC-SETTINGS-001)
- **Шаги:** call `resolve(companyWithNoRow)` then `resolve(A)` after seeding an A row `{max_attempts:2}`.
- **Ожидаемый результат:** no-row → `{max_attempts:3, backoff:["immediate","+2h","next_business_morning"], next_morning_hour:9, enabled:true}` (defaults, no throw); A row → the seeded overrides drive the retry count/backoff. Code reads by `job.company_id`.
- **Файл для теста:** `scripts/verify-outbound-parts-call-001.js` (section s2)

### TC-OPC-I18 (s2): `rescheduleItem` AR-4 ZB write-through regression — same-job mutate + `zenbookerClient.rescheduleJob` fires (dependency verified on real DB)
- **Приоритет:** P1
- **Тип:** Integration (dependency / regression)
- **Связанный сценарий:** FR-8; Deviation 3; `scheduleService.js:240`; AGENT-SKILLS-001 AR-4
- **Предусловия:** ZB-linked job J; ZB stub records `rescheduleJob`.
- **Шаги:** `confirmPartsVisit` success path (or a direct `rescheduleItem(A,'job',J,start,end)`).
- **Ожидаемый результат:** the SAME job J is mutated (no new job); ZB stub `rescheduleJob(zbId, {start_date ISO, arrival_window_minutes})` called exactly once; a non-ZB-linked / canceled / non-'job' target does NOT push ZB (guards intact — from `scheduleServiceRescheduleZb.test.js` contract). Confirms the FR-8 dependency is satisfied, not forked.
- **Файл для теста:** `scripts/verify-outbound-parts-call-001.js` (section s2)

### TC-OPC-ISAB (sab): Sabotage negative control — deliberately break one expectation per P0 gate, confirm the harness FAILs, then restore
- **Приоритет:** P0
- **Тип:** Integration (self-check — mirrors `verify-agent-skills-002.js` sabotage kit)
- **Связанный сценарий:** harness integrity (LIST-PAGINATION-001 "a green run must certify the detector works")
- **Шаги:** via `sabotageTrips`, assert a deliberately-wrong expectation for each gate: (a) S13 — assert the job did NOT stay `Part arrived` after a thrown hook (it did); (b) S14 — assert two active attempts exist (only one does); (c) S8 — assert the status flipped to `Rescheduled` on a ZB 409 (it did not); (d) S10 — assert the foreign task returned 200 (it returned 404). Then restore the correct expectations and re-assert green.
- **Ожидаемый результат:** every sabotaged assertion trips a `CheckError` (records **FAIL**), proving the detectors inspect real state. If any sabotage does NOT trip, this case fails — that detector is broken and its PASS is suspect.
- **Файл для теста:** `scripts/verify-outbound-parts-call-001.js` (section sab)

---

## 3. Frontend — manual + build (no FE harness; `TaskCard.tsx`, `tasksApi.ts`, `SoftPhoneContext`)

### TC-OPC-F01: TaskCard renders one `<Button>` per `actions[]` entry, in addition to Done/Cancel/Reopen
- **Приоритет:** P1
- **Тип:** Frontend (manual)
- **Связанный сценарий:** FR-TA3; AC-10; §A4; FORM-CANON / Blanc canon
- **Шаги:** open a `part_arrived_call` task with `actions=[robot_call, manual_call]`.
- **Ожидаемый результат:** two extra buttons render — "🤖 Let the robot call" + "📞 I'll call myself" (label + optional lucide icon), alongside the existing Done/Cancel/Reopen; no hardcoded per-feature buttons; existing `<Button>` variants, no new surfaces. A task with `actions=null` renders exactly as today (backward compatible).
- **Файл для теста:** manual / dev-preview

### TC-OPC-F02: `robot_call` button → `runTaskAction`, spinner + disabled while in-flight, reflects returned `state`
- **Приоритет:** P1
- **Тип:** Frontend (manual + network)
- **Связанный сценарий:** FR-TA3/FR-TA4; §A4
- **Шаги:** press "Let the robot call"; observe the `POST /api/tasks/:id/actions/robot_call` request and the button.
- **Ожидаемый результат:** the button shows a spinner + disables while in-flight; on `state:'in_flight'|'queued'` it reflects that; a second press while in-flight does not fire a second request (or returns `in_flight_existing` gracefully); on `state:'failed'` (S6) it shows the failed reason.
- **Файл для теста:** manual / dev-preview + Network tab

### TC-OPC-F03: `manual_call` → desktop `openDialer(phone, contactName)`; mobile native `tel:`
- **Приоритет:** P1
- **Тип:** Frontend (manual)
- **Связанный сценарий:** S7; FR-14; AC-7; MOBILE-NO-SOFTPHONE-001; `SoftPhoneContext.tsx:18,46`
- **Шаги:** desktop — press "I'll call myself"; mobile — same.
- **Ожидаемый результат:** desktop opens the softphone pre-filled with the customer number + name via `useSoftPhone().openDialer(phone, contactName)`; mobile opens a native `tel:` link (no softphone); no robot, no status change on press. No backend mutation required for the dial.
- **Файл для теста:** manual / dev-preview (desktop + mobile viewport)

### TC-OPC-F04: `Part arrived` dispatcher transition button on the job-card status control (from the published SCXML `blanc:action`)
- **Приоритет:** P2
- **Тип:** Frontend (manual)
- **Связанный сценарий:** Deviation 5; §1; AC-1
- **Шаги:** on a job in `Waiting for parts` (company A, post-mig-156), open the status control.
- **Ожидаемый результат:** a "Part arrived" transition option is offered (reads the published machine's `TO_PART_ARRIVED blanc:action="true"` transition); selecting it moves the job → triggers the auto-task. No separate frontend change beyond reading the machine.
- **Файл для теста:** manual / dev-preview

### TC-OPC-F05: End-to-end smoke — press robot_call, see task auto-close + status Rescheduled after a booked call
- **Приоритет:** P2
- **Тип:** Frontend (manual E2E, staging/dev with VAPI test assistant — owner-gated)
- **Связанный сценарий:** S2; AC-3
- **Шаги:** with the outbound worker + a test VAPI assistant, press robot_call, let a test call book.
- **Ожидаемый результат:** the task moves to Done, the job shows `Rescheduled`, an "AI Phone" note appears on the job timeline. (Owner-consent-gated — not part of the automated pipeline.)
- **Файл для теста:** manual / staging

### TC-OPC-F06: Build stays green
- **Приоритет:** P3
- **Тип:** Frontend (build)
- **Связанный сценарий:** ship gate (frontend-build-command: `npm run build`, stricter than `tsc --noEmit`, noUnusedLocals)
- **Шаги:** `cd frontend && npm run build`.
- **Ожидаемый результат:** exit 0; `tasksApi.runTaskAction(id, type)` typed; `Task` type exposes `actions?: TaskAction[]`; no unused-locals error.
- **Файл для теста:** build

---

## Regression / Protected (must stay green)

- **TC-R-1 (P0):** **Inbound path untouched** — `vapi-tools.js` auth/envelope/single-tenant contract + the live Sara assistant (`30e85a87`) unchanged; this feature only ADDS `confirmPartsVisit` to the registry and a NEW outbound assistant. Existing `agentSkills*`/`vapi-tools` tests stay 100% green (VAPI-Sara memory: re-inject `VAPI_TOOLS_SECRET` on every model write).
- **TC-R-2 (P1):** `scheduleService.rescheduleItem` existing contract (`scheduleServiceRescheduleZb.test.js`) — same-job mutate, skip-if-not-linked/canceled/non-'job', `forceSyncOnZbError` 409-with-recovery, NOT_FOUND 404 — all preserved; the outbound skill is a new caller, not a fork.
- **TC-R-3 (P1):** Tasks schema/RBAC/`HAS_ENTITY_PARENT`/`scopeOwnerId`, TASKS-COUNT-BADGE-001 count query, AR-TASK-UNIFY-001 coupling — `tasks.actions` is additive + nullable, ignored by every existing query (existing `tasksCount.test.js` / `orphanTaskRehome.test.js` stay green).
- **TC-R-4 (P1):** `updateBlancStatus` existing branches / `OUTBOUND_MAP` / ZB sync block / FSM dual-source fallback unchanged; the hook is an additive fire-and-forget line (existing `jobsStatusUpdate.test.js` / `jobsStatusRbac.test.js` stay green).
- **TC-R-5 (P2):** `src/server.js` mount order/wiring unchanged — only an additive `outboundCallWorker.start()` line, env-gated `FEATURE_OUTBOUND_CALL_WORKER` (off by default in tests); other schedulers (inbox/agent/rules/overage/routeRetention) still bootstrap identically.
- **TC-R-6 (P2):** Softphone canon — desktop-only (MOBILE-NO-SOFTPHONE-001); the intentional warm-up modal stays; `answerOnBridge="true"` untouched; `openDialer` signature `(phone, contactName?)` unchanged.
- **TC-R-7 (P3):** Migrations 156–159 are the ONLY new ones; each idempotent with rollback + logged row count; re-verify max = 155 before applying (parallel-dialogs renumber rule). No existing migration altered.
- **TC-R-8 (P3):** No new lead/job created by any path (D7, AC-9) — assert `leads`/`jobs` counts for the tagged fixtures are unchanged by the whole robot lifecycle beyond the single reschedule of the existing job.
