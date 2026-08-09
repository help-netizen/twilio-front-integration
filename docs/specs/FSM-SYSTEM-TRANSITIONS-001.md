# FSM-SYSTEM-TRANSITIONS-001 — system statuses carry behaviour, custom ones don't

Status: spec for a tandem build (owner decisions 2026-08-05). Depends on the
DB-driven per-company job FSM (fsm_versions SCXML, `blanc:*` attrs), ONWAY-001
(the ETA modal), FSM-JOB-ACTIONS-001 (buttons from FSM).

## 1. The problem

Job status changes now flow through the per-company FSM status editor as plain
edges. "On the way" therefore became a plain transition — and its arrival-time
behaviour (notify the customer with an ETA) is a **separate frontend hardcode**
(`JobStatusTags.tsx`: `ONWAY_SOURCE_STATUSES = ['Submitted','Rescheduled','Part
arrived']`). When a company's FSM reaches "On the way" from any status outside
that fixed list, the transition runs plain — no modal, no customer notification.
The hardcode and the FSM are two un-synced systems.

## 2. The model (owner-decided)

A status is either **system** (reserved identity, may carry baked behaviour) or
**custom** (user-created, a plain transition, no attachable logic yet).

**System statuses (v1):** the **start** status, the two **final** statuses
*Visit completed* and *Job is Done*, and **On the way**. Everything else
(Submitted, Rescheduled, Part arrived, Canceled, Follow Up with Client, and any
user status) is custom.

Only **On the way** carries *behaviour* in v1; start/final carry *structural*
roles the FSM already models (`<initial>`, `<final>`). The mechanism is
extensible — new behavioural system statuses attach the same way later.

**On the way's behaviour, restated (owner):** pressing a transition into "On the
way" **always performs the status change immediately** (it is an ordinary FSM
transition). *After* it lands, the ETA modal pops up: the tech may send the
customer an arrival time, or just close it. Closing does **not** revert the
status — notification is optional, the transition is not. This is a change from
today, where the modal both sends and transitions; now the transition is plain
and the modal is a post-hoc, notify-only side effect.

## 3. Where the behaviour lives — on the state, not each edge

The op is a property of **entering** the On-the-way state, declared once on the
state:

```xml
<state id="On_the_way" blanc:label="On the way" blanc:statusName="On the way"
       blanc:system="on_the_way" blanc:op="arrival_eta"> … </state>
```

`blanc:system="<kind>"` marks a reserved status (`start` on the initial state,
`visit_completed` / `job_done` on the two finals, `on_the_way` on this one).
`blanc:op="arrival_eta"` is the behaviour. Attaching to the state (not each
inbound edge) means no edge can be forgotten and the editor cannot detach it by
editing one transition — any edge into the state inherits the behaviour. The
editor still *presents* inbound edges to a system state as "system transitions"
whose behaviour is read-only, but the source of truth is the state.

## 4. Backend (Codex)

- **fsmService.parseStateNode**: parse `blanc:system` and `blanc:op` onto the
  state object; surface `op` (and the target state's `system`/`op`) on the
  action/transition objects the API returns, so the frontend sees, for each
  reachable target, whether entering it triggers an op.
- **Migration**: mark the existing "On the way" state in every company's
  published fsm_versions with `blanc:system="on_the_way"` and
  `blanc:op="arrival_eta"`; mark initial with `blanc:system="start"` and the two
  finals with their kinds. Mirror the `onTheWayTransform` / migration-127
  pattern (idempotent, additive, guarded by a marker), and update the canonical
  `fsm/job.scxml` + the 073 seed so new companies get it.
- **Notify endpoint**: today `/:id/eta/notify` sends the SMS **and** sets the
  status. Split them: the status change now happens via the normal FSM
  transition, so the modal needs a **notify-only** path that sends the ETA SMS
  and does not touch status (idempotent if already "On the way"). Keep the old
  combined endpoint working for any caller still on it, or migrate its single
  caller. Timeline/audit of the notification unchanged.
- Tests: parse of system/op; migration idempotency + marker; notify-only path
  sends without changing status; T-blast unaffected.

## 5. Frontend (team lead)

- **Job card transition handler** (`JobStatusTags` / `JobDetailHeader`): delete
  the `ONWAY_SOURCE_STATUSES` hardcode. When the user picks a target whose FSM
  entry carries `op === 'arrival_eta'`, perform the ordinary status change, then
  open the ETA modal. The modal is now shown for **every** source status that
  can reach On the way — the regression is gone, driven by the FSM, not a list.
- **ETA modal** (`OnTheWayModal`): the status is already "On the way" when it
  opens. Its primary action becomes notify-only (send the ETA SMS); closing it
  is a first-class outcome (no notification, status stays). Copy adjusted so it
  reads as "let the customer know you're on the way," not "mark on the way."
- Permission: notifying still needs `messages.send`; the transition itself is
  gated by the FSM/role as any status change is. A tech without `messages.send`
  still transitions to On the way — they just don't get the notify modal.

## 6. Phase 2 — the editor (separate tandem cycle)

The status editor (`WorkflowBuilderPage`) gains an **add-status catalog**: pick
a **system status** from the reserved set (start / Visit completed / Job is Done
/ On the way — bringing its name, colour and, for On the way, its locked op) or
**create a custom status** (plain, no behaviour). Inbound edges to a system
status render their behaviour as read-only; a custom status's edges are plain.
Removing a system status from the flow is allowed; re-adding restores its baked
identity. Custom per-edge logic between arbitrary vertices is explicitly later.

Phase 1 (§4–5) fixes the live regression and establishes the FSM-native
mechanism; Phase 2 makes the editor express it. Ship Phase 1 first.

## 7. Verification

Phase 1: a company whose FSM reaches On the way from a status outside the old
hardcode list gets the modal (regression test); the transition lands before the
modal and survives closing it; notify-only sends without a second status write;
migration marks existing FSMs idempotently; sabotage — drop the `op` surfacing
in the API → the card stops opening the modal → red.
