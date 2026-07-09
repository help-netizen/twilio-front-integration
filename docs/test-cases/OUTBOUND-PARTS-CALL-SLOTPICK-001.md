# OUTBOUND-PARTS-CALL-SLOTPICK-001 — Test cases

> REVISED per owner redirect (2026-07-08): reuse `CustomTimeModal` (not a new dialog); server converts
> ISO→slot_json; invalid slot → 400. The earlier RobotCallDialog / task-recs-route test IDs are
> SUPERSEDED (see "Superseded" at the end).

## Coverage
- Backend (jest): 11 | Frontend (build + logic-review — no FE test runner): 7 | Build: 1
- P0: 8 | P1: 7 | P2: 3 | P3: 1
- Test files: `tests/partsCallService.test.js` (extend), `tests/tasksActionRoute.test.js` (extend),
  `tests/*` pulse/timelines projection (extend or focused). Mock idioms in-repo:
  `jest.mock('../backend/src/db/connection')`, `db/tasksQueries`, `jobsService`,
  `agentSkills/skills/recommendSlots`, `outboundCallSettingsService`, and `slotEngineService`
  (`resolveTimezone`); supertest mounts `tasksRouter` behind a fake authenticate that sets
  `req.companyFilter = { company_id }` and `express.json()`.

---

## A. `buildRobotCallSlot` — ISO → slot_json conversion + validation (unit)

### TC-SP-01 (P0, Unit/jest) — valid ISO → canonical slot_json in company tz
- **Scenario:** Conversion contract / S1.
- **Setup:** mock `slotEngineService.resolveTimezone` → `'America/New_York'`; freeze `todayStr` ≤ the date.
- **Input:** `buildRobotCallSlot({ startIso:'2026-07-09T13:00:00Z', endIso:'2026-07-09T15:00:00Z' }, DEFAULT_COMPANY_ID)`.
- **Expected:** `{ ok:true, slot:{ key:'2026-07-09|09:00|11:00', date:'2026-07-09', start:'09:00',
  end:'11:00', label:'Wed Jul 9, 09:00–11:00' (formatSlotLabel), techName:null, confidence:null } }`
  (EDT = UTC−4). Uses `hourCycle h23`.
- **File:** `tests/partsCallService.test.js` (export `buildRobotCallSlot`).

### TC-SP-02 (P0, Unit/jest) — bad/unparseable ISO → invalid_slot
- **Input:** `startIso:'not-a-date'`; `startIso` empty; `endIso` missing.
- **Expected:** each → `{ ok:false, error:'invalid_slot' }`. No throw.
- **File:** `tests/partsCallService.test.js`.

### TC-SP-03 (P0, Unit/jest) — start ≥ end (instant) → invalid_slot
- **Input:** `start` instant ≥ `end` instant (equal, and reversed).
- **Expected:** `{ ok:false, error:'invalid_slot' }`.
- **File:** `tests/partsCallService.test.js`.

### TC-SP-04 (P1, Unit/jest) — window crosses company-local midnight → invalid_slot
- **Setup:** tz `America/New_York`; `startIso` 23:00 local, `endIso` 01:00 next-day local.
- **Expected:** `date(start)!==date(end)` → `{ ok:false, error:'invalid_slot' }`.
- **File:** `tests/partsCallService.test.js`.

### TC-SP-05 (P1, Unit/jest) — past day rejected, same-day allowed
- **Setup:** freeze company-local today = `2026-07-09`.
- **Input:** a window on `2026-07-08` → `invalid_slot`; a same-day `2026-07-09` window → `ok:true`.
- **File:** `tests/partsCallService.test.js`.

### TC-SP-06 (P1, Unit/jest) — beyond 60-day horizon rejected
- **Input:** `date = todayStr + 61d` → `invalid_slot`; `todayStr + 60d` → `ok:true`.
- **File:** `tests/partsCallService.test.js`.

## B. `startRobotCall` slot-passthrough (unit)

### TC-SP-07 (P0, Unit/jest) — valid slot → SKIP recommendSlots, enqueue that slot_json
- **Scenario:** S1/S3.
- **Setup:** `jobsService.getJobById` → DIALABLE_JOB; `settings.resolve` → `{enabled:true}`;
  company=DEFAULT_COMPANY_ID; spy `recommendSlots.run`; mock `resolveTimezone`.
- **Steps:** `startRobotCall(jobId, DEFAULT_COMPANY_ID, taskId, null, {startIso,endIso})`.
- **Expected:** `recommendSlots.run` NOT called; exactly one `INSERT … outbound_call_attempts` with
  `slot_json`=the built canonical slot; returns `{ ok:true, attemptId }`. SQL params include company_id.
- **File:** `tests/partsCallService.test.js`.

### TC-SP-08 (P0, Unit/jest) — invalid slot → reason:'invalid_slot', NO recommendSlots/INSERT, task NOT stamped
- **Scenario:** S5.
- **Steps:** `startRobotCall(..., null, {startIso:'bad'})`.
- **Expected:** returns `{ ok:false, reason:'invalid_slot' }`; `recommendSlots.run` NOT called; NO
  INSERT; `markRobotCallFailed` NOT called.
- **File:** `tests/partsCallService.test.js`.

### TC-SP-09 (P1, Unit/jest) — NO slot arg → auto-compute path unchanged (backward-compat)
- **Steps:** `startRobotCall(jobId, companyId, taskId)` (4-arg / no slot); `recommendSlots.run` →
  `{available:true,slots:[TOP_SLOT]}`.
- **Expected:** identical to today — `recommendSlots.run` called, top-1 stored, one attempt (existing
  TC-OPC-U04 stays green).
- **File:** `tests/partsCallService.test.js` (existing suite).

## C. Execute route body-threading + invalid_slot → 400 (integration/supertest)

### TC-SP-10 (P0, Integration/jest) — `req.body.slot` threaded → startRobotCall(…,null,slot), 200 queued
- **Scenario:** S1 wiring.
- **Setup:** mock `partsCallService.startRobotCall` → `{ ok:true, attemptId:7 }`.
- **Steps:** `POST /api/tasks/:id/actions/robot_call` body `{ slot:{ startIso, endIso } }` (manager).
- **Expected:** `startRobotCall` called `(jobId, company_id, taskId, null, {startIso,endIso})`
  (jobId from `parent_type==='job'?parent_id`); `200 { ok:true, data:{ ok:true, state:'queued',
  attemptId:7 } }`.
- **File:** `tests/tasksActionRoute.test.js` (extend).

### TC-SP-11 (P0, Integration/jest) — invalid_slot maps to HTTP 400
- **Scenario:** S5.
- **Setup:** `startRobotCall` stub → `{ ok:false, reason:'invalid_slot' }`.
- **Expected:** route responds **400** `{ ok:false, error:{code:'INVALID_SLOT'}, reason:'invalid_slot' }`
  (NOT 200). `runTaskAction` would throw on this.
- **File:** `tests/tasksActionRoute.test.js` (extend).

### TC-SP-12 (P1, Integration/jest) — non-slot domain refusals stay 200; bodyless → auto-compute
- **Steps:** (a) `startRobotCall` → `{ ok:false, reason:'no_phone' }` → route **200** `{ ok:true,
  data:{ ok:false, state:'failed', reason:'no_phone' } }`; (b) POST with NO body →
  `startRobotCall(jobId,company,taskId,null,undefined)` (auto-compute).
- **Expected:** only `invalid_slot` is 400; every other outcome stays the 200 envelope.
- **File:** `tests/tasksActionRoute.test.js` (extend).

### TC-SP-13 (P0, Integration/jest) — gates + scope (regression) + manual_call unchanged
- **Steps:** no `tasks.manage` → 403; unknown type → 400; foreign/absent id → 404; `manual_call` →
  directive unchanged.
- **Expected:** existing `tests/tasksActionRoute.test.js` cases stay 100% green (body is additive/optional).
- **File:** `tests/tasksActionRoute.test.js` (existing).

## D. Pulse open_task carries the job id (integration/jest)

### TC-SP-14 (P1, Integration/jest) — open_task exposes parent_id/parent_type
- **Scenario:** S8 (Pulse surface).
- **Steps:** exercise the by-contact assembly (`calls.js` open_task mapping) with a row whose
  `open_task_parent_id`/`open_task_parent_type` are set (job/jobId).
- **Expected:** assembled `open_task.parent_id`===jobId, `parent_type`==='job'; absent → null; the
  by-contact WHERE/ORDER BY/params byte-unchanged (LIST-PAGINATION-001 preserved).
- **File:** extend the pulse by-contact route/mapping test.

## E. Frontend — CustomTimeModal additivity + wrapper + buttons (logic-review / build)

### TC-SP-15 (P0, FE logic-review) — CustomTimeModal `title?`/`confirmLabel?` additive; reschedule byte-identical
- **Scenario:** Decision A.
- **Expected:** with both props omitted, L738 renders "Schedule Time Slot" and L950-952 renders
  `Confirm {HH:MM} – {HH:MM}` / `Select a timeslot` (reschedule + new-job callers unchanged). With
  `title="Schedule the robot call"` + `confirmLabel="Queue robot call"`, the header + enabled-CTA use
  them; the `disabled={!selectedSlot}` → `Select a timeslot` guard is UNCHANGED (explicit pick enforced).
- **File:** code-review of `CustomTimeModal.tsx`.

### TC-SP-16 (P0, FE logic-review) — wrapper `RobotCallSlotModal`: getJob → configured modal → POST
- **Scenario:** S1/S3/S5.
- **Expected:** on open `getJob(jobId)` → `newJobCoords`(lat&&lng)/`newJobAddress`/`territoryId`
  (`zb_raw?.territory?.id||service_territory?.id`)/`excludeJobId=jobId`; `onConfirm(slot)` →
  `runTaskAction(taskId,'robot_call',{slot:{startIso:slot.start,endIso:slot.end}})`; success → toast
  "Robot call queued" + `onQueued()` + close; failure (throw incl. 400) → toast reason + KEEP open;
  `getJob` failure → toast + close.
- **File:** code-review of NEW `RobotCallSlotModal.tsx`.

### TC-SP-17 (P0, FE logic-review) — no-recs / no schedule.dispatch → manual pick STILL queues (NOT blocked)
- **Scenario:** S4/S6.
- **Expected:** empty recs column (engine off / app off / no coords / lacks `schedule.dispatch`) → the
  technician timelines still render; a timeline pick enables the CTA and queues. No blocking state
  forces 📞.
- **File:** code-review of the wrapper + CustomTimeModal recs branch.

### TC-SP-18 (P1, FE logic-review) — TaskActionButtons: 🤖 opens wrapper (no window.confirm); 📞 unchanged
- **Scenario:** S8, single-confirm.
- **Expected:** clicking 🤖 opens `<RobotCallSlotModal>` (the `window.confirm('Start automated call…')`
  is removed); no POST until the modal confirms; `manual_call` still dials with no confirm; failed-reason
  render + `tasks.manage` self-gate unchanged; robot button opens only when `jobId` present.
- **File:** code-review of `TaskActionButtons.tsx`.

### TC-SP-19 (P1, FE logic-review) — jobId wired on BOTH surfaces
- **Scenario:** S8.
- **Expected:** `TaskCard` passes `jobId={task.parent_type==='job'?task.parent_id:undefined}`;
  `PulsePage` passes `jobId={conv.open_task?.parent_type==='job'?conv.open_task.parent_id:undefined}`;
  `PulseTask` has `parent_id?`/`parent_type?`. Both resolve the same jobId the wrapper `getJob`s.
- **File:** code-review of `TaskCard.tsx` + `PulsePage.tsx` + `pulse.ts`.

### TC-SP-20 (P1, FE logic-review) — `runTaskAction(id,type,body?)` optional body
- **Expected:** with `body`, POST sends `Content-Type: application/json` + JSON body; 2-arg calls stay
  bodyless (regression-safe); a 400 response throws (feeds the wrapper's keep-open toast).
- **File:** code-review of `tasksApi.ts`.

### TC-SP-21 (P2, FE logic-review) — tokens + English UI + no layout regression
- **Expected:** the robot header/CTA copy is English; CustomTimeModal layout/recs/map unchanged for
  reschedule; `--blanc-*`/existing modal styles only.
- **File:** code-review.

### TC-SP-22 (P3, Build) — frontend build green
- **Steps:** `cd frontend && npm run build`.
- **Expected:** exit 0; `title?`/`confirmLabel?` typed on CustomTimeModal; `RobotCallSlotModal` typed;
  `TaskActionButtons.jobId?`; `runTaskAction` 3rd param optional; `PulseTask.parent_id?`; no
  `noUnusedLocals`.
- **File:** build.

---

## Regression / Protected (must stay green)
- **TC-SP-R1 (P0):** `tests/partsCallService.test.js` TC-OPC-U04/U04b/U05 (auto-compute, 23505
  in-flight, v1 gate) unchanged (no-slot path byte-equivalent).
- **TC-SP-R2 (P0):** `tests/tasksActionRoute.test.js` auth/scope/unknown/manual_call green; only the
  new invalid_slot→400 branch differs.
- **TC-SP-R3 (P1):** `tests/outboundCallWorker.test.js` slot_json copy-forward (S7) + `outboundCallService`
  `variableValues` unchanged.
- **TC-SP-R4 (P1):** schedule recs route + `fetchSlotRecommendations` + CustomTimeModal reschedule
  behavior UNCHANGED (`tests/slotEngineProxy.test.js` green; reschedule callers pass no title/confirmLabel).
- **TC-SP-R5 (P2):** Pulse by-contact pagination (LIST-PAGINATION-001) — only additive SELECT columns;
  cross-tenant isolation preserved. No new migration.

---

## Superseded (from the pre-redirect design — DO NOT implement)
- Old `TC-SP-10…13` (task-keyed recs route `POST /api/tasks/:id/slot-recommendations`) — the route is
  DROPPED; recs come from the existing schedule route via CustomTimeModal.
- Old `TC-SP-17…23` referencing a new `RobotCallDialog` with rec-rows + a `{date,start,end}` custom
  entry — REPLACED by CustomTimeModal reuse (ISO payload) + the wrapper tests above.
