# Test Cases: YELP-LEAD-AUTORESPONDER-002 — Phase 1a refactored onto the durable task+agent model (AUTO-001) with an OPT-IN retry on the shared `agentWorker`

Supersedes the inline greet+send of **YELP-LEAD-AUTORESPONDER-001** (`docs/test-cases/YELP-LEAD-AUTORESPONDER-001.md`). The `-001` DETECT / PARSE / CLAIM cases (`YLA-D-*`, `YLA-P-*`, `YLA-C-01/02`) are **unchanged and still apply** — this doc does **not** restate them; it covers only what the refactor moves or adds. The `-001` HAPPY-PATH/SAFE-FAIL cases that asserted *inline* `sendEmail` from `maybeHandleYelpLead` (`YLA-H-01/02`, `YLA-S-01..04`) are **retired** and re-homed here: the greet+send now lives in the `yelp_lead` **handler**, and the detector only **enqueues**.

## LOCKED DESIGN (source of truth for these cases — from the Architect summary)
The detector enqueues a durable agent task instead of greeting; a new handler greets+closes; the shared worker gains an **additive, opt-in** retry.

1. **Detector** (`yelpLeadService.maybeHandleYelpLead`): env/scope gate → detect → **CLAIM** → parse → `createLead` → **ENQUEUE** `kind='agent', agent_type='yelp_lead', max_attempts=3` task (never greets, never `sendEmail`) → returns `{handled:true, skipped:'yelp_lead'}`.
2. **Handler** (`agentHandlers.HANDLERS.yelp_lead`): reads `agent_input` → `threadAlreadyGreeted?` → `buildGreeting` → `sendEmail(to=reply_to)` → `markGreeted`; **retry-safe** via the `threadAlreadyGreeted` guard (re-run = no-op).
3. **Shared `agentWorker`** gains an **ADDITIVE + OPT-IN** retry: **default `max_attempts=1` ⇒ behaviour is byte-for-byte unchanged** (terminal on the first failure); **only `max_attempts>1` re-queues**. Backoff via `next_attempt_at`.
4. **Migration 163** adds `attempt_count / max_attempts / next_attempt_at` to `tasks`.
5. **"Stuck"** = a **terminally-failed** task left `status='open'` on the lead (`agent_status='failed'`, `lead_id` set) — visible on the lead card, no longer claimable.

### Load-bearing facts from the code read (drive the assertions)
- **`agentWorker.processBatch`** (`backend/src/services/agentWorker.js`) today: claim = `UPDATE tasks SET agent_status='running' … WHERE kind='agent' AND agent_status='queued' AND company_id IS NOT NULL ORDER BY created_at LIMIT $1 FOR UPDATE SKIP LOCKED RETURNING *`; on handler **success** → `agent_status='succeeded', status='done', completed_at=now()` + emit `agent_task.succeeded`; on **throw** → `agent_status='failed'` (leaves `status` alone) + emit `agent_task.failed`. **BATCH=5.** The refactor must (a) add `AND (next_attempt_at IS NULL OR next_attempt_at <= now())` to the claim predicate, and (b) split the catch into **re-queue** (attempts remain) vs **terminal** (exhausted).
- **Terminal predicate (canonical):** after an attempt, the new attempt count is `claimed.attempt_count + 1`; **terminal ⇔ `claimed.attempt_count + 1 >= max_attempts`.** Default `max_attempts=1`, claimed `attempt_count=0` → `1 >= 1` → **terminal on attempt 1** (unchanged). `max_attempts=3` → terminal only on attempt 3.
- **`agent_task.succeeded` is BILLED** (`billingService.js:189` → `agent_runs`) and **`agent_task.failed`** is catalogued (`eventCatalog.js:25`). ⇒ a **re-queue MUST NOT emit either** `agent_task.succeeded` **or** `agent_task.failed` (else billing / rules double-count); a terminal failure emits `agent_task.failed` **exactly once** across the whole retried lifecycle.
- **Agent-queue partial index** (mig 100): `idx_tasks_agent_queue ON tasks(company_id, agent_status) WHERE kind='agent' AND status='open'`. A **terminal-failed** task keeps `status='open'` (so it stays indexed / visible) but `agent_status='failed'` (so the `agent_status='queued'` claim never re-runs it) — that is *exactly* the "stuck task on the lead" signal.
- **Enqueue INSERT shape** (mirrors `routeSegmentService.enqueueAgentTask`): `INSERT INTO tasks (company_id, kind, agent_type, agent_status, agent_input, status, title, created_by, lead_id, max_attempts) VALUES ($1,'agent',$2,'queued',$3::jsonb,'open',$4,'system',$5,3)`. `tasks.lead_id BIGINT REFERENCES leads(id)` exists (mig 136); `tasks.max_attempts` is added by **mig 163**.
- **`agent_status` CHECK** (mig 100) allows `queued|running|succeeded|failed` — a re-queue writes `agent_status='queued'`, which is already permitted (no constraint change needed).
- **`agentHandlers.run(task)`** dispatches on `task.agent_type`; unknown type → `throw new Error('Unknown agent_type: …')`. The `yelp_lead` handler is a new `HANDLERS` entry; a throw from it is what triggers the worker's retry.
- **`emit`** signature: `eventBus.emit(company_id, eventType, payload, {actorType,aggregateType,aggregateId})` — assert on the **2nd arg** (`eventType`).
- **`leadsService.createLead(fields, companyId)`** returns `{UUID, SerialId, ClientId, link}`; `ClientId` → the numeric lead id used as `tasks.lead_id`.
- **`emailService.sendEmail(companyId, {to, subject, body})`** → `{provider_message_id}` (used by `markGreeted`).

### Harness & mocking conventions (unchanged from `-001`; verified in-repo)
- Jest files live in **top-level `tests/*.test.js`**; mock backend modules by relative path `jest.mock('../backend/src/…')`; every factory-closure variable is **`mock*`-prefixed** (worktree hoist rule). DB seam mocked as `jest.mock('../backend/src/db/connection', () => ({ query: mockQuery }))`.
- **Run one file** (the explicit ignore overrides `package.json`'s `"/\.claude/worktrees/"` skip):
  `node /Users/rgareev91/contact_center/twilio-front-integration/node_modules/jest/bin/jest.js tests/<file> --rootDir . --testPathIgnorePatterns "/node_modules/" --forceExit`
- **Real-Postgres** cases follow `tests/yelpLeadClaim.db.test.js`: a `beforeAll` probe (`SELECT 1 FROM …`) sets `dbReady`; every case **self-skips** with a `SKIPPED-NEEDS-DB` warning when no DB (or migration not applied) is reachable — the run never fails. Point `DATABASE_URL` at a DB with **migrations 100 + 136 + 162 + 163** applied to actually exercise them.
- **New test files needed** (none exist yet): `tests/agentWorkerRetry.test.js` (mocked), `tests/agentWorkerRetry.db.test.js` (real DB), `tests/yelpLeadEnqueue.test.js` (mocked), `tests/yelpLeadHandler.test.js` (mocked), `tests/yelpLeadEnqueue.db.test.js` (real DB, idempotency), plus additions to the existing `tests/yelpLeadHook.test.js`.

### Fixtures
- Reuse `tests/yelpFixtures.js` (`yNew/yReply/yConfirm/nonYelp`, `DEFAULT_COMPANY_ID`).
- **`taskRow(overrides)`** helper (new): a claimed agent-task row —
  `{ id: 1, company_id: DEFAULT_COMPANY_ID, kind:'agent', agent_type:'…', agent_status:'running', status:'open', attempt_count:0, max_attempts:1, next_attempt_at:null, agent_input:{}, lead_id:55, created_at:'…' }`.
- **`yelpInput`** = the `agent_input` a real enqueue writes: `{ claim_id: 7, lead_id: 55, reply_to:'reply+8160b36a1c2d3e4f@messaging.yelp.com', thread_token:'8160b36a1c2d3e4f', name:'Kim', service:'dishwasher repair', problem:'Maytag dishwasher stuck in mid cycle', zip:'02467' }`.

## Coverage
- **Total test cases: 27**
- **P0: 9 · P1: 10 · P2: 7 · P3: 1**
- **Jest, fully mocked (no DB/network): 16** · **Jest + real Postgres (self-skip): 5** · **Real-DB / manual psql (migration up/down): 2** · **Static/build check: 2** · **Live deploy, manual prod: 2**
- **The six P0 requirements, each with a real assertion + a named sabotage:**

| # | P0 requirement | Case (assertion) | Named check | Sabotage (turns it RED) |
|---|---|---|---|---|
| 1 | Shared-worker regression: default (`max_attempts=1`) fails **terminally on attempt 1** | `A-01` (mock) + `A-01b` (real DB) | `WORKER-default-terminal-once` | **`SAB-WORKER-REQUEUE-DEFAULT`** — weaken the terminal guard (`>=`→`>`, or drop the `max_attempts` check) so a default-1 task re-queues |
| 2 | Retry state machine: `max_attempts=3` → requeue,requeue,**terminal**; emit `agent_task.failed` **once** | `A-02` (real DB) + `A-02b` (mock) | `RETRY-emit-once` / `RETRY-terminal-only-at-max` | **`SAB-RETRY-EMIT-EACH-ATTEMPT`** — emit `agent_task.failed` (or `.succeeded`) on every attempt, not only terminal |
| 3 | Backoff claim predicate: future `next_attempt_at` not claimed; `<=now()`/NULL claimed | `A-03` (mock, SQL shape) + `A-03b` (real DB) | `CLAIM-respects-backoff` | **`SAB-CLAIM-IGNORE-BACKOFF`** — drop `AND (next_attempt_at IS NULL OR next_attempt_at <= now())` from the claim |
| 4 | Detector **enqueues, does NOT greet** | `B-01` (mock) | `DETECTOR-no-send-in-ingest` | **`SAB-DETECTOR-STILL-GREETS`** — keep the old inline `sendEmail` in `maybeHandleYelpLead` |
| 5 | Handler **greets + closes** | `C-01` (mock) | `HANDLER-sends-once` | **`SAB-HANDLER-SKIP-SEND`** — handler returns without calling `sendEmail` |
| 6 | Handler **retry-safe (no double-send)** | `C-02` (mock) | `HANDLER-no-double-send` | **`SAB-DROP-GREETED-GUARD`** — remove the `threadAlreadyGreeted` guard in the handler |

---

## A. SHARED `agentWorker` RETRY STATE MACHINE — `tests/agentWorkerRetry.test.js` (mocked) + `tests/agentWorkerRetry.db.test.js` (real DB)

Target: `agentWorker.processBatch`. **Mocked harness:** `jest.mock('../backend/src/db/connection', () => ({ query: mockQuery }))`, `jest.mock('../backend/src/services/agentHandlers', () => ({ run: mockRun }))`, `jest.mock('../backend/src/services/eventBus', () => ({ emit: mockEmit }))`. Drive one batch by making `mockQuery` return the claimed row(s) for the claim `UPDATE … RETURNING` and `{rows:[]}` for the follow-up writes; classify each follow-up write by its SQL/params.

### A-01 · WORKER-default-terminal-once: default task (`max_attempts=1`) that throws → TERMINAL on attempt 1 — **P0** (req #1)
- **Priority:** P0 · **Type:** Unit (jest, mocked) · **Scenario:** shared-worker regression (the load-bearing guard)
- **Setup:** claim returns `[ taskRow({ id:1, agent_type:'job_geocode', attempt_count:0, max_attempts:1 }) ]`; `mockRun.mockRejectedValue(new Error('boom'))`.
- **Steps:** `await agentWorker.processBatch()`.
- **Expected (all must hold):**
  1. Exactly **one** follow-up write after the claim, and it sets **`agent_status='failed'`** (assert the params/SQL) — **not** `'queued'`.
  2. `next_attempt_at` stays **NULL** (the terminal write does not set a future time; assert no `now() + interval` and no future Date param).
  3. `status` is **not** flipped to `'done'` (stays `'open'`).
  4. `mockEmit` called **exactly once**, 2nd arg `=== 'agent_task.failed'`; **never** with `'agent_task.succeeded'`.
  5. The task is **not re-queued** — no second claim, no `agent_status='queued'` write.
- **Proves:** `job_geocode` / `route_calc` / `zb_job_sync` (all default `max_attempts=1`) fail terminally on the first attempt exactly as before the retry existed. **Named check `WORKER-default-terminal-once`.**
- **Sabotage `SAB-WORKER-REQUEUE-DEFAULT`:** change the terminal test to `attempt_count+1 > max_attempts` (or drop the `max_attempts` comparison entirely so the catch always re-queues). Re-run → this case turns **RED** (task written `agent_status='queued'` + `next_attempt_at` set, `agent_task.failed` not emitted). If it stays green, the regression guard isn't pinning the default path — fix the test.
- **File:** `tests/agentWorkerRetry.test.js`

### A-01b · same, on REAL Postgres — default task ends `failed`, one emit, not re-claimed — **P0** (req #1)
- **Priority:** P0 · **Type:** Integration (jest + **real Postgres**, self-skip) · **Scenario:** regression, authoritative
- **Setup:** register a throwing test handler (or reuse a mocked `agentHandlers.run` that throws) `agent_type='__throw__'`; INSERT a real queued task `kind='agent', agent_status='queued', status='open', max_attempts=1, attempt_count=0, company_id=DEFAULT_COMPANY_ID`.
- **Steps:** `await processBatch()` **twice**.
- **Expected:** after the 1st batch the row is `agent_status='failed', attempt_count=1, next_attempt_at IS NULL, status='open'`; the **2nd** batch claims **0** rows (a failed task is never re-run). `SELECT count(*)` of `agent_task.failed` domain events for the task = **1**.
- **File:** `tests/agentWorkerRetry.db.test.js`

### A-02 · RETRY state machine (`max_attempts=3`) → requeue → requeue → terminal — **P0** (req #2) — authoritative
- **Priority:** P0 · **Type:** Integration (jest + **real Postgres**, self-skip) · **Scenario:** the retry FSM end-to-end
- **Setup:** throwing handler `agent_type='__throw__'`; INSERT a real task `max_attempts=3, attempt_count=0, agent_status='queued', status='open', next_attempt_at=NULL`. Set `AGENT_WORKER` backoff to ~0s for the test (e.g. `AGENT_RETRY_BASE_MS=0`) so `next_attempt_at <= now()` immediately, OR manually `UPDATE … SET next_attempt_at = now() - interval '1s'` between batches.
- **Steps:** run `processBatch()`; (advance backoff); repeat until terminal.
- **Expected (per attempt, asserted on the persisted row + emitted events):**
  - **Attempt 1** (claimed `attempt_count=0`): after → `agent_status='queued'`, `attempt_count=1`, `next_attempt_at` **in the future**, `status='open'`; **no** `agent_task.failed` and **no** `agent_task.succeeded` event.
  - **Attempt 2** (claimed `attempt_count=1`): after → `agent_status='queued'`, `attempt_count=2`, `next_attempt_at` future; still **no** failed/succeeded emit.
  - **Attempt 3** (claimed `attempt_count=2`): after → **`agent_status='failed'`**, `attempt_count=3`, **`next_attempt_at IS NULL`**, `status='open'` (the **stuck** task); **`agent_task.failed` emitted — total count over the whole lifecycle = exactly 1.**
- **Named check `RETRY-emit-once`** (failed-event count across the lifecycle = 1) **and `RETRY-terminal-only-at-max`** (agent_status becomes `failed` only after attempt 3).
- **File:** `tests/agentWorkerRetry.db.test.js`

### A-02b · RETRY branch arithmetic (mocked, 3 synthetic batches) — **P0** (req #2)
- **Priority:** P0 · **Type:** Unit (jest, mocked) · **Scenario:** retry FSM branch logic (fast, deterministic)
- **Setup:** three `processBatch()` calls; before each, `mockQuery` claim returns `[ taskRow({ max_attempts:3, attempt_count:N }) ]` for `N=0,1,2`; `mockRun` always rejects.
- **Expected:**
  - Calls with claimed `attempt_count ∈ {0,1}` → the follow-up write sets `agent_status='queued'`, writes `attempt_count = N+1`, and sets `next_attempt_at` to a **future** time (assert either a Date param `> Date.now()` or SQL computing `now() + <backoff> interval`); `mockEmit` **not** called with `'agent_task.failed'` **nor** `'agent_task.succeeded'` on these two calls.
  - Call with claimed `attempt_count=2` → write sets `agent_status='failed'`, `next_attempt_at` NULL; `mockEmit` called once here with `'agent_task.failed'`.
  - **Across all three calls, `mockEmit` fires `'agent_task.failed'` exactly once and `'agent_task.succeeded'` zero times.**
- **Sabotage `SAB-RETRY-EMIT-EACH-ATTEMPT`:** emit `agent_task.failed` in the re-queue branch too (i.e. emit on every catch). Re-run → the "exactly once" assertion turns **RED** (3 emits). Guards against a retry that spams billing/rules on every attempt.
- **File:** `tests/agentWorkerRetry.test.js`

### A-03 · CLAIM-respects-backoff: claim SQL carries the `next_attempt_at` predicate — **P0** (req #3)
- **Priority:** P0 · **Type:** Unit (jest, mocked) · **Scenario:** backoff claim predicate (SQL shape)
- **Setup:** `mockQuery.mockResolvedValue({ rows: [] })` (empty batch); `await processBatch()`.
- **Expected:** the claim SQL string passed to `db.query` **matches** `/agent_status\s*=\s*'queued'/i` **AND** `/next_attempt_at\s+IS\s+NULL\s+OR\s+next_attempt_at\s*<=\s*now\(\)/i` **AND** still carries `/for update skip locked/i` and `/company_id is not null/i` (the pre-existing guards are preserved).
- **Sabotage `SAB-CLAIM-IGNORE-BACKOFF`:** delete the `AND (next_attempt_at IS NULL OR next_attempt_at <= now())` clause. Re-run → the predicate regex assertion turns **RED**. (The behavioural proof is `A-03b`.) **Named check `CLAIM-respects-backoff`.**
- **File:** `tests/agentWorkerRetry.test.js`

### A-03b · backoff claim predicate on REAL Postgres: future not claimed; past/NULL claimed — **P0** (req #3) — authoritative
- **Priority:** P0 · **Type:** Integration (jest + **real Postgres**, self-skip) · **Scenario:** backoff, behavioural
- **Setup:** a `noop` handler (succeeds). INSERT task **X** `agent_status='queued', status='open', next_attempt_at = now() + interval '1 hour'`; INSERT task **Y** `… next_attempt_at = now() - interval '1 minute'`; INSERT task **Z** `… next_attempt_at = NULL`.
- **Steps:** `await processBatch()` once.
- **Expected:** **Y** and **Z** are claimed and run to `succeeded`/`done`; **X** stays `agent_status='queued'` (its `next_attempt_at` is in the future → not yet eligible). A second batch *after* `UPDATE X SET next_attempt_at = now() - interval '1s'` then claims **X**.
- **File:** `tests/agentWorkerRetry.db.test.js`

### A-04 · success path unchanged (`yelp_lead` handler resolves) → succeeded/done + emit succeeded once — **P1**
- **Priority:** P1 · **Type:** Unit (jest, mocked) · **Scenario:** additivity — the happy branch is byte-for-byte the same
- **Setup:** claim returns `[ taskRow({ agent_type:'yelp_lead', max_attempts:3, attempt_count:0 }) ]`; `mockRun.mockResolvedValue({ greeted:true, lead_id:55 })`.
- **Expected:** follow-up write sets `agent_status='succeeded', status='done', completed_at` set, `agent_output` = the handler output; `mockEmit` called once with `'agent_task.succeeded'`; **no** `next_attempt_at`, **no** `agent_task.failed`. Confirms the retry code path is *only* on the failure branch and the (billed) success emit still fires exactly once regardless of `max_attempts`.
- **File:** `tests/agentWorkerRetry.test.js`

### A-05 · tenant isolation: the claim keeps `company_id IS NOT NULL` and emits scoped to `task.company_id` — **P2**
- **Priority:** P2 · **Type:** Unit (jest, mocked) · **Scenario:** data isolation (mig-100 invariant preserved)
- **Setup:** claim returns two rows for **different** `company_id`s, both handlers succeed.
- **Expected:** the claim SQL still contains `company_id IS NOT NULL`; each `emit` is called with its **own** `task.company_id` as the 1st arg (company A's task never emits under company B). Locks the "retry didn't loosen tenant scoping" property.
- **File:** `tests/agentWorkerRetry.test.js`

### A-06 · backoff grows with attempt_count (monotonic `next_attempt_at`) — **P3**
- **Priority:** P3 · **Type:** Integration (jest + **real Postgres**, self-skip) · **Scenario:** backoff shape
- **Expected:** across attempts, the computed `next_attempt_at - now()` for attempt 2 is `>=` that of attempt 1 (exponential/linear per the Implementer's `AGENT_RETRY_BASE_MS`); no attempt schedules in the past. Non-blocking nicety — flags a constant/zero backoff (thundering re-runs).
- **File:** `tests/agentWorkerRetry.db.test.js`

---

## B. DETECTOR ENQUEUES (does not greet) — `tests/yelpLeadEnqueue.test.js` (mocked)

Target: `yelpLeadService.maybeHandleYelpLead`. **Harness:** mock `db/connection` (claim + enqueue INSERT via `mockQuery`), `leadsService.createLead`, `yelpLeadQueries` (`claimYelpLead/releaseClaim`), and **spy** `emailService.sendEmail` + `yelpGreetingService.buildGreeting` to prove they are **never** touched in the ingest path.

### B-01 · DETECTOR-no-send-in-ingest: detect → createLead once + ONE agent-task INSERT; NO sendEmail — **P0** (req #4)
- **Priority:** P0 · **Type:** Unit (jest, mocked) · **Scenario:** detector enqueues, does not greet
- **Setup:** gate ON (`YELP_AUTORESPONDER_ENABLED='true'`, company `=DEFAULT_COMPANY_ID`); `claimYelpLead` → `{claimed:true, id:7}`; `createLead` → `{ClientId:'55'}`; `mockQuery` records every SQL (to catch the enqueue INSERT).
- **Steps:** `const r = await maybeHandleYelpLead(DEFAULT_COMPANY_ID, yNew())`.
- **Expected (all):**
  1. `createLead` called **once** (`JobSource:'Yelp', Status:'Submitted', FirstName:'Kim'`), 2nd arg `=== DEFAULT_COMPANY_ID`.
  2. **Exactly one** `INSERT INTO tasks …` (assert `mockQuery` calls filtered by `/insert into tasks/i` has length 1) and that INSERT carries `kind='agent'`, `agent_type='yelp_lead'`, `agent_status='queued'`, `status='open'`, `max_attempts` param `=== 3`, `lead_id` param `=== 55`, and an `agent_input` JSON containing `claim_id:7`, `reply_to:'reply+8160b36a1c2d3e4f@messaging.yelp.com'`, `thread_token:'8160b36a1c2d3e4f'`, `service:'dishwasher repair'`, `problem` (contains `'Maytag'`), `zip:'02467'`.
  3. `emailService.sendEmail` **`.not.toHaveBeenCalled()`** and `yelpGreetingService.buildGreeting` **`.not.toHaveBeenCalled()`** — the ingest thread does zero LLM/SMTP work.
  4. `r` `toMatchObject({ handled:true, skipped:'yelp_lead' })`.
- **Sabotage `SAB-DETECTOR-STILL-GREETS`:** restore the old inline greet+send inside `maybeHandleYelpLead` (call `buildGreeting`+`sendEmail` directly). Re-run → assertion (3) turns **RED**. Pins that the send moved out of the ingest path. **Named check `DETECTOR-no-send-in-ingest`.**
- **File:** `tests/yelpLeadEnqueue.test.js`

### B-02 · lead-at-least-once: `createLead` throws → `releaseClaim` called → NO task enqueued — **P1** (req #9a)
- **Priority:** P1 · **Type:** Unit (jest, mocked) · **Scenario:** lead write failure ⇒ safe re-poll
- **Setup:** `claimYelpLead` → `{claimed:true, id:7}`; `createLead.mockRejectedValue(new Error('DB down'))`; spy `releaseClaim`; `mockQuery` records INSERTs.
- **Expected:** `maybeHandleYelpLead` **does not throw**; `releaseClaim(7)` called **once**; **no** `INSERT INTO tasks` (`mockQuery` calls matching `/insert into tasks/i` = 0); returns a handled/no-op signal (`{handled:true, skipped:'yelp_lead', reason:'lead_create_failed'}`). The released claim means the next poll re-attempts the lead (lead at-least-once).
- **File:** `tests/yelpLeadEnqueue.test.js`

### B-03 · enqueue-INSERT throws AFTER the lead exists → `releaseClaim` NOT called (no dup lead) → logged — **P1** (req #9b)
- **Priority:** P1 · **Type:** Unit (jest, mocked) · **Scenario:** enqueue failure after a committed lead
- **Setup:** `claimYelpLead` → won; `createLead` → `{ClientId:'55'}` (lead now exists); make the enqueue `mockQuery` (the `INSERT INTO tasks`) **reject**; spy `releaseClaim` and `console.error`.
- **Expected:** `maybeHandleYelpLead` **does not throw**; `releaseClaim` **`.not.toHaveBeenCalled()`** (releasing the claim would let a re-poll create a **second** lead — the invariant is *no duplicate lead*); the failure is `console.error`-logged; returns a handled signal. The task is simply absent this cycle (accepted best-effort; the lead is still visible in Pulse). **Gap #1** notes the recovery choice.
- **File:** `tests/yelpLeadEnqueue.test.js`

### B-04 · env gate OFF / non-default company → total no-op (no detect / claim / enqueue) — **P1** (req #11)
- **Priority:** P1 · **Type:** Unit (jest, mocked) · **Scenario:** gate + tenant scope
- **Setup A:** `YELP_AUTORESPONDER_ENABLED` unset/`'false'`, company `=DEFAULT_COMPANY_ID`. **Setup B:** gate ON but company `='22222222-…-222'` (outside the 1a default scope).
- **Expected (both):** returns `{handled:false}` **without** calling `claimYelpLead`, `createLead`, any `INSERT INTO tasks`, `buildGreeting`, or `sendEmail` (all spies `.not.toHaveBeenCalled()`) → `linkInboundMessage` continues the normal pipeline unchanged. Confirms gate-off does **not** swallow the email and scope is enforced.
- **File:** `tests/yelpLeadEnqueue.test.js`

---

## C. `yelp_lead` HANDLER (greets + closes, retry-safe) — `tests/yelpLeadHandler.test.js` (mocked)

Target: `agentHandlers.HANDLERS.yelp_lead` (via `agentHandlers.run(task)`). **Harness:** mock `yelpLeadQueries` (`threadAlreadyGreeted`, `markGreeted`), `yelpGreetingService.buildGreeting`, `emailService.sendEmail`, `db/connection`. `task = taskRow({ agent_type:'yelp_lead', agent_input: yelpInput, company_id: DEFAULT_COMPANY_ID })`.

### C-01 · HANDLER-sends-once: reply_to present, not-yet-greeted → buildGreeting → ONE sendEmail(to=reply_to) → markGreeted — **P0** (req #5)
- **Priority:** P0 · **Type:** Unit (jest, mocked) · **Scenario:** handler happy path
- **Setup:** `threadAlreadyGreeted` → `false`; `buildGreeting` → `'Hi Kim, …'`; `sendEmail` → `{provider_message_id:'<sent-x>'}`.
- **Steps:** `const out = await agentHandlers.run(task)`.
- **Expected:**
  1. `buildGreeting` called once with the **parsed** context `expect.objectContaining({ name:'Kim', service:'dishwasher repair', problem: expect.stringContaining('Maytag') })`.
  2. `sendEmail` called **exactly once**: 1st arg `=== DEFAULT_COMPANY_ID`; `to === 'reply+8160b36a1c2d3e4f@messaging.yelp.com'` (the `agent_input.reply_to`); `body === 'Hi Kim, …'`; `subject` non-empty.
  3. `markGreeted` called once with `claim_id (7)` and `{ status:'greeted', greetingProviderMessageId:'<sent-x>', leadId:55, threadToken:'8160b36a1c2d3e4f' }`.
  4. returns a truthy output (e.g. `{ greeted:true, lead_id:55 }`) → worker will stamp `succeeded`.
- **Sabotage `SAB-HANDLER-SKIP-SEND`:** make the handler `return` before `sendEmail`. Re-run → assertion (2) turns **RED**. **Named check `HANDLER-sends-once`.**
- **File:** `tests/yelpLeadHandler.test.js`

### C-02 · HANDLER-no-double-send: re-run after markGreeted → threadAlreadyGreeted(true) → NO 2nd sendEmail — **P0** (req #6)
- **Priority:** P0 · **Type:** Unit (jest, mocked) · **Scenario:** retry-safety (idempotent handler)
- **Setup:** `threadAlreadyGreeted` → `true` (models a retry after a prior attempt already greeted — e.g. `sendEmail` succeeded but the task-status write failed and the worker re-queued).
- **Steps:** `const out = await agentHandlers.run(task)`.
- **Expected:** `sendEmail` **`.not.toHaveBeenCalled()`**; `buildGreeting` **`.not.toHaveBeenCalled()`**; the handler returns a **success no-op** (e.g. `{ greeted:false, skipped:'already_greeted' }`) — it **does not throw** (a throw would re-queue and loop). This is what makes the shared retry safe for `yelp_lead`.
- **Sabotage `SAB-DROP-GREETED-GUARD`:** remove the `threadAlreadyGreeted` check so the handler always sends. Re-run → the `sendEmail .not.toHaveBeenCalled()` assertion turns **RED** (a retry double-sends to the customer). **Named check `HANDLER-no-double-send`.**
- **File:** `tests/yelpLeadHandler.test.js`

### C-03 · no reply_to → markGreeted('handled_no_send'), NO sendEmail, NOT an error — **P1** (req #7)
- **Priority:** P1 · **Type:** Unit (jest, mocked) · **Scenario:** unsendable input (mangled relay from parse)
- **Setup:** `task.agent_input.reply_to = null` (and `thread_token = null`); spies on `sendEmail`, `buildGreeting`, `markGreeted`.
- **Expected:** `sendEmail` **`.not.toHaveBeenCalled()`**; `markGreeted` called once with `status:'handled_no_send'`; the handler **resolves** (returns e.g. `{ greeted:false, skipped:'no_reply_to' }`) and **does not throw** → the worker marks the task `succeeded/done` (a permanent no-send is *not* a retryable failure — it must not loop into a stuck task).
- **File:** `tests/yelpLeadHandler.test.js`

### C-04 · transient send failure → handler THROWS so the worker retries — **P1**
- **Priority:** P1 · **Type:** Unit (jest, mocked) · **Scenario:** the retry trigger
- **Setup:** `threadAlreadyGreeted` → `false`; `buildGreeting` → text; `sendEmail.mockRejectedValue(new Error('SMTP 503'))`.
- **Expected:** `agentHandlers.run(task)` **rejects** (propagates the error) so `agentWorker`'s catch re-queues (because `max_attempts=3`); `markGreeted` is **not** called with a `greeted` status for this failed attempt (nothing to record) — i.e. the thread is *not* marked greeted, so the next attempt will actually retry the send rather than short-circuit on the guard. Ties the handler's throw to `A-02`'s re-queue.
- **File:** `tests/yelpLeadHandler.test.js`

### C-05 · registry: `yelp_lead` is registered; unknown type still throws — **P2**
- **Priority:** P2 · **Type:** Unit (jest, mocked) · **Scenario:** wiring / regression
- **Expected:** `typeof agentHandlers.HANDLERS.yelp_lead === 'function'`; `agentHandlers.run({ agent_type:'nope' })` rejects with `/Unknown agent_type/`. Guards against a handler that was written but never wired into the `HANDLERS` map (would make every enqueued Yelp task fail with "Unknown agent_type" and, at `max_attempts=3`, produce a stuck task — a silent outage).
- **File:** `tests/yelpLeadHandler.test.js`

---

## D. IDEMPOTENT CLAIM ⇒ single lead + single task — `tests/yelpLeadEnqueue.db.test.js` (real DB)

### D-01 · re-ingest same `provider_message_id` → claim no-op → NO 2nd lead, NO 2nd task — **P1** (req #8)
- **Priority:** P1 · **Type:** Integration (jest + **real Postgres**, self-skip) · **Scenario:** end-to-end idempotency across the *new* enqueue path
- **Setup:** real `db`/`yelp_lead_events` (mig 162) + real `tasks` (mig 100/136/163); mock `leadsService.createLead` (spy, returns a fresh `ClientId`) so no real lead schema needed; gate ON.
- **Steps:** `await maybeHandleYelpLead(DEFAULT_COMPANY_ID, yNew({provider_message_id:'ymsg-DUP-<ts>'}))` **twice** (push then poll re-scan of the same message).
- **Expected:** `createLead` called **once**; `SELECT count(*) FROM tasks WHERE company_id=$1 AND agent_type='yelp_lead' AND agent_input->>'claim_id' = '<claimId>'` (or filter by the pmid carried in `agent_input`) = **1**; the 2nd call short-circuits at the lost claim (`{skipped:'yelp_lead', reason:'already_claimed'}`) → no 2nd `INSERT INTO tasks`. **Extends `-001`'s `YLA-C-03` to prove the claim now dedups the *task*, not just the greeting.**
- **Sabotage:** same as `-001` `YLA-N-02` (replace `ON CONFLICT DO NOTHING RETURNING` with an unconditional proceed) → this case turns **RED** (2 tasks, 2 leads).
- **File:** `tests/yelpLeadEnqueue.db.test.js`

---

## E. DECOUPLING / ADDITIVITY (Mail Secretary untouched) — extend `tests/yelpLeadHook.test.js` (mocked)

The existing `YLA-M-01/M-02` still hold (detector returns `{skipped:'yelp_lead'}` → no `reviewInboundEmail`/task/unread/SSE). Add:

### E-01 · non-Yelp inbound still flows to the Mail Secretary (control) — **P1** (req #10a)
- **Priority:** P1 · **Type:** Integration (jest, mocked over `linkInboundMessage`) · **Scenario:** additivity control (unchanged from `-001` `YLA-M-01`, re-asserted post-refactor)
- **Expected:** `nonYelp()` no-contact inbound → `mailAgentService.reviewInboundEmail(companyId, msg, {noContact:true})` called once; returns `{skipped:'no_contact'}`. The task-model refactor changed nothing on the non-Yelp branch.
- **File:** `tests/yelpLeadHook.test.js`

### E-02 · a Yelp lead returns `{skipped:'yelp_lead'}` ⇒ no `mail_agent_review` / AR task — **P1** (req #10b)
- **Priority:** P1 · **Type:** Integration (jest, mocked) · **Scenario:** intercept-before-mail-agent (unchanged from `-001` `YLA-M-02`)
- **Expected:** `reviewInboundEmail`, `timelinesQueries.createTask`, `queries.markContactUnread`, `realtimeService.publishMessageAdded` each **`.not.toHaveBeenCalled()`**; `emailQueries.findEmailContact` never reached. The **only** new observable is the enqueued agent task — asserted in `B-01`, not here. Sabotage `-001` `YLA-N-03` (move the hook below the mail-agent branch) still turns this RED.
- **File:** `tests/yelpLeadHook.test.js`

### E-03 · detector requires NO `mailAgentService` (module decoupling) — **P1** (req #10c)
- **Priority:** P1 · **Type:** Static/structural check · **Scenario:** dependency direction
- **Steps:** assert `yelpLeadService.js` and the `yelp_lead` handler do **not** `require('./mailAgentService')` (grep/`require`-graph). Optionally: load `yelpLeadService` with `mailAgentService` mocked to `undefined` and confirm `B-01` still passes.
- **Expected:** no static or runtime dependency from the Yelp path onto the Mail Secretary — the two are independent consumers of the ingest seam, and removing the Mail Secretary would not break Yelp (and vice-versa). Prevents an accidental coupling regression.
- **File:** `tests/yelpLeadHook.test.js` (or a `grep`-based structural assertion)

---

## F. MIGRATION 163 — `tasks.attempt_count / max_attempts / next_attempt_at`

### F-01 · up adds the three columns with correct defaults — **P2** (req #12a)
- **Priority:** P2 · **Type:** Real-DB / manual psql (or CI DB) · **Scenario:** schema
- **Steps:** apply `163_*.sql`; `\d tasks`.
- **Expected:** `attempt_count integer NOT NULL DEFAULT 0`; `max_attempts integer NOT NULL DEFAULT 1`; `next_attempt_at timestamptz` (nullable, **no** default → NULL). **Crucially `max_attempts` DEFAULT is `1`** (opt-in): every pre-existing/rules-created agent task inherits `max_attempts=1` and therefore keeps terminal-on-first-failure. Idempotent (`ADD COLUMN IF NOT EXISTS`), touches no existing rows. A partial claim index on `next_attempt_at` (if added) is optional.
- **File:** `backend/db/migrations/163_agent_task_retry.sql` (name illustrative; number verified below)

### F-02 · rollback drops the three columns — **P2** (req #12b)
- **Priority:** P2 · **Type:** Real-DB / manual psql · **Scenario:** rollback
- **Expected:** `rollback_163_*.sql` runs `ALTER TABLE tasks DROP COLUMN IF EXISTS attempt_count, DROP COLUMN IF EXISTS max_attempts, DROP COLUMN IF EXISTS next_attempt_at;` cleanly; re-applying `up` succeeds (idempotent guards). No orphaned index/constraint left behind.
- **File:** `backend/db/migrations/rollback_163_agent_task_retry.sql`

### F-03 · migration number is the next FREE integer at build — **P2** (req #12c)
- **Priority:** P2 · **Type:** Static/build check · **Scenario:** parallel-session hygiene
- **Steps:** `ls backend/db/migrations` **and** every sibling `.claude/worktrees/*/backend/db/migrations`; take `max(prefix)+1`.
- **Expected:** **Authoring-time survey:** on disk `160`, `162` (yelp_lead_events); `161` is claimed by a sibling worktree (`161_seed_ai_repair_advisor_marketplace_app.sql`) → **max = 162 → next-free = 163** (matches the LOCKED design). **FLAG:** re-verify immediately before creating the file — parallel sessions add migrations (cf. "parallel dialogs share tree"); if `163` is taken, renumber and update `F-01/F-02` filenames.
- **File:** n/a (verification step)

---

## H. LIVE (deploy) — manual, prod

### H-01 · fresh not-yet-replied Yelp test lead → lead + **queued** task → worker greets within a tick → task **done** — **P2** (req #13a)
- **Priority:** P2 · **Type:** Live/manual (prod) · **Scenario:** end-to-end on real Yelp + Gmail + Gemini + the durable worker
- **Preconditions:** feature deployed; `YELP_AUTORESPONDER_ENABLED=true` and `FEATURE_AGENT_WORKER` **not** `false` in prod; **owner's explicit "да" per deploy** (deploy-consent). Use a **Yelp test / owner-controlled second account** — do **NOT** trigger against a real prospective customer (no-spam invariant).
- **Steps:** owner generates a genuinely new (not-yet-replied) Yelp quote request → observe the DB, not the inbox feel (cf. gmail-push lesson).
- **Expected, in order:** (1) within one push/poll cycle a `JobSource='Yelp', Status='Submitted'` lead appears; (2) **one** `tasks` row `kind='agent', agent_type='yelp_lead', agent_status='queued', status='open', max_attempts=3, lead_id=<the lead>`; (3) within one worker tick (`AGENT_WORKER_INTERVAL_MS`, default 5s) the task flips `agent_status='succeeded', status='done'` and `agent_task.succeeded` is journalled; (4) the test account **receives exactly one** greeting via the Yelp relay; (5) no duplicate on the next poll (claim holds); (6) **no** `mail_agent_review`/AR task for the Yelp thread.
- **File:** n/a (manual runbook)

### H-02 · forced-failure path leaves a visible **stuck** task on the lead — **P2** (req #13b)
- **Priority:** P2 · **Type:** Live/manual (staging preferred) · **Scenario:** observability of the terminal-failure signal
- **Preconditions:** staging (or a controlled prod window with owner "да"); a way to force the handler to fail all 3 attempts **without emailing a real customer** — e.g. temporarily point `emailService` at a sink that 503s, or feed a task whose `agent_input.reply_to` is a deliberately unroutable relay while `threadAlreadyGreeted=false` and the send is stubbed to throw. **Never** let a real send reach a real customer.
- **Steps:** enqueue/allow one `yelp_lead` task to exhaust `max_attempts=3`.
- **Expected:** after 3 attempts the task is `agent_status='failed', attempt_count=3, next_attempt_at IS NULL`, **`status='open'`** with `lead_id` set — i.e. it **remains visible/"stuck" on the lead** (surfaced by the `status='open'` agent-queue/AR index) and is **not** re-run (no further claims); `agent_task.failed` journalled **once**. This is the intended operator signal that a Yelp greeting permanently failed. Confirm the lead itself is intact (created regardless of the greeting outcome).
- **File:** n/a (manual runbook)

---

## Coverage gaps & flags (for Planner / Implementer / Tester)
1. **Enqueue-after-lead failure recovery (GAP #1 — highest, feeds `B-03`).** The LOCKED order is CLAIM → createLead → enqueue, with the claim **held** once the lead exists. If the enqueue INSERT fails *after* the lead is committed (`B-03`), the claim being held means a poll re-scan is a no-op → **the greeting task is lost** (lead visible, but never greeted, and no stuck task to see it). `B-03` asserts *no dup lead + logged*, but **cannot** assert recovery until the design picks: (a) enqueue in the **same transaction** as the lead (atomic — preferred), (b) a reconciler that finds `yelp_lead_events` rows with `status='claimed'` and no `succeeded/failed` task and re-enqueues, or (c) accept best-effort loss. **Pin the concrete assertion once chosen.**
2. **Terminal-predicate boundary is the whole regression story.** The `>=` vs `>` in `attempt_count+1 ⧧ max_attempts` is *literally* the line that keeps `job_geocode/route_calc/zb_job_sync` unchanged. `A-01`/`SAB-WORKER-REQUEUE-DEFAULT` guard it, but add a **table-driven** assertion of the terminal boundary for `max_attempts ∈ {1,2,3}` if cheap — a one-off off-by-one here silently turns every default task into an infinite/over-retried task (and, since `agent_task.succeeded` is billed and re-queues must stay silent, a spurious emit is also a **billing** regression — `A-02b`/`A-04` cover the emit side).
3. **Backoff clock in mocked tests.** `A-02b` asserts "future" `next_attempt_at`; if the Implementer computes it in **SQL** (`now() + interval`) rather than a JS `Date`, the mocked test can only assert the SQL expression, not a numeric time — `A-02`/`A-03b` (real DB) are the authoritative timing proofs. Prefer one style consistently so the mocked assertion is real.
4. **No jest migration-runner** in the repo → `F-01/F-02` are real-DB/psql checks, not pure jest (same limitation as `-001` `YLA-MIG-01/02`). The `max_attempts DEFAULT 1` opt-in is *the* safety property; verify it on a DB, not by reading the SQL.
5. **`max_attempts` source of truth.** These cases assume `max_attempts` is a **column** the enqueue writes (`3` for `yelp_lead`, DB-default `1` for everyone else). If instead it is read from a per-`agent_type` config map at claim time, `B-01`'s "INSERT carries `max_attempts=3`" assertion must move to that config and `A-*` must stub it — reconcile before writing the tests.
6. **`stuck` surfacing in the UI is out of scope here.** `H-02`/`A-02` prove the *data* state (`status='open' + agent_status='failed'`); whether the lead card renders it as an Action-Required/stuck chip is a separate FE assertion (the `idx_tasks_agent_queue`/AR-task machinery already keys on `status='open'`), not covered by these backend cases.
