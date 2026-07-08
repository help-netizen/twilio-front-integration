# OUTBOUND-PARTS-CALL-BTN-001 — Spec: surface the part-arrived task's action buttons (Job card + Pulse AR)

## Overview
Completes the TASK-ACTIONS slice of OUTBOUND-PARTS-CALL-001. The typed-action backend
(registry `robot_call`/`manual_call`, execute route `POST /api/tasks/:id/actions/:type`,
`tasks.actions` jsonb — mig 157) and the `TaskCard` renderer already shipped; the read
projection never returned `actions`, so the buttons rendered nowhere. This spec covers:
(1) the read-projection fix, (2) a shared `TaskActionButtons` component with a confirm on
`robot_call`, and (3) hydrating `actions` into the Pulse "Action Required" open_task so the
same buttons appear there. No new migration; the execute route and registry are byte-unchanged.

## Behavior scenarios

### S-BTN-1 — Job card shows the buttons (the fix)
- **Pre:** a job in `Part arrived`; `partsCallService.onPartArrived` created one OPEN,
  job-parented task `kind='part_arrived_call'`,
  `actions=[{type:'robot_call',label:'🤖 Let the robot call'},{type:'manual_call',label:"📞 I'll call myself"}]`;
  viewer has `tasks.manage`.
- **Steps:** open the Job card → NotesSection → TaskStack → TaskCard.
- **Result:** `SELECT_TASK` now returns `actions`; TaskCard's guard
  (`canAct && !done && task.actions?.length`) passes; `TaskActionButtons` renders 🤖 and 📞.

### S-BTN-2 — 🤖 robot_call confirms, then queues
- **Steps:** click 🤖 → `window.confirm('Start automated call to the customer?')`.
  - Confirm → `POST /api/tasks/:id/actions/robot_call`; spinner on the button; `data.ok:true`
    → toast "Robot call queued" + `onChanged()` refetch; `data.ok:false` → toast `data.reason`.
  - Cancel → no POST, no spinner, no state change.

### S-BTN-3 — 📞 manual_call dials, no confirm
- **Steps:** click 📞 → `POST /actions/manual_call` (NO confirm) →
  `data.client={action:'open_softphone',phone,contactName}` → desktop `openDialer(phone,contactName)`;
  mobile `tel:` (MOBILE-NO-SOFTPHONE-001). No mutation, no refetch. If `phone` null → toast
  "No reachable number for this task".

### S-BTN-4 — Pulse AR shows the same buttons (timeline-parented action task)
- **Pre:** an OPEN action task whose parent is the contact's timeline (thread) → surfaces as
  Pulse `open_task`.
- **Steps:** select the contact in Pulse → AR banner (not snoozed) → `TaskActionButtons` renders
  with `taskId=open_task.id`, `actions=open_task.actions`, `onChanged=p.refetchContacts`.
- **Result:** identical confirm/dial behavior to S-BTN-2/3.

### S-BTN-5 — pre-call failure surfaces a reason
- After a robot_call that couldn't dial (no slots / no phone), `partsCallService.markRobotCallFailed`
  stamped `state:'failed'`+`reason` onto the `robot_call` action; on refetch, `TaskActionButtons`
  shows the reason under the button; the dispatcher falls back to 📞.

## Edge cases
1. **owner_user_id = NULL (the actual part-arrived task):** Job-card TaskStack `canActOn` =
   manage-or-own; with owner NULL only `tasks.manage` users match → they see the buttons.
   `TaskActionButtons` additionally self-gates on `tasks.manage`, so a non-manager never sees a
   button (matches the route).
2. **Non-manager without `tasks.manage`:** no buttons on EITHER surface (self-gate) — and the
   route would 403 anyway. No latent 403-on-click.
3. **Task already handled/closed:** completing the task → Job card drops it from the open list;
   Pulse `has_open_task` → false → the whole AR banner disappears. Buttons also guard `!done`.
4. **Robot call in-flight / double-press:** the button disables while a request runs (per-component
   `runningType`); server idempotency (partial-unique `outbound_call_attempts(job_id) WHERE status
   IN ('pending','dialing')`) collapses a duplicate → `state:'in_flight_existing'`, no second dial.
5. **manual_call with no phone:** route returns `client.phone=null` (200) → toast "No reachable
   number", no dial.
6. **Snoozed Pulse thread:** the AR action row (Done/Snooze/Assign + the new buttons) is hidden
   while snoozed — consistent with today.
7. **Part-arrived task is job-parented (VERIFIED):** it renders on the Job card; it does NOT reach
   Pulse AR (the open_task LATERAL keys on `thread_id = tl.id`). The Pulse wiring future-proofs
   timeline-parented action tasks; making the part-arrived task Pulse-actionable requires
   `onPartArrived` to thread-link it (separate change, out of scope).
8. **actions absent (legacy task):** `actions` null → no button block (guard `actions?.length>0`);
   every non-action task (notes/AR/agent) is visually unchanged.

## Error handling
- Non-2xx / auth / network on execute → `runTaskAction` throws → toast the message; no state change.
- `data.ok:false` (domain, e.g. no_slots) is a **200, not a throw** → toast `data.reason`; the task
  stays open for the 📞 fallback.
- Refetch failure after a queued robot_call → silent (the toast already confirmed the queue); the
  next list load reconciles.

## Component interaction
- **Job card:** NotesSection → TaskStack → TaskCard → `TaskActionButtons` → `runTaskAction` →
  `POST /api/tasks/:id/actions/:type`.
- **Pulse:** PulsePage AR banner → `TaskActionButtons` → same route; `onChanged` = `p.refetchContacts()`
  (re-runs the by-contact query → fresh `open_task.actions`).
- **Data:** `SELECT_TASK` (tasksQueries) feeds the Job card; the by-contact open_task LATERAL
  (timelinesQueries) + calls.js feed Pulse. `TaskActionButtons` self-gates via
  `useAuthz().hasPermission('tasks.manage')`.
- No new SSE.

## API contract
- **`POST /api/tasks/:id/actions/:type`** — **UNCHANGED.** Auth: authedFetch;
  `authenticate → requireCompanyAccess → requirePermission('tasks.manage')`; company =
  `req.companyFilter.company_id`. `:type ∉ {robot_call,manual_call}` → 400; foreign/absent id → 404.
  Response `{ ok:true, data }`:
  - robot_call → `data = { ok:true, state:'queued'|'in_flight_existing', attemptId }` or
    `{ ok:false, state:'failed', reason }`.
  - manual_call → `data = { ok:true, state:'idle', client:{ action:'open_softphone', phone, contactName } }`.
- **Pulse by-contact list** — the `open_task` object now carries `actions: TaskAction[] | null`
  (`TaskAction = { type, label, state?, reason? }`). Additive; all other fields and the pagination
  contract (LIST-PAGINATION-001) unchanged.

## Data isolation
- Execute route is company-scoped (foreign id → 404); registry handlers never re-derive scope from
  client input.
- Pulse hydration stays inside the existing `tl.company_id = $1` by-contact query; `actions` is
  projected from a `company_id`-matched task row.

## Non-goals
- Changing the registry, the execute route, or the outbound-call/VAPI lifecycle.
- Thread-linking the part-arrived task so it appears in Pulse AR.
- Persisting new action states beyond the existing `markRobotCallFailed`.
- A styled confirm dialog (`window.confirm` ships; a FORM-CANON ConfirmDialog is an optional upgrade).
- The `/tasks` page (out of scope by owner decision).
