# Test Cases — CALLFLOW-BUSY-TO-AGENT-001

**Spec:** `docs/specs/CALLFLOW-BUSY-TO-AGENT-001.md`. Product code frozen (`callFlowRuntime.js`, `groupRouting.js`, `twilioWebhooks.js`, `callFlows.js` unmodified) — all suites are tests/script only.
**House gotchas:** worktree jest needs `--testPathIgnorePatterns "/node_modules/"` (JOBS-UX-RBAC-001 lesson); mocked jest alone does not prove P0 — G3 runs against a REAL DB copy of the prod graph (LIST-PAGINATION-001 lesson).

## P0 release gates (red on any → blocks the prod data apply)

- **G1 — transform pure-function correctness:** delta EXACTLY as specced, idempotent, refuses unexpected shape (with sabotage control proving the refusal is non-vacuous).
- **G2 — runtime path over the TRANSFORMED graph (mocked jest, `callFlowRuntime.js` untouched):** no-agents → `followFailureEdge` picks the repointed edge → vapi TwiML with `answerOnBridge="true"`; ring-timeout/dial-fail → same; Sara-fail → business-hours VM edge; success/after-hours unchanged.
- **G3 — real-flow verification:** the script against a REAL DB copy of the prod graph — before/after diff, editor-loadable invariants, only the targeted row changed, dry-run writes nothing, re-run NOOPs, sabotage refuses.

## G1 — Unit: `applyBusyToAgentTransform` (`tests/callFlowBusyToAgentTransform.test.js`)

Fixture `PROD_SHAPE` = the 9-state/8-transition prod graph from the spec (incl. system flags and the after-hours vapi node with its two edges). All cases operate on deep clones.

- **T-G1-01 (delta exactness):** `applyBusyToAgentTransform(PROD_SHAPE)` → `status='applied'`; result has 10 states / 10 transitions; the ONLY diffs vs input: (a) appended state `n-vapi-bh-backup` `{name:'AI Backup', kind:'vapi_agent'}` with `config`/`provider` DEEP-EQUAL to (but not the same object reference as) `n-1780888101885`'s; (b) fallback edge `to_state_id` → `'n-vapi-bh-backup'` with EVERY other field byte-identical (compare full edge minus `to_state_id`); (c) appended `t-vapi-bh-backup-success` and `t-vapi-bh-backup-fallback` exactly as specced (field-by-field). Assert via a full JSON diff, not spot checks.
- **T-G1-02 (untouched subtrees):** after-hours subtree (skt-ah edge, `n-1780888101885`, its 2 edges, `sk-vm-after-hours`, its completion edge) and the queue success edge — `JSON.stringify`-identical before/after.
- **T-G1-03 (input not mutated):** input object deep-equal to its pre-call snapshot.
- **T-G1-04 (idempotency):** `applyBusyToAgentTransform(applied.graph)` → `status='noop'` and `graph` deep-equal — a fixed point.
- **T-G1-05 (editor-whitelist fields only):** every field of the new state ∈ {id,name,kind,isInitial,protected,system,immutable,uiTerminal,hidden,labelExpr,groupRef,provider,configRef,config}; every field of the 2 new edges ∈ {id,from_state_id,to_state_id,event_key,label,system,immutable,deletable,hidden,insertable,insertMode,edgeLabel,branchKey,edgeRole,transitionMode,condExpr} (the `reactFlowToGraph` serialization set — guarantees editor round-trip).
- **T-G1-06 (refusals — each mutation of a clone throws `ShapeError` naming the precondition):** (a) queue node id renamed; (b) `sk-vm-business-hours` kind changed; (c) fallback edge `event_key` token removed (`'queue.timeout queue.failed'`) or token added; (d) TWO fallback-matching edges; (e) zero matching edges; (f) `n-1780888101885` absent; (g) `sk-done-routed` absent; (h) `states` empty / `transitions` not an array.
- **T-G1-07 (partial-application refusal):** clone with ONLY the new state added (edge not repointed) → `ShapeError`; clone with edge repointed but new edges missing → `ShapeError` (never "heals" silently).
- **T-G1-08 (token-order insensitivity):** fallback edge `event_key='queue.failed queue.timeout queue.not_answered'` (reordered) → still applies (matcher is a token-SET compare).
- **T-G1-09 (SABOTAGE CONTROL — non-vacuous):** temporarily break the matcher expectation inside the test (feed a graph whose fallback edge points at `sk-vm-after-hours` instead) → MUST throw; if this case ever passes, the guard is vacuous.

## G2 — Unit: runtime path over the transformed graph (`tests/services/callFlowRuntime.busyToAgent.test.js`)

Harness mirrors `tests/services/callFlowRuntime.vapi.test.js`: mock `../../backend/src/db/connection`, `realtimeService`, `groupRouting` (`availableAgentsForGroup`, `isBusinessHours`); executions injected with `context_json.graph = applyBusyToAgentTransform(PROD_SHAPE).graph` — **built by importing the transform from the script, never hand-copied** (prevents spec/fixture drift). SIP resolution: mock the `vapi_tenant_resources` SELECT to return `sip:sara@sip.vapi.ai` (mirrors `callFlowRuntime.test.js` l.312 pattern). Env in tests: `VM_GREETING='BUSINESS_VM_MARKER'`, `VM_AFTER_HOURS_GREETING='AFTERHOURS_VM_MARKER'` (distinct markers).

- **T-G2-01 (S1 no-agents instant):** execution at `sk-current-group`, `availableAgentsForGroup→[]` → `renderNodeById(callSid,'sk-current-group')` TwiML contains `<Sip>`+`sip:sara`+`answerOnBridge="true"`+`vapiNode=1`; does NOT contain `<Record` or either VM marker; `group.call.queued` broadcast carries `status:'no_available_agents'`; execution state saved at `n-vapi-bh-backup`.
- **T-G2-02 (S2 ring-timeout):** execution at queue, `advance(sid,'queue.timeout')` → vapi `<Dial><Sip>` TwiML (assert same markers as T-G2-01).
- **T-G2-03 (S3 dial-fail):** `advance(sid,'queue.failed')` and `advance(sid,'queue.not_answered')` → vapi TwiML. Plus mapping pin: `eventFromDialStatus('no-answer')==='queue.timeout'`, `('busy'|'failed'|'canceled')==='queue.failed'`, unknown → `'queue.not_answered'`.
- **T-G2-04 (S4A Sara dial-fail → BUSINESS VM):** execution at `n-vapi-bh-backup`, `advance(sid,'vapi.failed')` and `…'vapi.timeout'` → TwiML contains `BUSINESS_VM_MARKER` + `<Record`, NOT `AFTERHOURS_VM_MARKER` (greeting chosen by `sk-vm-business-hours.config.branchKey`).
- **T-G2-05 (S4B unresolvable SIP):** resource SELECT → `{rows:[]}`, env `VAPI_SIP_URI` unset → `renderNodeById(sid,'n-vapi-bh-backup')` → business VM TwiML in the SAME response (followFailureEdge probes `vapi.no_target` → `t-vapi-bh-backup-fallback`).
- **T-G2-06 (S4 non-case, completed):** at `n-vapi-bh-backup`, `advance(sid,'vapi.completed')` → `<Hangup`, neither VM marker, an `UPDATE call_flow_executions` carrying `'completed'`.
- **T-G2-07 (S6 success unchanged):** at queue, `advance(sid,'queue.connected')` → `<Hangup` + `group.call.accepted` broadcast; no vapi/VM content.
- **T-G2-08 (S5 after-hours unchanged):** execution at `sk-hours-check` with `context.isBusinessHours=false` → renders through to `n-1780888101885` (assert saved `current_node_id`), NOT `n-vapi-bh-backup`; then at `n-1780888101885`, `advance(sid,'vapi.failed')` → `AFTERHOURS_VM_MARKER`.
- **T-G2-09 (no-loop on duplicate event):** at `n-vapi-bh-backup`, `advance(sid,'queue.timeout')` (a stray/dup queue event) → `<Hangup` + execution completed (matches pre-existing duplicate-event semantics; proves no cycle through the repointed edge).
- **T-G2-10 (CONTROL — untransformed graph still voicemails):** same harness with the UNtransformed `PROD_SHAPE`: no-agents at queue → TwiML contains `BUSINESS_VM_MARKER` (today's behavior) — proves T-G2-01's green comes from the delta, not the harness.

## G3 — Real-DB verification (`scripts/verify-callflow-busy-to-agent-001.js` driving the apply script against a prod-graph copy)

Setup: restore/seed a local DB (house `postgresql://localhost/twilio_calls` or a prod-dump copy) with the REAL prod `call_flows` row (`cf-bbd3689d`, company …0001, group `ug-2385d69d`, actual prod `graph_json`) plus at least one OTHER company's flow row and one other-group row as isolation sentinels.

- **T-G3-01 (dry-run is read-only):** run script with no flags → verdict `WOULD-APPLY`, prints 4-change list + before/after diff; re-SELECT `graph_json` + `updated_at` → byte-identical (nothing written).
- **T-G3-02 (apply):** `--apply` → exit 0; re-SELECT: graph now 10 states/10 transitions; fallback edge targets `n-vapi-bh-backup`; both new edges present; `updated_at` bumped (trigger) and the row is still the max-`updated_at` renderable flow for the group (the `ensureFlowForGroup` selection).
- **T-G3-03 (idempotent re-run):** `--apply` again → exit 0, verdict `NOOP`, `graph_json` byte-identical to post-T-G3-02 (compare exact string).
- **T-G3-04 (tenant/row isolation):** sentinel rows (other company, other group) byte-identical `graph_json`+`updated_at` across all runs; total `call_flows` row count unchanged.
- **T-G3-05 (editor-loadable invariants):** on the applied graph assert: every transition's `from_state_id`/`to_state_id` ∈ state ids (no dangling); every `kind` ∈ ENABLED_KINDS (`start,greeting,queue,branch,transfer,voicemail,hangup,play_audio,vapi_agent,final` — mirror of `routes/callFlows.js` l.140); exactly one `isInitial`; visible-subgraph adjacency = Hours Check→{Dispatch Team, AI Greeting}, Dispatch Team→AI Backup ('Not answered / timeout'), AI Backup→Voicemail-BH ('AI unavailable / failed'). Post-prod-apply, a 1-minute manual owner smoke: open Telephony → Dispatch Team flow in the editor, confirm the picture renders and Save round-trips (GET validation `valid:true`).
- **T-G3-06 (runtime smoke on real data):** with the applied row, call the REAL (unmocked) `groupRouting.ensureFlowForGroup` → returns the customized graph unchanged (proves the seeding guard on real data); then run `callFlowRuntime.startExecution` with a fake callSid + mocked-empty agent set… (agents mock only) → response TwiML contains `<Sip>` (end-to-end over the real DB row).
- **T-G3-07 (SABOTAGE CONTROL):** corrupt the copy (rename fallback-edge token `queue.timeout`→`queue.timeoutX`) → script exits 2, REFUSED naming P5, `graph_json` untouched; restore, corrupt differently (delete `n-1780888101885`) → REFUSED naming P4. Proves the refusal path is live, not vacuous.
- **T-G3-08 (prod apply — owner-consented data change):** with explicit prod `DATABASE_URL`: dry-run first, owner reviews the printed diff, then `--apply`; capture both outputs in the task log. NO deploy, NO restart, NO Keycloak logout (data-only). Rollback = the inverse one-row `UPDATE` restoring the before-JSON printed by the dry-run (kept in the log).

## Coverage summary

| Gate | Suite | Proves |
|---|---|---|
| G1 | `tests/callFlowBusyToAgentTransform.test.js` (~14 cases) | delta exactness, purity, idempotency, refusal+sabotage, editor-field whitelist |
| G2 | `tests/services/callFlowRuntime.busyToAgent.test.js` (~11 cases) | S1–S6 runtime semantics over the transform's actual output, incl. business-vs-after-hours greeting split + untransformed control |
| G3 | `scripts/verify-callflow-busy-to-agent-001.js` (8 steps) | real-row apply/noop/refuse, isolation sentinels, editor invariants, real `ensureFlowForGroup` durability, prod apply record |

Regression to keep green: `tests/services/callFlowRuntime.test.js`, `tests/services/callFlowRuntime.vapi.test.js`, `tests/services/callFlowAutonomousMode.test.js`, `tests/twilioWebhooks.test.js` (product code untouched — any red here means an accidental edit).
