# OUTBOUND-PARTS-CALL-CANCEL-001 — Spec: cancel the queued robot call on status-leave or shared customer contact

## Overview
Extends OUTBOUND-PARTS-CALL-001/-BTN/-SLOTPICK/-TECHSLOT and OUTBOUND-CALL-TIMELINE-001. The
part-arrived robot-call queue (`outbound_call_attempts`) must run ONLY while the job is in
`Part arrived`. Today the only net is the worker's dial-time Guard-1
(`outboundCallWorker.js:193-201` — terminates a claimed attempt as dishonest `'failed'`, no note),
and the webhook retry path (`vapiCallStatus.js:296-305`) re-inserts retries with NO job-status
check at all (resurrection). This spec adds:

1. **Status-change cancel** — leave-hooks on every `blanc_status` writer that can exit `Part arrived`.
2. **Customer-contact cancel** — the shared `outboundCallCancellationService`: a real completed
   conversation with the customer (either direction, human-answered) or an inbound customer SMS
   cancels every outbound-agent plan for that company/phone, including this parts plan.
3. **Job note + task stamp** — every cancellation writes one English job note (why) and stamps the
   task's `robot_call` action `state:'canceled'` + reason; re-queue resets the stamp to `'queued'`.
4. **No-resurrection guard** — the retry INSERT (webhook + worker) is skipped when the job left
   `Part arrived` or the chain has a newer `canceled` row.

**Binding decisions (owner defaults, recorded):** a `dialing` (in-flight) attempt is NOT killed
mid-call — only `pending` rows flip; resurrection via the retry chain is blocked instead;
dispatcher may re-queue after any cancel (server dialable guards re-check); everything
company-scoped; **NO migration** — `outbound_call_attempts.status` has no CHECK constraint
(mig 158: plain TEXT, `canceled` already in the column COMMENT vocabulary, `reason` column exists,
the partial unique index only covers `pending|dialing`). Migration 161 is NOT needed.

**Structural invariant used throughout:** the partial unique index
`uq_outbound_call_attempts_active_job (job_id) WHERE status IN ('pending','dialing')` guarantees at
most ONE active row per job — so a cancel event sees either one `pending` row (flip it) or one
`dialing` row (leave it, insert a `canceled` marker row for the guard) or nothing (no-op).

**Shared customer-contact seam:** `backend/src/services/outboundCallCancellationService.js` owns
the scenario-agnostic `cancel({companyId, rawPhone, cause, contactAt})` lookup. Its frozen
`SCENARIO_HANDLERS` map (`Object.freeze`) declares `lead_call → leads.structured_notes` and
`parts_visit → jobs.notes + canceled-marker/task-stamp side effects`; scenario does not participate
in the active-attempt lookup. A future outbound agent joins the same rules by adding one registry
entry with its note target and side-effect hook, not by adding another trigger path.

## Exact copy (FR-3)
- Status change: `AI: robot call canceled — job left 'Part arrived' (status changed to '<newStatus>').`
- Human contact: `AI: robot call canceled — customer was already reached by phone (<inbound|outbound> call completed at <ISO-8601 time>).`
- Inbound SMS: `AI: robot call canceled — customer replied by SMS.`
- Suffix when a `dialing` row existed at cancel time: ` A call already in progress will not be retried.`
- Task-action stamp reasons (short): `Canceled — job status changed to '<newStatus>'.` /
  `Canceled — customer was already reached by phone.` / `Canceled — customer replied by SMS.`
- Status-leave notes retain the existing `'AI Phone'` author path. Shared customer-contact notes are
  appended transactionally to `jobs.notes` with JSON metadata `author:'AI Phone'`,
  `created_by:'system'` (no fake `crm_users` FK actor).

## Trigger-2 predicate (canonical)
Hook condition on the `upsertCall` RESULT row in `processVoiceEvent` (after `inboxWorker.js:383`):

```
!skipUpsert AND call IS NOT NULL            -- upsert actually applied (monotonic guard passed)
AND call.is_final = true
AND call.status = 'completed'               -- excludes no-answer/busy/failed/canceled/voicemail_left
AND call.parent_call_sid IS NULL            -- parent (customer-facing) rows only
AND COALESCE(call.duration_sec, 0) > 0
AND call.answered_at IS NOT NULL            -- somebody actually picked up (kills IVR-hangup)
AND call.direction IN ('inbound','outbound')
```

then inside `backend/src/services/outboundCallCancellationService.js` →
`cancelForCompletedCustomerCall(call)` — AI exclusions:

```
call.call_sid NOT LIKE 'vapi:%'             -- synthetic robot row (pre-re-key)
AND COALESCE(call.answered_by,'') <> 'ai'   -- robot row post-re-key (vapiCallTimelineService marker)
AND NOT saraHandled(call)                   -- call_flow_executions row for call_sid whose
                                            -- current_node_id resolves to kind='vapi_agent' in
                                            -- context_json.graph.states (callFlowRuntime.js:610-613
                                            -- leaves the execution ON the vapi node on vapi.completed)
```

attempt match (company-scoped, external number = `from_number` for inbound / `to_number` for outbound):

```sql
SELECT id, scenario, job_id, lead_uuid, task_id, status, attempt_no
FROM outbound_call_attempts
WHERE company_id = $1                       -- = call.company_id (from the row, never the payload)
  AND status IN ('pending','dialing')
  AND (
        regexp_replace(COALESCE(phone,''), '\D', '', 'g') = $2
     OR (length($2) = 11 AND left($2,1) = '1'
         AND regexp_replace(COALESCE(phone,''), '\D', '', 'g') ~ '^(1)?[0-9]{10}$'
         AND RIGHT(regexp_replace(COALESCE(phone,''), '\D', '', 'g'),10) = RIGHT($2,10))
      )
-- $2 = canonical digits(external number); NO scenario predicate
```

Voicemail vocabulary (verified `stateMachine.js:31-46` + `inboxWorker.js`): voicemail is
`voicemail_recording` (non-final) → `voicemail_left` (final) — never `completed`, and the
skipUpsert/preserve guards (`inboxWorker.js:283-314`) prevent Twilio's trailing `completed` from
overwriting them, so voicemail can never satisfy the predicate.

## Behavior scenarios

### S1 — Job leaves `Part arrived` (manual PATCH) → pending canceled + note + task stamp
- **Pre:** job `Part arrived`; one `pending` attempt (from 🤖 press); open `part_arrived_call` task.
- **Steps:** dispatcher PATCHes blanc-status → `updateBlancStatus(jobId,'Rescheduled',companyId)`
  (`jobs.js:281`) → UPDATE commits → leave-hook fires (fire-and-forget, symmetric to the
  `onPartArrived` enter-hook at `jobsService.js:976`).
- **Result:** the pending row → `status='canceled'`, `reason='status_change:Rescheduled'`; job note
  `AI: robot call canceled — job left 'Part arrived' (status changed to 'Rescheduled').`; task's
  `robot_call` action → `{state:'canceled', reason:"Canceled — job status changed to 'Rescheduled'."}`;
  event `outbound_call_canceled`. The status transition itself is unaffected (hook is non-fatal).

### S2 — FSM side-door `/apply` → same cancel (updateBlancStatus + cancelJob coverage)
- `POST /fsm/job/apply` routes to `updateBlancStatus` (`fsm.js:278`) → covered by S1's hook. A
  `Canceled` target routes to `jobsService.cancelJob` (`fsm.js:276`), which writes `blanc_status`
  DIRECTLY (`jobsService.js:1298`, bypassing updateBlancStatus) → its own leave-hook fires with
  newStatus `'Canceled'`. `markComplete` (`jobsService.js:1355`, `jobs.js:607`) likewise with
  `'Visit completed'`.

### S3 — ZB sync flips `zb_canceled` on a Part-arrived job → cancel
- **Verified:** `syncFromZenbooker` can NEVER move a job out of `Part arrived` via `blanc_status`
  (`Part arrived` ∉ `autoStatuses`, preserved at `jobsService.js:1105-1120`). The only sync-borne
  exit is `zb_canceled false→true` (written unconditionally at :1139).
- **Result:** when `existing.blanc_status==='Part arrived' && !existing.zb_canceled && cols.zb_canceled`
  → cancel with newStatus `'Canceled (Zenbooker)'`. All other sync writes: no hook, no behavior change.

### S4 — Human inbound completed → cancel + note
- **Pre:** pending attempt for contact C (attempt.contact_id=C, phone +1617…); customer C calls in,
  a dispatcher answers (child leg answered → parent `answered_at`/`answered_by` stamped,
  `inboxWorker.js:436-447`), talk 90s, hang up. Parent's Twilio `completed` event flows through
  `upsertCall` → final row `completed`, `duration_sec=90`.
- **Result:** hook fires → predicate passes → attempt canceled + note
  `AI: robot call canceled — customer was already reached by phone (inbound call completed at 2026-07-10T15:42:00.000Z).`
  + task stamp. Job status remains `Part arrived`; the task stays open (dispatcher decides next).

### S5 — Outbound dispatcher call completed → cancel + note
- Dispatcher dials the customer from the softphone (or via the task's 📞 `manual_call`); customer
  answers; parent outbound row finalizes `completed` with `duration_sec>0` and `answered_at`.
- **Result:** same as S4 with `(outbound call completed at …)`. Match uses canonical phone digits:
  exact for international numbers and equivalent 10/11-digit NANP forms for formatted parts phones.

### S5b — Inbound SMS → the same cross-scenario cancellation
- `conversationsService` persists an inbound customer-authored message, then emits `sms.inbound`
  with authoritative `company_id` and `customer_e164`. The shared subscriber calls the same
  `cancel({companyId, rawPhone, cause:'customer_replied_by_sms'})` core.
- **Result:** the parts retry plan is canceled with the SMS job note/task-stamp copy. Outbound SMS
  never emits `sms.inbound`, so it can never invoke cancellation.

### S6 — Voicemail / no-answer / busy / IVR-hangup → NO cancel
- Missed inbound → `no-answer` or `voicemail_recording→voicemail_left` (status ≠ completed → skip).
- Twilio's trailing `completed` for those calls → `skipUpsert` (`inboxWorker.js:303-311`) → hook
  never sees it.
- Caller listens to IVR greeting and hangs up (no Dial answered): parent `completed` but
  `answered_at IS NULL` (in-progress guard `inboxWorker.js:329-341` kept it `ringing`) → skip.
- Outbound no-answer/busy/failed → status ≠ completed → skip.

### S7 — Robot's own call → NO cancel
- Robot rows are written by `vapiCallTimelineService` (NOT via `processVoiceEvent`) and always carry
  `answered_by='ai'` (`markAnsweredByAi` :105-111; re-key merge `COALESCE(answered_by,$4,$6)` with
  `AI_ANSWERED_BY` :142-150) and start life as `vapi:%` sids. Belt-and-braces: even if such a row
  ever reached the hook, both AI exclusions drop it.

### S8 — Sara (AI-answered inbound) → NO cancel
- Inbound routed to `vapi_agent` node: Sara's leg is a `<Sip>` dial (`callFlowRuntime.js:467-479`) —
  the parent gets `answered_by=<sip-username>` (NOT `'ai'`), so the discriminator is the flow
  execution: on `vapi.completed` the execution is completed while `current_node_id` STAYS on the
  vapi node (`callFlowRuntime.js:610-613`). `saraHandled(call)` = load `call_flow_executions` by
  `call_sid` (unique index, mig 091), `JSON.parse(context_json)` (TEXT column), find
  `graph.states[id===current_node_id].kind === 'vapi_agent'` → excluded, plan survives.
- If Sara FORWARDED to a human queue (vapi.failed/timeout edges), the execution advanced to a
  queue/transfer node → not excluded → a completed human conversation cancels (correct).

### S9 — Dialing attempt survives; its failed retry does NOT resurrect
- **Pre:** attempt A `dialing` (robot mid-call). Cancel event arrives (either trigger).
- **Cancel behavior:** no pending row exists (partial-unique invariant) → nothing flipped; a
  `canceled` MARKER row M is inserted (copies company/job/task/contact/phone/attempt_no, reason;
  precedent: exhausted marker `vapiCallStatus.js:320-327`); task stamped; note written with the
  ` A call already in progress will not be retried.` suffix. A is NOT touched (call not killed).
- **Webhook later:** end-of-call for A → A marked `no_answer|voicemail|failed` (honest, unchanged)
  → retry guard: `isChainCanceled(companyId, jobId, A.id)` finds M (`id > A.id`) → NO retry INSERT,
  NO exhausted marker, NO "next attempt" note; event `outbound_call_retry_skipped`. Booked branch
  unaffected (a mid-call booking still lands `booked`).

### S10 — Status-leave race with in-flight webhook (belt #2 of the guard)
- Job leaves `Part arrived` while A is `dialing`; even if the marker write failed (hook is
  best-effort), the guard's company-scoped job re-read (`getJobById(jobId, companyId)` →
  `!job || zb_canceled || blanc_status !== 'Part arrived'`) independently blocks the retry INSERT.
  The same compound guard runs in `outboundCallWorker.scheduleRetryOrExhaust` before its INSERT
  (`outboundCallWorker.js:330-339`) — both insertion sites share one helper.

### S11 — Worker Guard-1 becomes the honest net
- A pending row that somehow survives to claim time on a non-dialable job (hook missed — e.g. the
  accepted `createJob` ON CONFLICT race, direct SQL): Guard-1 now terminates it as `'canceled'`
  (was `'failed'`) with the same reason vocabulary + writes the cancel note + stamps the task.
  `job_not_found` keeps `'failed'` and writes nothing (no job to note on).

### S12 — Re-queue after cancel is allowed and visible
- Dispatcher presses 🤖 again after any cancel: `startRobotCall` guards re-check dialability
  (`partsCallService.js:330-333` — job must be `Part arrived` again/non-canceled); on successful
  enqueue (fresh AND `already:true`) it stamps the `robot_call` action `{state:'queued', reason:null}`,
  clearing the `canceled` stamp. Old `canceled` rows have SMALLER ids than the new chain's attempts,
  so `isChainCanceled(…, newAttempt.id)` is false — the guard never blocks the new chain.

### S13 — Idempotency
- Second final webhook, repeated inbound SMS, or repeated status change: the active-rows SELECT finds
  nothing (already canceled/terminal) → `{canceled:0}` → NO second note, NO second stamp, no marker.
- Cancel racing the claim-loop: the flip UPDATE re-checks `status='pending'`; if the worker claimed
  first, the row is treated as `dialing` (marker path). Rows never end half-canceled.

### S14 — Company isolation
- All reads/writes filter `company_id`. The phone-digit match runs INSIDE the company-scoped active
  subset (`idx_outbound_call_attempts_claim` prefix). A completed call in company B never cancels
  company A's attempts even for the same phone number; `call.company_id` comes from the stored row
  (tenant resolved by AccountSid at ingest, `inboxWorker.js:149-156`), never from payload.

### S15 — Robot's own successful booking: booked-before-flip (reviewer fix, CC-07)
- **Defect:** `confirmPartsVisit` flips the job 'Part arrived'→'Rescheduled'
  (`jobsService.updateBlancStatus`) DURING the robot's own call — the S1 leave-hook then found the
  robot's OWN `dialing` attempt active → mid-flight `canceled` marker + the FALSE note
  `AI: robot call canceled — job left 'Part arrived' (status changed to 'Rescheduled').` right
  beside "Appointment rescheduled…", on EVERY successful robot booking.
- **Fix:** in the skill's success path, after the reschedule COMMITS and BEFORE the status flip,
  the skill terminalizes its own attempt:
  `UPDATE outbound_call_attempts SET status='booked', updated_at=now() WHERE company_id=$1 AND job_id=$2 AND status='dialing'`
  — job-scoped (no VAPI call id reaches the skill input: variableValues are injected at call-open,
  before the call id exists; the partial-unique invariant allows ≤1 active row per job). Non-fatal:
  a stamp fault never breaks the landed booking. ZB-conflict path: NO stamp (nothing landed — the
  attempt stays `dialing` for honest end-of-call classification).
- **Result:** the leave-hook's active-rows SELECT finds nothing → `{canceled:0}` → no note, no
  marker, no stamp, no event (S13 idempotency). The end-of-call webhook hits its
  `attempt.status !== 'dialing'` early-return (`vapiCallStatus.js:236`) — its own booked-stamp
  would have written the same terminal value; if the webhook ever raced first, the skill's UPDATE
  matches 0 rows (harmless both orders). An INBOUND (Sara) booking of the same job while a robot
  attempt dials gets the same honest terminalization (the visit is booked → the plan is moot);
  with no attempt at all the UPDATE matches 0 rows and the flow is unchanged.

## Failure semantics
- Every hook is fire-and-forget + internally try/caught (pattern: `jobsService.js:976-984`): a
  cancel failure NEVER fails a status change, the inbox worker loop, or the webhook's 200.
- Shared customer-contact cancellation never throws into ingestion, but its attempt mutation,
  local lead/job note, and transactional scenario side effects commit or roll back together.
  The parts-only status-leave hook retains its existing safe-fail behavior.
- No new tables, no new endpoints, no `src/server.js` changes.

## Out of scope
- Killing a `dialing` VAPI call mid-flight (explicit owner default).
- Email contact as a cancel trigger.
- AMD machine-detection for outbound dispatcher calls (Twilio classifies machine-answered dials as
  `completed` without AMD; owner accepts Twilio's classification).
- Backfill/cleanup of historical `failed` Guard-1 rows.
