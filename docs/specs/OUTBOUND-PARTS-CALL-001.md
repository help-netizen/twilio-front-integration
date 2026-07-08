# Spec: OUTBOUND-PARTS-CALL-001 — Outbound VAPI "part arrived → book the finish visit," driven by a Task with typed action buttons (+ TASK-ACTIONS sub-component)

**Status:** Spec (SpecWriter / Agent-03) · **Priority:** P1 · **Owner:** Voice / CRM / Dispatch
**Requirements:** `Docs/requirements.md` → `## OUTBOUND-PARTS-CALL-001` (D1–D7, FR-TA1…4, FR-1…14, AC-1…12, OQ-1…5).
**Architecture:** `Docs/architecture.md` → `## OUTBOUND-PARTS-CALL-001` (§0–§11; Decisions A–F implicit in §1–§7; OQ-resolutions §10; Deviations §11 — **all binding**).
**Scope of v1:** Boston Masters only (`DEFAULT_COMPANY_ID = 00000000-0000-0000-0000-000000000001`); **all** server code is company-scoped (companyId flows from `job.company_id`, never a blind hardcode) and gated to the default company at the dial seam.

This spec describes **behavior**, not code. It composes existing, shipped pieces: the Tasks model (TASKS-001 / AR-TASK-UNIFY-001), the provider-neutral skill layer (AGENT-SKILLS-001/002), the slot engine (VAPI-SLOT-ENGINE-001 / `recommendSlots`), `scheduleService.rescheduleItem` (with its AR-4 Zenbooker write-through, **verified present** — `scheduleService.js:240` calls `zenbookerClient.rescheduleJob`), and the softphone (`SoftPhoneContext.openDialer`). Genuinely new: a `Part arrived` status + FSM, a reusable **TASK-ACTIONS** layer, and an **outbound** VAPI capability (call trigger + retry-aware worker + a NEW outbound assistant).

---

## 0. Terms & the end-to-end shape

- **`Part arrived`** — a new Albusto-only job status. No Zenbooker action (operational state, like `Waiting for parts`).
- **Auto-task** — exactly one open task (`kind='part_arrived_call'`, parent = job), created by a fail-safe hook when a job enters `Part arrived`. Carries typed `actions=[robot_call, manual_call]`.
- **TASK-ACTIONS** — the reusable sub-component: `tasks.actions` jsonb + a closed backend action registry + `POST /api/tasks/:id/actions/:type`.
- **`robot_call`** — launches the outbound-call lifecycle (pre-compute slot → dial VAPI → book or retry).
- **`manual_call`** — pure client affordance: opens the softphone pre-filled. No backend mutation.
- **`confirmPartsVisit`** — a NEW L0 outbound skill that performs the booking write (reschedule + ZB + status flip + note + task-close).
- **`outboundCallService` / `outboundCallWorker` / `partsCallService`** — the new backend trio for placing calls, running the retry loop, and orchestrating the task lifecycle.

```
 Job → "Part arrived"  ──updateBlancStatus hook (fail-safe)──▶ partsCallService.onPartArrived
                                                                ⇒ ONE open Task (kind=part_arrived_call, actions=[robot_call, manual_call])
                                                                          │
  dispatcher presses a button on TaskCard ────────────▶ POST /api/tasks/:id/actions/:type  (authenticate + requireCompanyAccess + tasks.manage)
                              ┌──────── robot_call ────────┴──── manual_call ────┐
                              ▼                                                   ▼
       partsCallService.startRobotCall:                             (pure client) openDialer(phone, name)
         recommendSlots top-1 slot                                  desktop softphone / mobile tel:
         · no slots / err → task reason, NO call (FR-9)
         · else insert outbound_call_attempts row (pending) → outboundCallWorker claims → dials VAPI
                              │
       parts-visit-scheduler assistant ── in-call tools ─▶ /api/vapi-tools (SAME dispatch, SAME VAPI_TOOLS_SECRET)
          booked  → confirmPartsVisit: rescheduleItem(+ZB) → status Rescheduled → AI-Phone note → task Done
          declined→ recommendSlots live alternatives (same in-call tool)
                              │
       POST /api/vapi/call-status (secret-auth webhook) classifies endedReason:
          booked=terminal · no-answer/voicemail/busy/hang-up/failed = transient → retry (immediate / +2h / next-biz-morning ×3, biz-hours clamp)
          exhausted → task stays with dispatcher, job stays Part arrived
```

---

## PART A — TASK-ACTIONS sub-component (FR-TA1…4, AC-10)

### A.1 Data model
- NEW nullable `jsonb` column `tasks.actions` (migration `157_tasks_actions.sql`, `ADD COLUMN IF NOT EXISTS actions jsonb`). Orthogonal to `agent_output`/`kind` (owned by MAIL-AGENT-001 / AUTO-001; overloading them would break TASKS-COUNT-BADGE / AR-TASK-UNIFY / agentWorker reads). Nullable → ignored by every existing query.
- Shape: `[{ type, label, icon?, state? }]` where `type` ∈ the closed registry (`robot_call`, `manual_call`). `state` (optional) ∈ `{ idle | in_flight | done | failed }` reflecting the last invocation, so the UI can disable/spin.
- `tasksQueries.createTask` gains additive passthrough of `kind` and `actions` (it currently builds `cols`/`vals` from a fixed list + a parent `p.col` — add `kind`/`actions` when present; **must not** break existing callers; verified at `tasksQueries.js:213–232`).

### A.2 Action registry (`backend/src/services/taskActions/registry.js`)
- Closed map `{ robot_call: handler, manual_call: handler }` — the single source of truth for "what a button does." No arbitrary/user code.
- `robot_call` handler → `partsCallService.startRobotCall(companyId, taskId)`.
- `manual_call` handler → no-op server-side; optionally logs an event; returns `{ client: 'openDialer', phone, contactName }` (the resolved job customer number/name) so the frontend can dial. No mutation.

### A.3 Route — `POST /api/tasks/:id/actions/:type`
- Mounted on the existing `/api/tasks` router (`authenticate + requireCompanyAccess`), guarded `requirePermission('tasks.manage')` (executes a server action → stronger than `tasks.view`; `tasks.manage` already exists; existing tasks routes verified at `tasks.js:42–203`).
- `companyId = req.companyFilter.company_id`. Load task scoped to companyId → **foreign/unknown id ⇒ 404**. `:type` not in the registry ⇒ **400**.
- **Idempotency-safe:** `robot_call` re-press while a lifecycle is already active for that job returns the in-flight state (does NOT start a second call — enforced by the attempt partial-unique index, Part C).
- Request: none (path carries everything). Response `200`: `{ ok: true, state, client? }` (`client:'openDialer'` for manual_call; `state:'in_flight'|'queued'|'in_flight_existing'` for robot_call). Errors: `400` unknown type, `404` foreign/missing task, `401/403` auth/permission.

### A.4 Frontend — `TaskCard.tsx`
- Render one `<Button>` per `task.actions[]` entry (label + optional lucide icon), **in addition to** the existing Done/Cancel/Reopen affordances. No hardcoded per-feature buttons.
- `robot_call` → `tasksApi.runTaskAction(id, 'robot_call')` (new fn → `POST …/actions/robot_call`); button shows a spinner and disables while in-flight; reflect returned `state`.
- `manual_call` → on desktop `useSoftPhone().openDialer(phone, contactName)` (signature `openDialer(phone: string, contactName?: string)`, verified `SoftPhoneContext.tsx:18,46`); on mobile native `tel:` (MOBILE-NO-SOFTPHONE-001). No server call needed for the dial itself (the action route MAY still be hit to log; not required).
- `Task` type in `tasksApi.ts` gains `actions?: TaskAction[]`. Design per FORM-CANON / Blanc canon (existing `<Button>` variants; no new surfaces).

---

## PART B — Job status, FSM, and the auto-task

### B.1 `Part arrived` status & FSM (FR-1, AC-1)
- `jobsService.js` (line 25): add `'Part arrived'` to `BLANC_STATUSES`. `OUTBOUND_MAP` / ZB sync block: documented **no-op** for `Part arrived` (Albusto-only). Do not alter existing branches.
- `ALLOWED_TRANSITIONS` (line 37): `'Waiting for parts'` gains `'Part arrived'`; add `'Part arrived': ['Rescheduled', 'Canceled', 'Follow Up with Client']`. Do not reorder/remove existing entries.
- Migration `156_job_fsm_part_arrived.sql`, modeled exactly on `127_job_fsm_on_the_way.sql`: idempotency guard `WHERE v.scxml_source NOT LIKE '%id="Part_arrived"%'`; archive current published version, insert `version_number+1` as published, repoint `active_version_id`. `replace()` pass **(A)** inserts `<state id="Part_arrived" blanc:label="Part arrived" blanc:statusName="Part arrived">` with transitions `TO_RESCHEDULED→Rescheduled`, `TO_CANCELED→Canceled`, `TO_FOLLOW_UP→Follow_Up_with_Client` (before the `Canceled <final>`); pass **(B)** injects `<transition event="TO_PART_ARRIVED" target="Part_arrived" blanc:action="true"/>` as a child of `Waiting_for_parts`. `RAISE NOTICE + CONTINUE` if markers missing.
- `blanc:action="true"` on `Waiting for parts → Part arrived` gives the dispatcher a UI button on the job-card status control (reads the published machine; no separate frontend change expected).
- FSM stays dual-sourced: `updateBlancStatus` resolves via `fsmService.resolveTransition` first (DB authoritative), the hardcoded map is the fallback — both carry the new transitions.

### B.2 Trigger seam — fail-safe status hook (FR-2, FR-3, NFR fail-safe) — **Decision B**
- `jobsService.updateBlancStatus` already returns `{ ...job, blanc_status: newStatus, _prev_status: job.blanc_status }` (verified `jobsService.js:926`). AFTER the DB `UPDATE` + ZB sync block returns, add a **fire-and-forget** block:
  `if (newStatus === 'Part arrived' && job._prev_status !== 'Part arrived') { partsCallService.onPartArrived(jobId, companyId).catch(err => console.error(...)); }`
- Wrapped in its own `try/catch`; **never** `await`ed for the mutation's success; an error here NEVER rolls back or blocks the transition (mirrors `eventService.logEvent` discipline). This is a **protected-file edit** (`jobsService.js`); flagged for the planner as an additive line by precedent.

### B.3 `partsCallService.onPartArrived(jobId, companyId)` (FR-3, FR-4)
- Idempotent auto-task creation. Dedup guard = **one open `part_arrived_call` task per `job_id`**: `SELECT 1 FROM tasks WHERE company_id=$1 AND job_id=$2 AND kind='part_arrived_call' AND status='open'`. If found → no-op (re-entering the status / a duplicate event never spawns a second task).
- Else `createTask` with `parentType:'job'`, `kind:'part_arrived_call'`, title `"Part arrived — schedule completion visit for {customer}"`, `actions=[{type:'robot_call',label:'🤖 Let the robot call'},{type:'manual_call',label:"📞 I'll call myself"}]`. (`createTask` has **no** built-in upsert — the SELECT guard IS the app-upsert, per Deviation 2.)
- Surfaces as Action Required (AR-TASK-UNIFY-001: open task on a job parent). No new lead/job (D7).

---

## PART C — Outbound call lifecycle (`robot_call`)

### C.1 `startRobotCall(companyId, taskId)` — pre-compute then enqueue (FR-5, FR-9)
- Resolve the task → its `job_id`, then the job → customer `phone` + `contactId` + address/zip.
- **v1 gate:** short-circuit unless `companyId === DEFAULT_COMPANY_ID` (or the `outbound_call_settings.enabled` flag / allowlist). All code stays parameterized on `job.company_id`.
- Pre-compute the top slot via `recommendSlots(companyId, {}, { zip|address, lat, lng, durationMinutes })`, gated on `isAppConnected(companyId, 'smart-slot-engine')`, safe-fail. `recommendSlots` frozen output: `{ available:true, slots:[{ key, date, start, end, label }] }` or `{ available:false, slots:[], fallback:true }` (verified `recommendSlots.js:13–17,132–133`).
- **No slots OR engine fault (FR-9):** place NO call. Write a human-readable **reason + recommended dispatcher action** to the task (a note / description update), leave the job `Part arrived`, task open with the dispatcher, and do **not** insert a dialing attempt. Set the task's `robot_call` action `state:'failed'` with the reason so the button reflects it.
- Else store the top-1 slot in `slot_json` and insert the first attempt row.

### C.2 Attempt queue (OQ-5 concurrency guard) — **Decision F**
- NEW table `outbound_call_attempts` (migration `158_outbound_call_attempts.sql`): `id, company_id, job_id, task_id, contact_id, phone, vapi_call_id, attempt_no, status, scheduled_at timestamptz, slot_json jsonb, reason text, created_at, updated_at`.
- `status` ∈ `pending | dialing | answered | no_answer | voicemail | declined | booked | exhausted | canceled | failed`.
- **Idempotency/duplicate-guard = partial unique index on `(job_id) WHERE status IN ('pending','dialing')`** — at most ONE active/queued attempt per job. `startRobotCall` inserts a `pending` row (immediate `scheduled_at`) OR, if one exists, returns it (a double-press cannot start a second call).

### C.3 `outboundCallService.placeCall(...)` — the VAPI trigger (FR-5d, FR-6, OQ-3) — **Decision D**
- `POST https://api.vapi.ai/call`, header `Authorization: Bearer ${VAPI_API_KEY}`, body:
  `{ assistantId: VAPI_OUTBOUND_ASSISTANT_ID, phoneNumberId: VAPI_OUTBOUND_PHONE_NUMBER_ID, customer: { number: phone }, assistantOverrides: { variableValues: { jobId, contactId, customerName, companyId, slotLabel, slotDate, slotStart, slotEnd } } }`.
- `VAPI_OUTBOUND_PHONE_NUMBER_ID` = Boston Masters' VAPI-registered number, from server env (deploy-config, never hardcoded/client). Returns the VAPI `call.id`, stored on the attempt row as `vapi_call_id` for webhook correlation.
- The call **opens with a concrete slot** (`slotLabel`) and hits **no API during the open** (D3).

### C.4 `outboundCallWorker` — the claim loop (FR-10, FR-13) — **Decision F**
- NEW `backend/src/services/outboundCallWorker.js`, `setInterval` tick (default 60s; env `OUTBOUND_CALL_WORKER_INTERVAL_MS`), pattern = the `agentWorker` claim loop (`UPDATE … WHERE status='pending' AND scheduled_at<=now() … FOR UPDATE SKIP LOCKED`).
- For each claimed row: **business-hours clamp** via `groupRouting.isBusinessHours(group, now)` using the job's company group/timezone. Outside hours → push `scheduled_at` to next open time, do NOT dial. In-hours → mark `dialing`, call `outboundCallService.placeCall(...)`, store `vapi_call_id`. A failed POST = a failed attempt (feeds retry). Per-row isolated `try/catch` — worker errors never corrupt job state.
- **Bootstrap (implementation note, OPEN):** existing workers/schedulers (`inboxWorker.startWorker`, `agentWorker.startWorker`, rules-engine `setInterval` tick, `overageScheduler.start`, `routeRetentionScheduler.start`, `stagedAttachmentCleanupScheduler.start`) all bootstrap inside **`src/server.js`** (verified `src/server.js:422–448`) — a **protected file**. There is no separate worker-bootstrap module. Per precedent, add `outboundCallWorker` as an **additive** start line there (`require('../backend/src/services/outboundCallWorker').start();`, env-gated `FEATURE_OUTBOUND_CALL_WORKER`). **Flagged for the planner:** the protected-file edit to `src/server.js` may need owner approval; if a worker-bootstrap module is later introduced, start it there instead.

### C.5 In-call booking write — `confirmPartsVisit` skill (FR-8, AC-3) — **Decision E, Deviation 1**
- NEW `backend/src/services/agentSkills/skills/confirmPartsVisit.js` + additive `registry.js` entry `{ name:'confirmPartsVisit', kind:'write', requiredLevel:'L0', run: lazyRun('confirmPartsVisit') }`. Inbound Sara is untouched (additive registry entry only).
- **L0 on the outbound surface (Deviation 1):** the call is server-initiated to a **pre-bound known contact**; identity comes from `variableValues` (`contactId`, `jobId`, `companyId`), NOT a caller claim. It MUST NOT be gated behind the inbound `verificationGate`. Isolation is preserved by an **in-skill ownership pre-check** (companyId + bound contactId), analogous to `rescheduleAppointment`'s `getJobById` guard.
- Behavior (order matters):
  1. Ownership pre-check: `getJobById(jobId, companyId)`; the job's `contact_id` must `String(...)===String(contactId)` (from `variableValues`). Foreign/cross-company/cross-contact → **safe refusal**, no write (mirrors `rescheduleAppointment.js:174–182`).
  2. Confirmed-slot guard: reuse `rescheduleAppointment.isConfirmedSlot` (`/^\d{4}-\d{2}-\d{2}$/` date, `/^\d{1,2}:\d{2}$/` start/end). Malformed/absent → soft refusal, no write.
  3. `scheduleService.rescheduleItem(companyId, 'job', jobId, newStartAt, newEndAt)` — SAME-job reschedule + AR-4 ZB write-through (verified present). **OQ-4:** `arrival_window_minutes = slot.end − slot.start` derived from the confirmed slot; no new parameter. On ZB **409/conflict** (`forceSyncOnZbError` throws `{ statusCode:409 }`) → catch → graceful `{ ok:false, success:false, conflict:true, speak:'Let me have a teammate confirm that time…' }` — **no false success**, status is NOT flipped, task NOT closed (identical posture to `rescheduleAppointment.js:206–221`).
  4. On success: `updateBlancStatus(jobId, 'Rescheduled', companyId)` (reschedule FIRST, then flip — a flip without a committed reschedule would be wrong).
  5. `addNote(jobId, "Appointment rescheduled to {window} via AI Phone.", [], 'AI Phone', 'AI Phone')` + `eventService.logEvent(companyId, 'job', jobId, 'job_rescheduled', {...}, 'system')` — both guarded (a note hiccup can't fail a landed write).
  6. Auto-close the task: `updateTask(companyId, taskId, { status: 'done' })` for the open `part_arrived_call` task on this job (taskId carried in the lifecycle, or resolved by job+kind). Mark the attempt `booked`.
- Live alternatives on decline reuse the EXISTING `recommendSlots` skill verbatim (FR-7).

### C.6 Result classification webhook — `POST /api/vapi/call-status` (FR-10…12, OQ-1)
- NEW route in `backend/src/routes/vapi.js`, **secret-auth** (VAPI signing secret / shared header from server env, NOT a user session). company_id is derived from the **correlated `outbound_call_attempts` row** (matched on `vapi_call_id`), never trusted from the body.
- On VAPI `end-of-call-report`, map `endedReason`:
  - **Terminal success:** `confirmPartsVisit` already booked → mark attempt `booked`, done (task already closed by the skill).
  - **Transient (retry):** `customer-did-not-answer` → `no_answer`; `voicemail` → `voicemail`; `customer-busy` → `no_answer`; `assistant-forwarded`/hang-up/failed-to-place → `failed`. Each writes a **per-attempt job note** via `addNote(…, 'AI Phone')` ("tried to reach {name}, no answer — next attempt at {time}") + a domain event, then schedules the next attempt.
  - **Customer declined all offered windows** (agent could not book, no transient failure): treat as a retry candidate OR (owner default) close the automated path and leave the task with the dispatcher with a "customer wants a different time — follow up" reason. (See §Non-goals / OQ note below — default: schedule the next attempt like a no-answer, since a later human callback may land.)
- **Retry schedule (OQ-1):** attempt 1 = immediate, 2 = +2h, 3 = **next business morning (09:00 company-local, clamped)**; total **3 attempts** (count + backoff configurable, Part D). After the 3rd: mark `exhausted`, final note "automated attempts exhausted — please follow up," **task stays open with dispatcher, job stays `Part arrived`** (no flip). All timing company-tz-aware.

---

## PART D — Per-company retry settings (FR-10 configurable)
- NEW table `outbound_call_settings` (migration `159_outbound_call_settings.sql`), mirroring `slot_engine_settings` (REC-SETTINGS-001): `company_id PK, max_attempts int default 3, backoff_schedule jsonb default '["immediate","+2h","next_business_morning"]', next_morning_hour int default 9, enabled bool default true`.
- A `resolve(companyId)` accessor returns defaults if no row (safe-fail, never 500). v1: only the Boston Masters row need exist; code reads by `job.company_id`.

---

## Scenarios (Pre / Steps / Result / Side-effects)

### S1 — `Waiting for parts → Part arrived` creates ONE task with 2 actions (idempotent)
- **Pre:** Job in `Waiting for parts`, company = Boston Masters.
- **Steps:** Dispatcher moves job to `Part arrived` (`PATCH /api/jobs/:id/status`) → `updateBlancStatus` commits, returns `_prev_status='Waiting for parts'` → fail-safe hook fires `onPartArrived` → SELECT-guard finds no open `part_arrived_call` task → `createTask`.
- **Result:** One open task on the job, `actions=[robot_call, manual_call]`, title "Part arrived — schedule completion visit for {customer}," visible as Action Required.
- **Side-effects:** `tasks` row (kind, actions). No new lead/job. Domain event optional.
- **Idempotency:** Re-entering `Part arrived` (or a duplicate event) → SELECT-guard hits → **no second task**. Hook failure never blocks the transition (S13).

### S2 — `robot_call`, ready slot, customer agrees (happy path)
- **Pre:** Task open with `robot_call`; slot engine connected.
- **Steps:** Dispatcher presses "🤖 Let the robot call" → `POST /api/tasks/:id/actions/robot_call` → `startRobotCall` → `recommendSlots` returns top-1 → insert `pending` attempt (slot_json) → worker claims (in business hours) → `placeCall` (VAPI, slot in `variableValues`) → agent offers window → customer agrees → in-call `confirmPartsVisit` → `rescheduleItem`(+ZB) → `updateBlancStatus('Rescheduled')` → AI-Phone note + event → `updateTask done` → webhook marks attempt `booked`.
- **Result:** Same job rescheduled (Albusto + ZB), status `Rescheduled`, task Done.
- **Side-effects:** Job schedule + ZB updated; `job_rescheduled` note ("via AI Phone") + event; attempt `booked`.

### S3 — Customer rejects the offered slot → live alternatives → books
- **Pre:** As S2; customer declines the pre-computed window.
- **Steps:** In-call agent calls `recommendSlots` (live, via `/api/vapi-tools`), offers 2–3, customer picks one → `confirmPartsVisit` with the chosen `{date,start,end}`.
- **Result / side-effects:** Identical to S2 (reschedule + ZB + status flip + note + task Done + attempt `booked`).

### S4 — No answer / voicemail → note + retry (immediate / +2h / next-biz-morning)
- **Pre:** Dial placed; call ends unanswered.
- **Steps:** Webhook classifies `customer-did-not-answer`/`voicemail` as transient → job note ("tried to reach {name}… next attempt at {time}") + event → schedule attempt 2 (+2h), attempt 3 (next business morning 09:00 local, clamped).
- **Result:** Up to 3 attempts, each in business hours.
- **Side-effects:** One job note per attempt; attempt rows advance `pending→dialing→no_answer/voicemail`.

### S5 — After ×3 unsuccessful attempts → task stays with dispatcher
- **Pre:** 3rd attempt fails.
- **Steps:** Webhook marks attempt `exhausted` → final note "automated attempts exhausted — please follow up."
- **Result:** **Task stays open** with dispatcher, **job stays `Part arrived`** (no flip).
- **Side-effects:** Final job note + event; no further dials for that job.

### S6 — No slots / engine error BEFORE the call → don't call, reason on task (FR-9)
- **Pre:** `robot_call` pressed; `recommendSlots` returns `available:false`/`fallback:true` or throws.
- **Steps:** `startRobotCall` places NO call, does NOT insert a dialing attempt; writes reason + dispatcher action to the task; sets `robot_call` action `state:'failed'`.
- **Result:** Job unchanged (`Part arrived`), task open with a clear reason.
- **Side-effects:** Task note/description reason; no attempt row, no VAPI call, no job change.

### S7 — `manual_call` → openDialer
- **Pre:** Task open with `manual_call`.
- **Steps:** Dispatcher presses "📞 I'll call myself" → desktop `useSoftPhone().openDialer(phone, contactName)`; mobile native `tel:`. Backend action route (if hit) is a no-op that returns `{ client:'openDialer', phone, contactName }`.
- **Result:** Softphone opens pre-filled; no robot, no status change.
- **Side-effects:** None (optional audit event only).

### S8 — ZB 409 at booking → graceful, status NOT flipped, task NOT closed
- **Pre:** In-call agreement; `rescheduleItem` throws `{ statusCode:409 }` on the ZB push.
- **Steps:** `confirmPartsVisit` catches conflict → returns `{ conflict:true, success:false }`, no status flip, no note, no task-close.
- **Result:** Job stays `Part arrived`; task stays open; caller told "a teammate will confirm."
- **Side-effects:** None persisted; state recoverable. Attempt NOT marked `booked`.

### S9 — VAPI call-status webhook classification
- **Pre:** Call ended; webhook fires with `endedReason`.
- **Steps:** Secret-auth verified; attempt located by `vapi_call_id` (company derived from that row). Map: `assistant booked`→terminal `booked`; `customer-did-not-answer`/`customer-busy`→`no_answer`+retry; `voicemail`→`voicemail`+retry; hang-up/`assistant-forwarded`/failed-to-place→`failed`+retry; customer-declined-all→retry (default) or dispatcher hand-off.
- **Result:** Correct next state (terminal or scheduled retry).
- **Side-effects:** Note per transient attempt; attempt status updated.

### S10 — Cross-tenant / isolation (foreign job or company)
- **Pre:** A task/job belonging to another company.
- **Steps:** Action route loads task scoped to `req.companyFilter.company_id` → foreign id **404** (no leak). In-skill, `confirmPartsVisit` re-checks `getJobById(jobId, companyId)` + contact match → foreign → safe refusal, no write.
- **Result:** No cross-tenant read/write; 404, not 403.

### S11 — Unknown action type → 400
- **Steps:** `POST /api/tasks/:id/actions/frobnicate` → `:type` not in registry → **400** (no handler invoked).

### S12 — Permission / auth (401/403)
- **Steps:** No/invalid token → **401**; authenticated but lacks `tasks.manage` → **403**. No action runs.

### S13 — Fail-safe: `partsCallService` throws during the hook
- **Pre:** `onPartArrived` throws (DB hiccup / createTask fault).
- **Steps:** The hook's `try/catch` + `.catch(...)` swallows it; the status transition already committed.
- **Result:** Job IS `Part arrived`; auto-task simply absent (a later re-entry retries the SELECT-guard). Transition NEVER rolled back (AC-11).

### S14 — Idempotency: double `robot_call` press does not place two calls
- **Pre:** An attempt row `pending`/`dialing` already exists for the job.
- **Steps:** Second press → partial-unique index blocks a new active row → `startRobotCall` returns the in-flight row → route returns `state:'in_flight_existing'`.
- **Result:** Exactly one active call lifecycle per job (NFR idempotency, OQ-5).

---

## API contracts

- `POST /api/tasks/:id/actions/:type` — execute a typed task action. Middleware `authenticate, requireCompanyAccess, requirePermission('tasks.manage')`; `companyId = req.companyFilter.company_id`. Req: none. Res `200 { ok, state, client? }`. Errors: `400` unknown `:type`, `404` foreign/missing task, `401/403` auth. Isolation: task loaded WHERE `company_id=$companyFilter`; foreign → 404.
- `PATCH /api/jobs/:id/status` (existing) — `→ 'Part arrived'` fires the fail-safe hook (`updateBlancStatus`), returns `{...job, blanc_status, _prev_status}`.
- `POST /api/vapi/call-status` — VAPI end-of-call webhook. Auth: **shared secret** (server env header/signature), NOT a session. company_id from the correlated `outbound_call_attempts` row via `vapi_call_id` (never body). Classifies `endedReason` → `booked` (terminal) or transient → retry. Res `200 { ok:true }`.
- `POST /api/vapi-tools` (existing, UNCHANGED) — the SAME inbound dispatch also serves the outbound assistant's in-call tools (`recommendSlots`, `confirmPartsVisit`), gated by the SAME `x-vapi-secret` = `VAPI_TOOLS_SECRET` (verified `vapi-tools.js:54–61`); generic dispatch on `toolCall.function.name` → `agentSkills.runSkill` (verified `vapi-tools.js:103,118–119`).
- `POST https://api.vapi.ai/call` (outbound, server-side) — `Bearer VAPI_API_KEY`; body `{ assistantId, phoneNumberId, customer.number, assistantOverrides.variableValues }`. Returns `call.id`.

---

## VAPI contracts

### Outbound assistant — `voice-agent/assistants/parts-visit-scheduler.json` (NEW)
Modeled on `lead-qualifier-v2.json` (same `voice`/`model`/`tools[].server` shape). Live push is owner-consent-gated and OUT of this pipeline.

- **`firstMessage`** ≈ `"Hi {{customerName}}, your part has arrived — let's schedule the visit to finish the repair."` `firstMessageMode: "assistant-speaks-first"`.
- **`model.messages[0]` (system) — script flow (no re-verification, no warranty phrase):**
  - Offer the pre-computed `{{slotLabel}}` window directly ("We can come out {{slotLabel}} to finish up — does that work?").
  - **NO name/address confirmation** (D6) — the contact is pre-bound via `variableValues`.
  - On agreement → call `confirmPartsVisit` with the confirmed `{date,start,end}`, then state the arrival window as a **range** (never an exact minute) and close.
  - On decline → call `recommendSlots` (pass zip/lat/lng from `variableValues` if present), offer 2–3 live windows exactly as returned, on pick → `confirmPartsVisit`.
  - **NO "3-month warranty" phrase** (D5 / AC-12). Call every tool **silently** (VAPI-Sara memory: banned filler on every tool call). Keep `answerOnBridge` semantics consistent with the platform.
- **`model.tools[]`** — MINIMAL subset, each `{ type:'function', server:{ url:'https://api.albusto.com/api/vapi-tools', secret:'REPLACE_WITH_VAPI_TOOLS_SECRET' }, function:{ name, parameters, description } }` (re-inject the real `VAPI_TOOLS_SECRET` on every model write):
  - `recommendSlots` — live alternatives on decline. Params `{ zip?, lat?, lng?, unitType?, durationMinutes?, excludeSlots?, daysAhead? }`.
  - `confirmPartsVisit` — the booking write. Params `{ chosenSlot: { date, start, end } (required) }`; identity (`contactId`, `jobId`, `companyId`) is NOT a tool param — it flows from `variableValues` into the skill input server-side.
  - **Not** `LEGACY_TOOLS` — `confirmPartsVisit` is identity-aware, but identity is injected via `variableValues`, not the caller-number path; it does not need the silent caller-ID injection and is not in `LEGACY_TOOLS`.

### `assistantOverrides.variableValues` schema (context passed at call-open)
```jsonc
{
  "jobId":        "string|number",  // the job being finished (bound target)
  "contactId":    "string|number",  // pre-verified contact (ownership pre-check key)
  "companyId":    "uuid",           // tenant scope
  "customerName": "string",         // first name for the greeting
  "slotLabel":    "string",         // human window, e.g. "Tuesday between 10 AM and 12 PM"
  "slotDate":     "YYYY-MM-DD",
  "slotStart":    "HH:MM",
  "slotEnd":      "HH:MM"
}
```

### `POST /api/vapi/call-status` webhook payload (consumed)
```jsonc
{
  "message": {
    "type": "end-of-call-report",
    "call": { "id": "<vapi_call_id>" },   // correlation key → attempt row → companyId
    "endedReason": "customer-did-not-answer | voicemail | customer-busy | assistant-forwarded | assistant-ended-call | ...",
    "analysis": { /* optional */ }
  }
}
```

---

## Retry state machine (`outbound_call_attempts.status`)
```
pending ──worker claim, in-hours──▶ dialing ──VAPI end-of-call webhook──▶
   │ (outside hours)                                  │
   └─ reschedule scheduled_at, stay pending           ├─ booked      ── TERMINAL (confirmPartsVisit closed the task)
                                                       ├─ no_answer   ─┐
                                                       ├─ voicemail   ─┤ transient → note + schedule next attempt
                                                       ├─ declined    ─┤   (immediate / +2h / next-biz-morning; max_attempts)
                                                       └─ failed      ─┘
                                        after attempt == max_attempts ──▶ exhausted ── TERMINAL (task stays w/ dispatcher, job stays Part arrived)
```
- Partial unique `(job_id) WHERE status IN ('pending','dialing')` → at most one active attempt (OQ-5).
- All scheduling is company-tz-aware; every dial clamped to business hours (`groupRouting.isBusinessHours`).

---

## Edge cases
1. **Job has no phone / no contact** → `startRobotCall` can't dial → task reason "no reachable number," no attempt (like FR-9).
2. **Slot engine app disconnected** → `recommendSlots` returns `fallback:true` → treated as no-slots (S6), no call.
3. **Re-entry to `Part arrived` after task already Done** → SELECT-guard keys on `status='open'`; a Done task no longer blocks → a fresh open task is created (intended: the loop can restart).
4. **`updateBlancStatus` flip to `Rescheduled` fails after a committed reschedule** → note/event guarded; `confirmPartsVisit` returns success-with-warning is NOT allowed — treat a flip failure as a landed reschedule but leave a dispatcher note; do NOT mark attempt `booked` falsely. (Prefer: reschedule + flip in the same skill path; a flip fault → task NOT auto-closed, dispatcher note.)
5. **Worker claims a row whose task/job was Canceled meanwhile** → skip + mark attempt `canceled` (job left a valid FSM state; no dial).
6. **Duplicate VAPI webhook for one `call.id`** → idempotent: a `booked`/`exhausted` attempt is terminal; a repeat webhook is a no-op.
7. **`manual_call` on mobile** → native `tel:` (no softphone; MOBILE-NO-SOFTPHONE-001).
8. **lat/lng partially present** for pre-compute → prefer address/zip fallback in `recommendSlots` (its location resolver already handles this).
9. **`slot.end < slot.start`** (malformed) → `isConfirmedSlot`/`arrival_window_minutes` guard → refusal, no write.

## Error handling
- Hook / orchestration errors → swallowed, never roll back the status transition (S13, AC-11).
- Slot-engine / ZB errors → graceful: no-slots→don't-call (S6); ZB 409→graceful conflict, no false success (S8); ZB push failure follows existing `forceSyncOnZbError` discipline.
- Failed outbound-call POST → a failed attempt → feeds retry (S4).
- Note/event write failures → logged non-fatal; never fail a landed booking.
- Webhook auth failure → reject (secret mismatch); unknown `call.id` → 200 no-op (don't leak).

## Data isolation
- Every task-action SQL scoped to `req.companyFilter.company_id`; foreign id → 404.
- Webhook company_id derived from the correlated attempt row, never the body.
- `confirmPartsVisit` re-checks companyId + bound contactId in-skill (Deviation 1) — L0 does NOT weaken isolation.
- Outbound VAPI trigger + `VAPI_API_KEY`/`VAPI_OUTBOUND_*`/webhook secret live in server env only.
- v1 dial seam gated to `DEFAULT_COMPANY_ID`; all code parameterized on `job.company_id`.

## Non-goals
- Any re-verification of identity/name/address on the outbound call (D6).
- Creating a new lead or job (D7) — only transition/reschedule the existing job.
- Payment capture by voice (never).
- The "3-month warranty" phrase (D5, AC-12).
- Multi-tenant rollout (v1 = Boston Masters; code stays company-scoped).
- Arbitrary user-defined task actions (TASK-ACTIONS v1 = closed set `robot_call`, `manual_call`).
- Mobile softphone for `manual_call`.
- Changing the inbound Sara assistant (`30e85a87`), the inbound `/api/vapi-tools` contract, slot-engine scoring, or the dispatcher UI beyond rendering the new task buttons.

## Deviations & open implementation notes (from architecture §11, carried forward)
1. **`confirmPartsVisit` is L0 on the outbound surface** — deliberate (Deviation 1); isolation via in-skill companyId + bound-contactId pre-check. Do NOT gate behind inbound `verificationGate`.
2. **`createTask` needs `kind`+`actions` passthrough** — additive to `tasksQueries.createTask` (Deviation 2). AR-TASK-UNIFY app-upsert is enforced by the explicit SELECT guard in `onPartArrived` (createTask has no built-in upsert).
3. **`rescheduleItem` ZB write-through — VERIFIED PRESENT** (`scheduleService.js:240` `zenbookerClient.rescheduleJob`; Deviation 3 dependency satisfied). No forked reschedule path.
4. **`outboundCallWorker` bootstrap — OPEN implementation note.** All existing workers bootstrap in the **protected** `src/server.js` (verified 422–448). No separate bootstrap module exists. Add the worker start there as an additive line (precedent), env-gated `FEATURE_OUTBOUND_CALL_WORKER`; **planner decides whether the protected-file edit needs owner approval.** If a worker-bootstrap module is later introduced, start it there instead.
5. **`Part arrived` UI transition button** — provided by the migration's `blanc:action="true"` transition on `Waiting for parts → Part arrived`; job-card status control reads the published machine (no separate frontend change expected).
6. **Prod deploy + live VAPI outbound-assistant push are owner-consent-gated** (standing rule).
