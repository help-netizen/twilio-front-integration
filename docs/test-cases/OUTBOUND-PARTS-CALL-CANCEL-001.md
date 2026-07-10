# OUTBOUND-PARTS-CALL-CANCEL-001 — Test cases

## Coverage
- Backend (jest): 16 | Frontend (build + logic-review, no FE runner): 2 | Build: 1
- P0: 12 | P1: 5 | P2: 2
- Test files (extend existing, in-repo mock idioms): `tests/partsCallService.test.js`
  (`jest.mock('../backend/src/db/connection')`, `db/tasksQueries`, `jobsService`),
  `tests/vapiCallStatusWebhook.test.js` (supertest + `x-vapi-secret`),
  `tests/outboundCallWorker.test.js`, `tests/inboxWorker.test.js`,
  plus a jobsService-hook block (new `tests/jobsServiceLeaveHook.test.js` or extend an existing
  jobsService suite). FE: `npm run build` (tsc -b; prod Docker stricter — noUnusedLocals).

---

## A. `cancelScheduledRobotCalls` — core (unit, tests/partsCallService.test.js)

### TC-CC-01 (P0) — pending flip + note + stamp (status_change)
- **Setup:** mock db: active SELECT → one `pending` row `{id:10, job_id:5, task_id:7, status:'pending', attempt_no:1}`; mock `jobsService.addNote`; tasks SELECT/UPDATE for the stamp.
- **Input:** `cancelScheduledRobotCalls({jobId:5}, COMPANY_A, {kind:'status_change', newStatus:'Rescheduled'})`.
- **Expected:** UPDATE …`SET status='canceled'`… `AND status='pending'` for id 10; exactly ONE `addNote(5, "AI: robot call canceled — job left 'Part arrived' (status changed to 'Rescheduled').", [], 'AI Phone', 'AI Phone')`; task 7 `robot_call` action → `{state:'canceled', reason:"Canceled — job status changed to 'Rescheduled'."}`; returns `{canceled:1}`; NO marker INSERT.

### TC-CC-02 (P0) — no active rows → silent no-op (idempotency)
- **Setup:** active SELECT → `[]`.
- **Expected:** returns `{canceled:0}`; ZERO note/stamp/UPDATE/INSERT calls. Calling twice — same.

### TC-CC-03 (P0) — dialing-only → marker row + suffix note, dialing row untouched
- **Setup:** active SELECT → one `dialing` row `{id:11, job_id:5, task_id:7, attempt_no:2, phone:'+16175550100'}`.
- **Input:** cause `{kind:'human_contact', direction:'inbound', at:'2026-07-10T15:42:00.000Z'}`.
- **Expected:** NO UPDATE of row 11; ONE INSERT `status='canceled'` marker copying company/job/task/contact/phone/attempt_no=2; note text ends with `(inbound call completed at 2026-07-10T15:42:00.000Z). A call already in progress will not be retried.`; task stamped canceled.

### TC-CC-04 (P1) — phone-digit scope match (no contact_id)
- **Setup:** scope `{contactId:null, phone:'(617) 555-0100'}`; assert the active SELECT receives digit-normalized `$3='6175550100'` and the `RIGHT(regexp_replace(phone,'\D','','g'),10) = RIGHT($3,10)` predicate; digits <7 (`phone:'911'`) → function returns `{canceled:0}` WITHOUT querying.
- **Expected:** as stated; company param always `$1=COMPANY_A`.

### TC-CC-05 (P0) — never throws (safe-fail)
- **Setup:** db.query rejects on the first call.
- **Expected:** resolves `{canceled:0}` (or error-shaped `{canceled:0, error}`) — NO throw; console.warn'ed.

## B. `onHumanContact` — trigger-2 exclusions (unit, tests/partsCallService.test.js)

### TC-CC-06 (P0) — completed human inbound cancels; robot/Sara/AI excluded
- **Matrix (each call row → expect cancel invoked / NOT invoked):**
  1. `{status:'completed', is_final:true, parent_call_sid:null, duration_sec:90, answered_at:set, direction:'inbound', answered_by:'dana', call_sid:'CA1', company_id:A}` + no vapi flow-execution → CANCEL (scope `{contactId, phone:from_number}`).
  2. same but `answered_by:'ai'` → NO.
  3. same but `call_sid:'vapi:abc'` → NO.
  4. same but `call_flow_executions` row: `current_node_id:'n2'`, `context_json:'{"graph":{"states":[{"id":"n2","kind":"vapi_agent"}]}}'` → NO (Sara).
  5. same as 4 but execution node kind `'queue'` (Sara forwarded → human answered) → CANCEL.
- **Expected:** exactly per matrix; external number = `from_number` (inbound) / `to_number` (outbound leg case asserted once with `direction:'outbound'`).

## C. jobsService leave-hooks (unit, jobsServiceLeaveHook block)

### TC-CC-07 (P0) — updateBlancStatus leave-hook fires exactly on Part arrived → other
- **Setup:** mock getJobById → `{blanc_status:'Part arrived', company_id:A}`; spy lazy-required `partsCallService.cancelScheduledRobotCalls`.
- **Input:** `updateBlancStatus(5,'Rescheduled',A)`.
- **Expected:** cancel called ONCE with `({jobId:5}, A, {kind:'status_change', newStatus:'Rescheduled'})`; transitions `Waiting for parts→Part arrived` (enter) and `Submitted→Canceled` (never was Part arrived) → NOT called; a rejecting cancel does NOT reject updateBlancStatus (fire-and-forget).

### TC-CC-08 (P0) — cancelJob + markComplete direct writers hook
- **Setup:** job `{blanc_status:'Part arrived', company_id:A, zenbooker_job_id:null}`.
- **Expected:** `cancelJob(5)` → cancel with newStatus `'Canceled'`; `markComplete(5)` → `'Visit completed'`; job in `Submitted` → neither fires.

### TC-CC-09 (P1) — syncFromZenbooker zb_canceled flip
- **Setup:** existing `{blanc_status:'Part arrived', zb_canceled:false, company_id:A}`; incoming cols `zb_canceled:true`.
- **Expected:** cancel with `'Canceled (Zenbooker)'`; ALSO assert `blanc_status` stays `'Part arrived'` in the UPDATE (preserve path :1105-1120 regression pin); incoming `zb_canceled:false` or existing already true → not called.

## D. inboxWorker hook predicate (tests/inboxWorker.test.js)

### TC-CC-10 (P0) — final completed parent with answered_at → hook; guard variants → no hook
- **Setup:** drive `processVoiceEvent` with mocked `queries.upsertCall` returning the row under test; spy `partsCallService.onHumanContact`.
- **Matrix:** upsert returns `{is_final:true, status:'completed', parent_call_sid:null, duration_sec:45, answered_at:set, direction:'inbound'}` → hook ONCE; variants each → NO hook: `skipUpsert` path (existing `voicemail_left` + event completed), `duration_sec:0`, `answered_at:null`, `parent_call_sid:'CA0'`, `direction:'internal'`, upsert returns undefined (out-of-order).
- **Expected:** per matrix; a throwing `onHumanContact` never rejects `processVoiceEvent`.

## E. Retry-resurrection guard (tests/vapiCallStatusWebhook.test.js + outboundCallWorker.test.js)

### TC-CC-11 (P0) — webhook: job left Part arrived → attempt classified, NO retry insert
- **Setup:** correlated `dialing` attempt `{attempt_no:1, max 3}`; `getJobById` → `{blanc_status:'Rescheduled'}` (and separately `null`, and `{zb_canceled:true, blanc_status:'Part arrived'}`).
- **Input:** end-of-call-report, endedReason `customer-did-not-answer`.
- **Expected:** attempt UPDATE → `no_answer` (honest) happens; ZERO INSERT of a pending retry; ZERO exhausted INSERT; ZERO addNote; `logEvent('outbound_call_retry_skipped')`; 200 `{ok:true}`.

### TC-CC-12 (P0) — webhook: canceled marker newer than attempt → NO retry insert
- **Setup:** job still `{blanc_status:'Part arrived'}`; `isChainCanceled` EXISTS query → true (canceled row id > attempt.id).
- **Expected:** same skip as TC-CC-11. Converse: EXISTS→false AND job Part arrived → retry INSERT + "next attempt" note happen exactly as today (regression pin, attempt_no+1, slot_json copied).

### TC-CC-13 (P0) — webhook: exhausted path also guarded
- **Setup:** attempt_no = max_attempts; guard blocked (either leg).
- **Expected:** NO exhausted marker INSERT, NO "attempts exhausted" note; attempt still gets its terminal transient status. Unblocked → exhausted marker + note as today (regression).

### TC-CC-14 (P1) — worker scheduleRetryOrExhaust shares the guard
- **Setup:** placeCall fails (`result.ok:false`); guard blocked via canceled-marker EXISTS.
- **Expected:** current attempt → `failed` (reason kept), NO next-attempt INSERT, NO retry note.

### TC-CC-15 (P0) — worker Guard-1 honesty: canceled + note (was failed, no note)
- **Setup:** claimed attempt; `getJobById` → `{blanc_status:'Rescheduled', company_id:A}`.
- **Expected:** `terminate(id,'canceled', 'job_status_Rescheduled')`; ONE cancel note via addNote (`'AI Phone'`); task stamped canceled. `getJobById→null` → status `'failed'`, reason `job_not_found`, NO note (regression: today's behavior for not-found kept).

### TC-CC-16 (P1) — booked branch untouched by the guard
- **Setup:** job `{blanc_status:'Rescheduled'}` BECAUSE confirmPartsVisit booked mid-call (booked detection true).
- **Expected:** attempt → `booked`; guard code never runs (booked returns first, `vapiCallStatus.js:247-255`); no cancel note.

## F. Re-queue + stamps (tests/partsCallService.test.js)

### TC-CC-17 (P2) — startRobotCall success stamps queued (clears canceled)
- **Setup:** dialable job, slot ok, INSERT returns id; task actions currently `[{type:'robot_call', state:'canceled', reason:'…'}]`.
- **Expected:** after `{ok:true}` the task's robot_call action → `{state:'queued'}` with reason cleared (null/absent); `already:true` path (23505) stamps too; `markRobotCallFailed` still produces `{state:'failed', reason}` (wrapper regression).

## G. Frontend (no runner — build + logic review)

### TC-CC-18 (P1, FE) — canceled reason line renders
- **Check:** `TaskActionButtons.tsx` reason filter includes `state==='canceled' && reason` (renders the same TriangleAlert row); `tasksApi.ts` `TaskAction['state']` union = `'failed' | 'canceled' | 'queued'`; buttons still render for canceled (re-queue allowed — S12).

### TC-CC-19 (P2, Build) — `npm run build` (frontend) + `npx jest` (backend suites above) green
- Worktree gotcha: jest needs `--testPathIgnorePatterns "/node_modules/"`.
