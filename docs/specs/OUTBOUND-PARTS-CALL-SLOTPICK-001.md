# OUTBOUND-PARTS-CALL-SLOTPICK-001 — Spec: dispatcher picks the robot's slot by reusing the reschedule modal

## Overview
Extends OUTBOUND-PARTS-CALL-001 / -BTN-001. The 🤖 "Let the robot call" action on a
`part_arrived_call` task today fires a bare `window.confirm` and the backend auto-computes the top
slot (`startRobotCall` → `recommendSlots.run` → `slots[0]`). This spec replaces the confirm by
**reusing the existing reschedule form `CustomTimeModal.tsx`** (ranked recommendations + technician
timelines + map) — only the header and the CTA differ. The dispatcher must EXPLICITLY pick a slot
(a recommendation OR a manual click on a technician timeline) before it can queue the assistant; the
chosen window becomes the outbound attempt's `slot_json` and is offered to the customer verbatim on
the call.

**Owner redirect (2026-07-08):** do NOT build a new dialog and do NOT add a task-keyed recs route.
The modal already fetches recommendations itself via `POST /api/schedule/slot-recommendations` using
the job coords/address/territory the wrapper passes in as props. The modal emits ISO start/end; the
**server** converts ISO → company-timezone `date`/`start`/`end` and builds the canonical `slot_json`
(`key` + `label`) — the client label is never trusted. No new migration.

**Binding decisions (still hold):** recommendations are a convenience (top rows shown, engine-ranked);
a manual timeline pick is ALWAYS available; no-recs / engine-off does NOT block (the dispatcher clicks
a time on a technician lane and still queues); the modal is the SINGLE confirm (no extra
`window.confirm`); works on the Job card AND the Pulse AR banner (shared `TaskActionButtons`); the
chosen slot is pinned across retries. **Explicit pick is enforced by the modal's existing
`disabled={!selectedSlot}` CTA** — "Queue robot call" cannot fire until a slot is selected.

## Behavior scenarios

### S1 — Pick the top recommendation (happy path)
- **Pre:** job in `Part arrived`; open `part_arrived_call` task with `actions=[robot_call,manual_call]`;
  smart-slot-engine app connected; viewer has `tasks.manage` (+ `schedule.dispatch` to see recs);
  outbound v1 gate satisfied (Boston Masters `DEFAULT_COMPANY_ID` + `settings.enabled`).
- **Steps:** click 🤖 (Job card or Pulse AR) → `RobotCallSlotModal` wrapper `getJob(jobId)` → opens
  `CustomTimeModal` (title "Schedule the robot call", CTA "Queue robot call") → the modal fetches
  `POST /api/schedule/slot-recommendations` with the job's coords/territory/duration/exclude → the
  dispatcher clicks the top recommendation → the CTA enables → "Queue robot call".
- **Result:** the modal `onConfirm({type:'arrival_window', start:<ISO>, end:<ISO>, formatted, techId?})`;
  the wrapper POSTs `runTaskAction(id,'robot_call',{ slot:{ startIso:slot.start, endIso:slot.end } })`.
  Server `buildRobotCallSlot` converts ISO→company-local `date`/`start`/`end`, validates, builds
  `slot_json` (`key`, `label=formatSlotLabel(...)`, `techName:null`, `confidence:null`);
  `startRobotCall` SKIPS `recommendSlots` and enqueues one `pending` attempt with that `slot_json`.
  `200 { ok:true, data:{ ok:true, state:'queued', attemptId } }` → toast "Robot call queued",
  `onQueued()`, modal closes.
- **Side effects:** one row in `outbound_call_attempts` (company-scoped); the worker later places the
  VAPI call offering `slotLabel/slotDate/slotStart/slotEnd/slotKey`.

### S2 — Pick a different recommendation
- **Steps:** click a lower recommendation row (or a different tech's suggested window) instead of the
  top → "Queue robot call".
- **Result:** the queued `slot_json` reflects the selected window's instants; the server re-derives
  `date`/`start`/`end`/`key`/`label`.

### S3 — Manual pick on a technician timeline (always available)
- **Steps:** ignore the recs; click / drag a free block on a technician lane in the modal to set a
  `selectedSlot` → the CTA enables → "Queue robot call".
- **Result:** the modal emits the manually-chosen ISO window; the server converts + validates + queues
  it exactly as S1. Recommendations present or not, the manual pick is always offered.

### S4 — No recommendations → manual pick STILL queues (NOT blocked)
- **Pre:** `fetchSlotRecommendations` returns empty (engine returned nothing / `enabled:false` because
  the app is off / job has no coords → `canRecommend` false).
- **Steps:** click 🤖 → modal opens with an empty recs column but the technician timelines + map still
  render → the dispatcher clicks a time on a lane → "Queue robot call".
- **Result:** the manually-picked window is validated + queued. The dispatcher is NEVER forced to fall
  back to 📞 just because the engine was quiet. (The modal's recs column simply shows nothing; the
  timeline pick is the path.)

### S5 — Invalid slot → 400, surfaced live in the modal
- **Steps:** a slot that fails server validation reaches the backend — bad/unparseable ISO, `start ≥
  end`, a window crossing company-local midnight, a past day, or a day beyond the 60-day horizon
  (defensive: the modal client-guards past-time via `serverNow()`, but the server is the authority).
- **Result:** `buildRobotCallSlot` → `{ ok:false, error:'invalid_slot' }`; `startRobotCall` →
  `{ ok:false, reason:'invalid_slot' }`; the route responds **HTTP 400** `{ ok:false,
  error:{code:'INVALID_SLOT'}, reason:'invalid_slot' }`. `runTaskAction` throws → the wrapper toasts
  the reason and KEEPS the modal open so the dispatcher can re-pick. **Nothing is enqueued**;
  `recommendSlots` is NOT run; the task is NOT stamped failed (`markRobotCallFailed` not called).

### S6 — Permission / scope gates
- The 🤖 button self-gates on `tasks.manage` (`TaskActionButtons` L50) → never shown to a user who
  would 403 on the execute route.
- The recs fetch inside CustomTimeModal is gated `schedule.dispatch`. A user WITH `tasks.manage` but
  WITHOUT `schedule.dispatch` sees the modal with an **empty recs column** and can still manual-pick a
  timeline slot and queue (S4 path). Recommended audience: the dispatcher role holds both. No NEW
  gating is added that would break the existing modal for reschedule callers.
- The execute route is company-scoped via `req.companyFilter.company_id`; a foreign task id → 404. The
  client-supplied ISO window never influences company scope.

### S7 — Slot pinned across retries
- After a placed call goes no-answer/voicemail, the worker enqueues the next attempt copying
  `attempt.slot_json` forward (`outboundCallWorker.js` L307-312) — the dispatcher's chosen window is
  re-offered on every retry with no re-computation.

### S8 — Both surfaces (Job card + Pulse AR)
- The 🤖 button (and thus the modal) is the shared `TaskActionButtons`, mounted on the Job-card task
  stack (`TaskCard`) and the Pulse "Action Required" banner (`PulsePage`). Behavior is identical.
  `TaskActionButtons` takes a `jobId` prop: on the Job card `TaskCard` passes
  `task.parent_type==='job' ? task.parent_id`; on Pulse AR the open_task carries `parent_id`/
  `parent_type` (additive projection) → `PulsePage` passes it. The wrapper `getJob(jobId)` for coords
  on both. `onQueued` refetches the respective surface. (The part-arrived task is timeline-linked into
  Pulse AR via BTN-06, so both surfaces are live.)

## Edge cases
1. **Rec/manual pick drifts out of horizon between open and confirm:** re-validated server-side →
   `invalid_slot` → 400 (S5); the modal toasts and stays open.
2. **Double-press "Queue robot call":** the partial-unique index on
   `outbound_call_attempts(job_id) WHERE status IN ('pending','dialing')` collapses a duplicate →
   `startRobotCall` catches `23505` → `{ ok:true, already:true }` → `state:'in_flight_existing'` (200);
   the wrapper treats it as success and closes. No second attempt.
3. **Job left `Part arrived` (rescheduled/canceled) before queue:** `startRobotCall` step 1 →
   `not_dialable` (200 domain); the wrapper toasts, stays open. (Not a 400 — not a client-bad slot.)
4. **No customer phone:** `startRobotCall` step 3 → `no_phone` (task stamped, as today; 200 domain);
   the slot is built but no attempt is enqueued.
5. **Window crosses company-local midnight:** rejected as `invalid_slot` (the reduced `slot_json` is a
   single `date` + `start<end` HH:MM; an arrival window must be same-day).
6. **`getJob` fails / job has no coords:** the wrapper toasts and closes (no coords → the modal can't
   help); the recs column would be empty anyway. The dispatcher can use 📞 or retry.
7. **Company timezone:** the modal renders windows in company tz (`companyTz`); the server converts the
   emitted UTC instants back to company-local `date`/`start`/`end` via `slotEngineService.resolveTimezone`.
   The call offers the local strings verbatim — no tz math in the VAPI layer.
8. **Same-day slot:** allowed (the modal blocks past dates in its date-nav; the server allows `date ==
   todayStr` as grace; a same-day past *time* is caught by the modal's `serverNow()` guard).

## Error handling
- **Recs fetch:** `fetchSlotRecommendations` already resolves to a disabled/empty result on any
  HTTP/network error (never throws) → the modal shows an empty recs column (S4 path); NOT an error.
- **Queue POST:** `data.ok:false` non-slot domain outcomes (`no_phone`/`not_dialable`/`disabled`/
  `no_slots`) are **200** and toasted; an **invalid_slot** is **400** (throws) toasted; any other non-2xx
  / auth / network failure throws → toast the message. In all failure cases the wrapper keeps the modal
  open (except a hard `getJob` failure, which closes).
- **Refetch after a queued call** failing is silent (the queue toast already confirmed).

## Component interaction
- **Open:** `TaskActionButtons` (`TaskCard` / `PulsePage`) → `RobotCallSlotModal(taskId, jobId)`
  (replaces `window.confirm`). `manual_call` (📞) unchanged (dials, no confirm).
- **Configure:** `RobotCallSlotModal` → `getJob(jobId)` → `<CustomTimeModal title confirmLabel
  newJobCoords newJobAddress territoryId excludeJobId onConfirm/>`.
- **Recs (inside modal):** `CustomTimeModal` → `fetchSlotRecommendations({coords,territory,duration,exclude})`
  → `POST /api/schedule/slot-recommendations` (unchanged; gated `schedule.dispatch`).
- **Queue:** `CustomTimeModal.onConfirm(slot)` → wrapper → `runTaskAction(id,'robot_call',{slot:{startIso,endIso}})`
  → `POST /api/tasks/:id/actions/robot_call` (body `{slot}`) → route threads `req.body.slot` → registry
  `robotCall` → `startRobotCall(jobId,companyId,taskId,null,slot)` → `buildRobotCallSlot` → INSERT.
- **Dial (later):** `outboundCallWorker` → `outboundCallService.placeCall` (VAPI). No new SSE.

## API contract
- **`POST /api/tasks/:id/actions/robot_call`** — contract UNCHANGED except the body is now optionally
  `{ slot:{ startIso:'<ISO>', endIso:'<ISO>', techName? } }`. Same gate `tasks.manage`; company-scoped;
  foreign id → 404.
  - Valid slot → `200 { ok:true, data:{ ok:true, state:'queued'|'in_flight_existing', attemptId } }`.
  - **Invalid slot → `400 { ok:false, error:{ code:'INVALID_SLOT' }, reason:'invalid_slot' }`** (client
    error, surfaced live in the modal; nothing enqueued, task not stamped).
  - Non-slot domain refusal (`no_phone`/`not_dialable`/`disabled`/`no_slots`) → `200 { ok:true,
    data:{ ok:false, state:'failed', reason } }` (unchanged).
  - NO `slot` in the body → pre-existing auto-compute path runs (backward-compat for non-dispatcher
    callers).
- **NO new route.** Recommendations come from the EXISTING `POST /api/schedule/slot-recommendations`
  (unchanged), called by CustomTimeModal with the wrapper-supplied job coords.

## Conversion contract (server-built — never trust the client)
- **Modal → FE payload:** `{ type:'arrival_window', start:<ISO>, end:<ISO>, formatted, techId? }`
  (start/end are `Date.toISOString()`; UTC instants).
- **Wrapper → body:** `{ slot:{ startIso:slot.start, endIso:slot.end } }` (`techName` omitted — the
  modal returns `techId`, not a name; the call doesn't consume techName → it lands `null`).
- **`{startIso,endIso}` → canonical `slot_json` (server `buildRobotCallSlot`):** resolve company tz →
  `date` (company-local `YYYY-MM-DD`) + `start`/`end` (company-local `HH:MM`, `hourCycle h23`) from the
  instants → `{ key:`${date}|${start}|${end}`, date, start, end, label:formatSlotLabel(date,start,end),
  techName:techName||null, confidence:null }`.

## Validation rules (`buildRobotCallSlot`, server authority)
Return `{ ok:false, error:'invalid_slot' }` (→ route 400) on ANY failure; else `{ ok:true, slot }`:
1. `startIso`, `endIso` parse to valid Dates.
2. instant `start < end`.
3. company-local `date(start) === date(end)` (no midnight crossing).
4. `date >= todayStr` (company-local today via `resolveTimezone`; same-day allowed = grace).
5. `date <= todayStr + 60d` (HORIZON).

## Data isolation
- The execute route is company-scoped via `req.companyFilter.company_id`; a foreign task id → 404.
- The recs snapshot uses server-derived job coords (the wrapper `getJob`s the company's own job); the
  client-supplied ISO window never influences company scope. The Pulse open_task `parent_id` projection
  stays inside the existing `tl.company_id=$1` by-contact query.

## Non-goals
- A new dialog (`RobotCallDialog`) or a task-keyed recs route — SUPERSEDED; the reschedule modal is
  reused (owner redirect).
- Changing CustomTimeModal's layout, recs fetch, `onConfirm` payload, or the `disabled={!selectedSlot}`
  guard; changing the schedule recs route; changing the outbound worker/VAPI lifecycle or the
  auto-compute path of `startRobotCall`.
- A new migration (`outbound_call_attempts.slot_json` is live).
- Preserving `techName`/`confidence` for a dispatcher-chosen slot (null by design; the call consumes
  only `slotLabel/Date/Start/End/Key`).
- Booking on the customer's behalf here — the VAPI agent books on the call from the offered slot.
