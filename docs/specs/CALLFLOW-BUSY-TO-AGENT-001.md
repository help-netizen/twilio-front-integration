# CALLFLOW-BUSY-TO-AGENT-001 — business-hours queue exhaustion routes to Sara; voicemail is the LAST resort

**Status:** designed (data-only; no runtime code change)
**Requirements:** `docs/requirements.md` → `## CALLFLOW-BUSY-TO-AGENT-001` · **Architecture:** `docs/architecture.md` → same ID
**Scope:** ONE prod `call_flows` row — company `00000000-0000-0000-0000-000000000001`, flow `cf-bbd3689d` (group `ug-2385d69d`, 'Dispatch Team Flow'). No schema change, no deploy, no restart.

## General description

During business hours, when the Dispatch Team queue cannot connect the caller to a human — instantly (no available agent), after the Dial timeout (no answer), or on dial failure — the flow proceeds along its existing fallback edge to a NEW dedicated `vapi_agent` node ('AI Backup') that SIP-dials Sara. Only if Sara herself is unreachable/fails does the caller land on the business-hours voicemail. Implemented purely as a graph-data delta applied by an idempotent script; the runtime (`callFlowRuntime.js`) already supports every hop.

## Current prod graph (the transform's EXPECTED shape — refuse on drift)

States (9): `sk-start`(start) · `sk-hours-check`(branch) · `sk-current-group`(queue 'Dispatch Team') · `sk-vm-business-hours`(voicemail, `config.branchKey='business_hours'`) · `sk-vm-after-hours`(voicemail, `config.branchKey='after_hours'`) · `n-1780888101885`(vapi_agent 'AI Greeting') · `sk-done-routed`(final, hidden) · `sk-done-voicemail-business-hours`(final, hidden) · `sk-done-voicemail-after-hours`(final, hidden).

Transitions (8): entry(start→hours-check) · business_hours branch(hours-check→queue) · after_hours branch(hours-check→`n-1780888101885`) · **THE fallback edge** queue→`sk-vm-business-hours` (`edgeRole:'fallback'`, `event_key:'queue.timeout queue.not_answered queue.failed'`, label 'Not answered / timeout') · success queue→`sk-done-routed` (`queue.connected call.handoff`, hidden) · `n-1780888101885`→`sk-vm-after-hours` ×2 (success `vapi.completed` + fallback `vapi.no_target vapi.failed vapi.timeout`) · voicemail completion edges ×2 (→ their finals, `voicemail.recorded voicemail.completed`).

## The exact JSON graph delta

**1. ADD state** (append to `states`; `provider`/`config` are DEEP-COPIED from `n-1780888101885` at transform time — expected prod values shown):

```json
{ "id": "n-vapi-bh-backup", "name": "AI Backup", "kind": "vapi_agent", "provider": "vapi", "config": {} }
```

**2. MUTATE the fallback edge** — the ONLY change to an existing object. Matched structurally (NOT by edge id): `from_state_id === 'sk-current-group'` ∧ `to_state_id === 'sk-vm-business-hours'` ∧ `event_key` token-set `== {queue.timeout, queue.not_answered, queue.failed}` (order-insensitive) ∧ exactly ONE such edge. Change:

```
to_state_id: "sk-vm-business-hours"  →  "n-vapi-bh-backup"
```

All other fields (id, label 'Not answered / timeout', edgeLabel, edgeRole 'fallback', system/immutable/insertable/insertMode, transitionMode, event_key) — byte-identical.

**3. ADD transitions** (append to `transitions`):

```json
{ "id": "t-vapi-bh-backup-success", "from_state_id": "n-vapi-bh-backup", "to_state_id": "sk-done-routed",
  "hidden": true, "edgeRole": "success", "transitionMode": "event", "event_key": "vapi.completed" }
```
```json
{ "id": "t-vapi-bh-backup-fallback", "from_state_id": "n-vapi-bh-backup", "to_state_id": "sk-vm-business-hours",
  "label": "AI unavailable / failed", "edgeLabel": "AI unavailable / failed", "edgeRole": "fallback",
  "insertable": true, "insertMode": "between", "transitionMode": "event",
  "event_key": "vapi.no_target vapi.failed vapi.timeout" }
```

Everything else — including the entire after-hours subtree — byte-identical. Field-set note: every field above is on the editor's `reactFlowToGraph` serialization whitelist (`CallFlowBuilderPage.tsx` l.330–377), so the delta survives an editor save round-trip. The hidden success edge follows the `skt-success` convention (hidden edges carrying `edgeRole`/`transitionMode` stay routable — `callFlowRuntime.js` l.123 — and are preserved by the editor via `graphHiddenElements`); at runtime `vapi.completed` is intercepted by `advance` (l.610) before edge routing, so this edge is defensive.

## Behavior scenarios

### S1 — No agents available (all offline OR all busy) → Sara, instantly
- **Preconditions:** business hours (`isBusinessHours=true`), transformed graph live, `availableAgentsForGroup(ug-2385d69d, …0001)` → `[]` (presence≠available or busy-identity filtered, incl. the stale-call re-check, `groupRouting.js` l.211–225).
- **Steps:** inbound webhook → `startExecution` → start → hours-check → queue → `renderQueueNode` sees 0 agents → broadcasts `group.call.queued {status:'no_available_agents'}` → `followFailureEdge` probes `transfer.failed` (no edge) then `queue.timeout` → matches the repointed fallback edge → `renderNodeById('n-vapi-bh-backup')` → `renderVapiNode` resolves SIP (`vapi_tenant_resources` → env `VAPI_SIP_URI`).
- **Expected:** the inbound-webhook TwiML response itself is `<Dial answerOnBridge="true" timeout="60" timeLimit="900" action="…voice-dial-action?vapiNode=1"><Sip>…x-blanc-* params…</Sip></Dial>`. Caller hears ringback then Sara. NO announcement, NO `<Record>`.
- **Side effects:** `call_flow_executions.current_node_id='n-vapi-bh-backup'`; SSE `group.call.queued` as today.

### S2 — Dispatchers ring, nobody answers (Dial timeout) → Sara
- **Preconditions:** agents available → queue rendered `<Dial timeout=…>` (`config.timeout_sec` ∥ env `DIAL_TIMEOUT` ∥ 25 — the feature is agnostic to the value) with `action=voice-dial-action`.
- **Steps:** Twilio POSTs dial-action `DialCallStatus=no-answer` → `handleDialAction` → execution active → `eventFromDialStatus` → `queue.timeout` → `advance` → repointed edge → `renderNodeById('n-vapi-bh-backup')`.
- **Expected:** the dial-action **HTTP response** is the vapi `<Dial><Sip>` TwiML — Twilio continues the live caller leg into Sara seamlessly (no `<Redirect>`, no code change; `twilioWebhooks.js` l.446–457).

### S3 — Dial failure → Sara
- Same as S2 with `DialCallStatus ∈ {busy, failed, canceled}` → `queue.failed`, or any unrecognized status → `queue.not_answered`. Both tokens are on the repointed edge → same vapi TwiML.

### S4 — Sara fails or is unconfigured → business-hours voicemail (LAST resort)
- **Case A (dial-level):** at `n-vapi-bh-backup`, dial-action `?vapiNode=1` maps `no-answer→vapi.timeout`, `busy/failed/canceled/''→vapi.failed` → `advance` → `t-vapi-bh-backup-fallback` → `renderNodeById('sk-vm-business-hours')`.
- **Case B (unresolvable SIP):** `resolveVapiSipUri` → null (no active `vapi_tenant_resources` row AND no env `VAPI_SIP_URI`) → `followFailureEdge(['vapi.no_target','vapi.failed','vapi.timeout',null])` → same fallback edge — the voicemail TwiML is returned in the SAME response that attempted the vapi render.
- **Expected:** voicemail node renders `buildVoicemailTwiml` with the **business-hours** greeting (`sk-vm-business-hours.config.branchKey='business_hours'` → `VM_GREETING`, NOT `VM_AFTER_HOURS_GREETING`); execution status → `'voicemail'`; recording completion advances the untouched completion edge → `sk-done-voicemail-business-hours`, call marked `voicemail_left` (`completeVoicemailCall`).
- **Non-case:** `vapi.completed` (Sara handled the call) → `advance` intercepts → status `'completed'`, `<Hangup>` — never voicemail.

### S5 — After-hours branch unchanged
- `isBusinessHours=false` (or TELEPHONY-AUTONOMOUS-MODE forcing it): hours-check → `n-1780888101885` ('AI Greeting') as today; its failure → `sk-vm-after-hours` (after-hours greeting). The transform asserts the after-hours subtree byte-identical; `n-vapi-bh-backup` is unreachable from this branch.

### S6 — Dispatcher answers → unchanged
- `DialCallStatus completed/answered` → `queue.connected` → `advance` interception (l.596): status `'completed'`, SSE `group.call.accepted`, `<Hangup>` on the parent leg. The success edge queue→`sk-done-routed` untouched.

### S7 — Script idempotency / no-op re-run
- **First run `--apply`:** transform returns `applied` with changes `[add-state, repoint-fallback, add-edge×2]`; one `UPDATE call_flows SET graph_json=$1 WHERE id='cf-bbd3689d' AND company_id='…0001'` inside a `FOR UPDATE` transaction; trigger bumps `updated_at` (row stays the `ensureFlowForGroup` selection); post-write self-check re-reads and asserts the transform now NOOPs. Exit 0.
- **Second run:** applied-shape detected (state `n-vapi-bh-backup` present ∧ fallback edge targets it ∧ both new edges present with expected targets/event-sets) → `noop`, NO write, exit 0, `graph_json` byte-identical.
- **Drift/partial:** any precondition fails (see CLI contract) → REFUSE, exit 2, no write, precise diagnostic.

### S8 — Editor still renders and round-trips the graph
- GET `/api/call-flows/cf-bbd3689d` → `validateGraph` clean (no dangling transitions — all 4 delta endpoints exist; `vapi_agent` ∈ `ENABLED_KINDS`; no per-kind rule fires). Canvas (ELK auto-layout; no coordinates persisted): visible nodes = Hours Check, Dispatch Team, AI Greeting, AI Backup, 2×Voicemail; visible edges = Business Hours, After Hours, 'Not answered / timeout' (queue→AI Backup), 'AI unavailable / failed' (AI Backup→Voicemail), AI Greeting's collapsed 'Next'. `collapseDuplicateVapiEdges` does NOT merge the new pair (different targets). Saving from the editor preserves the delta (whitelist fields only).

## Edge cases

1. **In-flight calls at apply time** keep their snapshot graph (`context_json.graph`) → old voicemail behavior until they end; every NEW call uses the new graph (per-call `ensureFlowForGroup` DB read). No draining needed.
2. **All members `phone_calls_allowed=false`** → candidate list empty → same as S1 (instant Sara).
3. **Duplicate/late Twilio callbacks:** a second `queue.timeout` while already at `n-vapi-bh-backup` matches no edge → `advance` probes (`queue.timeout` again, then eventless) → null → completes execution + `<Hangup>` (pre-existing semantics, no loop). Dial-action arriving after status `'voicemail'` → `advance` returns null → legacy `handleDialAction` branch (unchanged today).
4. **Sara answers then the SIP leg ends** → `DialCallStatus=completed` → `vapi.completed` → hangup (same as today's after-hours semantics).
5. **`vapi_tenant_resources` row inactive but env `VAPI_SIP_URI` set** → env fallback still dials Sara; both absent → S4 case B.
6. **Concurrent editor save during `--apply`** → `SELECT … FOR UPDATE` serializes; the transform runs on the locked row's current value; if that value drifted from the expected shape → REFUSE inside the transaction (rollback, no write).
7. **Admin later edits the flow** (moves/deletes AI Backup) → intentional user control; the script does not re-assert (re-run refuses on drift rather than fighting the editor).
8. **Autonomous mode ON** → every call forced after-hours → feature dormant (S5 path), by design.

## Error handling

- Script: violated precondition → exit 2, message names the precondition and the observed value; DB unreachable → exit 1; `--apply` post-write self-check failure → exit 1 with diff (transaction already committed — surfaced for manual review; practically unreachable since the same pure function produced the write).
- Runtime (unchanged, listed for completeness): missing node id in graph → `renderNodeById` fails execution + 'Call flow configuration error' hangup — unreachable for this delta (all endpoints exist); TwiML webhooks never 500 (`handleDialAction` catch → `<Hangup/>`).

## Component interaction

- Twilio inbound → `POST /webhooks/twilio/voice` → `groupRouting.resolveGroupForNumber` → `ensureFlowForGroup` (fresh DB read) → `callFlowRuntime.startExecution` → … queue → (failure) → vapi TwiML (same response).
- Twilio dial result → `POST /webhooks/twilio/voice-dial-action[?vapiNode=1]` → `handleDialAction` → `callFlowRuntime.advance(event)` → next node TwiML as the response.
- Voicemail record → `POST /webhooks/twilio/voicemail-complete?flowEvent=voicemail.recorded` → `advance` → final (unchanged).
- SSE: existing `group.call.queued` / `group.call.accepted` / `group.call.voicemail` broadcasts unchanged (no new events).
- Frontend: none (editor renders the data as-is).

## Script CLI contract — `scripts/apply-callflow-busy-to-agent-001.js`

- **Invocation:** `node scripts/apply-callflow-busy-to-agent-001.js` (**dry-run by default**: prints the matched row `{id, group_id, status, updated_at}`, the change list, a before/after pretty-printed-JSON unified diff, verdict `WOULD-APPLY|NOOP|REFUSED`; writes nothing) · `--apply` (transactional write as in S7) · env `DATABASE_URL` (defaults to house-local `postgresql://localhost/twilio_calls`; **never defaults to prod** — prod apply = explicit URL + owner consent).
- **Hardcoded targets, no override flags** (multi-tenant safety): `COMPANY_ID='00000000-0000-0000-0000-000000000001'`, `FLOW_ID='cf-bbd3689d'`, `GROUP_ID='ug-2385d69d'`, state ids `sk-current-group`/`sk-vm-business-hours`/`sk-done-routed`/`n-1780888101885`, new ids `n-vapi-bh-backup`/`t-vapi-bh-backup-success`/`t-vapi-bh-backup-fallback`.
- **Exports (pure, unit-testable, no DB):** `module.exports = { applyBusyToAgentTransform }`; CLI body gated by `require.main === module`. `applyBusyToAgentTransform(graph)` → `{status:'applied', graph: newGraph, changes: string[]}` | `{status:'noop', graph}`; throws `ShapeError(reason)` otherwise. Input graph is NOT mutated (returns a structured clone).
- **Preconditions (any failure ⇒ REFUSE / `ShapeError`):**
  - P1 row `FLOW_ID` exists with `company_id=COMPANY_ID` ∧ `group_id=GROUP_ID` ∧ `status='active'`;
  - P2 it is the `ensureFlowForGroup` selection: max `updated_at` among renderable flows for (GROUP_ID, COMPANY_ID);
  - P3 `graph_json` parses; `states`/`transitions` are arrays, `states` non-empty;
  - P4 nodes present with expected kinds: `sk-current-group`=queue, `sk-vm-business-hours`=voicemail, `sk-done-routed`=final, `n-1780888101885`=vapi_agent;
  - P5 exactly ONE fallback edge as defined in the delta §2 matcher;
  - P6 no partial application: `n-vapi-bh-backup` / `t-vapi-bh-backup-*` all absent (→ apply) or all present with expected wiring (→ noop); any mix → REFUSE. (P1–P2 are checked by the CLI against the DB; P3–P6 live inside the pure transform.)

## Security & data isolation

- The script writes exactly one row, keyed by hardcoded `id` + `company_id` — other tenants' flows (their own `call_flows` rows) are untouched and keep today's queue→voicemail behavior; there are no shared/default graphs across tenants (one flow row per group per company).
- No new API endpoints, permissions, or SSE events; runtime tenancy posture unchanged (execution context stays scoped by `company_id` as today).
- The vapi SIP resolution already prefers the tenant's own `vapi_tenant_resources` row (tenant …0001 → `'default'` → env) — unchanged by this feature.

## Constraints / non-goals

- No runtime code change (AC-8 freeze list). No migration. No VAPI assistant PATCH (Sara `30e85a87` untouched — same SIP target as the after-hours node). No frontend change. No change to other tenants or to the after-hours branch. `answerOnBridge="true"` preserved on all Dials (already emitted by the runtime).
- Not in scope: retry-to-humans after Sara, queue-hold music, per-node Sara overrides, editor UI affordances for "AI backup" templates.
