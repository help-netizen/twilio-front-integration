# YELP-LEAD-AUTORESPONDER-002 — Behavior Spec (durable task+agent refactor)

**Status:** Spec · Backend-only · P1 · 2026-07-10
**Requirements:** `docs/requirements.md › YELP-LEAD-AUTORESPONDER-002` (R1–R8 / AC1–AC8, boundaries B1–B6).
**Architecture:** `docs/architecture.md › YELP-LEAD-AUTORESPONDER-002`.
**Builds on (do NOT restate here):** `AUTO-001` (shared `agentWorker`, `agentHandlers` registry, `tasks.kind='agent'`, atomic `FOR UPDATE SKIP LOCKED` claim, `agent_task.succeeded|failed` events, mig 100), `EMAIL-TIMELINE-001` (`linkInboundMessage` inbound seam), `YELP-LEAD-AUTORESPONDER-001` (detector/claim/parse/createLead, detection truth-table §3, parse §4, lead field-map §6, `yelp_lead_events` mig 162 ledger, `yelpGreetingService`).
**Feature flag:** `YELP_AUTORESPONDER_ENABLED` (default OFF) + default-company scope — checked at **DETECT only**. Retry bound `YELP_LEAD_MAX_ATTEMPTS` (default 3); cadence reuses `AGENT_WORKER_INTERVAL_MS` (~5s).
**Migration:** `backend/db/migrations/163_tasks_agent_retry.sql` (+ paired rollback) — **RECHECK next-free at build** (on-disk max = 162; 161 consumed by a parallel worktree).

## 1. Overview
Split 001's *synchronous* greet-inside-the-ingest-hook into two durable phases: (a) a deterministic no-LLM **detector** creates the lead and **enqueues** one `agent_type='yelp_lead'` task; (b) the shared `agentWorker` claims it and a new **`yelp_lead` handler** builds + sends the single greeting, then closes the task `done`. Same Gemini greeting + same Yelp email relay as 001 — just moved off the mail-ingest hot path onto the AUTO-001 queue: retryable (≤3, backoff), Pulse-visible when stuck, zero Mail-Secretary coupling. No new UI/API/external integration. The 001 synchronous greet/send/markGreeted block is **removed entirely** (B6) — never left dormant — so a greeting can never fire twice.

## 2. Detector — `maybeHandleYelpLead(companyId, msg)` (R1/R8; fail-open, never throws)
Order (KEPT from 001): env/scope gate → `detectYelpLead` → `claimYelpLead` (`yelp_lead_events` UNIQUE(company_id, provider_message_id)) → `parseYelpLead` (fail-safe partial) → `buildLeadFields` → `createLead` (`JobSource='Yelp'`, `Status='Submitted'` → `lead.created` SSE). Then **ENQUEUE** (replaces greet+send) and return `{handled:true, skipped:'yelp_lead'}`. Detection truth-table / parse / lead field-map = unchanged from `YELP-LEAD-AUTORESPONDER-001 §3–6`.
- **`releaseClaim` ONLY if `createLead` throws** → next poll re-creates it (lead at-least-once, S8). Claim is HELD once the lead exists (greeting at-most-once).
- **REMOVED (moved into the handler):** `threadAlreadyGreeted`, `buildGreeting`, `emailService.sendEmail`, `markGreeted`.

### Enqueue contract (single INSERT, best-effort)
```
INSERT INTO tasks (company_id, kind, agent_type, agent_input, agent_status,
                   max_attempts, title, status, created_by, lead_id, subject_type)
VALUES ($company,'agent','yelp_lead',$input::jsonb,'queued', 3,
        $title,'open','automation',$leadId,'lead')
```
`agent_input` = `{ claim_id, provider_message_id, thread_token, reply_to, lead_id, customer_name, service_type, problem_text, zip }` — `claim_id` (= `yelp_lead_events.id` returned by `claimYelpLead`) is added vs. the brief so the handler can call `markGreeted(claim_id,…)`.
- `lead_id` is **load-bearing**: it parents the task to the lead so a stuck task surfaces in that lead's task stack (§5).
- `max_attempts=3` opts THIS type (and only this type) into retry (§4).
- **Enqueue-INSERT failure → HOLD the claim + log (NO `releaseClaim`** — the lead already exists; releasing would duplicate it on the next poll). The `yelp_lead_events` row then sits `greeted_at IS NULL` = a detectable "claimed-but-not-enqueued" state a future reconcile can re-enqueue (B1). Never a dup lead, never a silent second greeting.

## 3. Handler `yelp_lead` (agentHandlers.js) — state machine (R2/R4; idempotent, retry-safe)
```
i = task.agent_input || {}
1. no i.reply_to      → markGreeted(claim_id,{…,status:'handled_no_send'}) [best-effort] → return {skipped:'no_reply_to'}   (NOT an error → S9)
2. threadAlreadyGreeted(company_id, i.thread_token)?  → return {skipped:'already_greeted'}   (retry-safe no-op — NEVER double-send)
3. body = await buildGreeting({name,service,problem})   (never throws; Gemini + static fallback)
4. sent = await emailService.sendEmail(company_id,{to:i.reply_to, subject:`Re: ${service||'your'} request`, body})   (THE ONLY throw → drives retry)
5. try markGreeted(i.claim_id,{leadId,threadToken,greetingProviderMessageId:sent?.provider_message_id,status:'greeted'}) catch{log}   (best-effort)
6. return {greeted:true, lead_id, provider_message_id}   → worker marks succeeded/done
```
**Invariants:** `threadAlreadyGreeted` runs FIRST; `buildGreeting` never throws; `sendEmail` is the only throw that reaches the worker → and at that point nothing was sent, so a retry still sees `threadAlreadyGreeted=false` → safe re-send. **`markGreeted` is deliberately non-fatal** — if it threw *after* a successful send, the worker would retry and double-send; swallowing its error lets the task succeed (the email is the source of truth).

## 4. Retry — shared `agentWorker`, additive + OPT-IN (R3/R6; the critical change)
Migration 163 adds to `tasks`: `attempt_count int NOT NULL default 0`, `max_attempts int NOT NULL default 1`, `next_attempt_at timestamptz`. Claim SELECT gains `AND (next_attempt_at IS NULL OR next_attempt_at <= now())` (B4; existing `idx_tasks_agent_queue` still fronts it — no new index).

**Retry state machine** `queued → running → [re-queued | succeeded | failed]`:
```
success  → agent_status='succeeded', status='done', completed_at; emit agent_task.succeeded (once)    [branch UNCHANGED]
failure  → next = (attempt_count ?? 0) + 1
   next < max_attempts → agent_status='queued', attempt_count=next,
                         next_attempt_at = now()+backoff(next), agent_output=err;  NO event  (re-queued)
   else (terminal)     → agent_status='failed', attempt_count=next, next_attempt_at=NULL,
                         agent_output=err;  emit agent_task.failed ONCE
```
`backoff(n) = min(60·2^(n-1), 300)s ±20% jitter` (env `AGENT_TASK_RETRY_BASE_SEC`/`_CAP_SEC`). For `max_attempts=3`: attempt-1 immediate → retry ~1m → retry ~2m → terminal by ~3m.
**Opt-in safety proof (R6):** existing enqueuers never set `max_attempts` → default **1** → `next(=1) < 1` is false → terminal-on-first-failure + one `agent_task.failed`, byte-for-byte today. `next_attempt_at` NULL → the added predicate `IS NULL` is always true → non-opted tasks claimed exactly as before. Retry is reachable ONLY by a row that set `max_attempts>1`, i.e. `yelp_lead`. **Billing:** `agent_task.succeeded` (only billed event) fires once, terminally → 1 agent_run per greeting; retries emit nothing to the bus → no rule storms, no double-bill. `agent_task.failed` fires once, terminal only.

## 5. "Stuck" surface (no new UI, no enum change)
"Stuck" is **derived**, not a 5th `agent_status`: `kind='agent' AND agent_status='failed' AND status='open' AND attempt_count>=max_attempts`. The worker's failure branch writes only `agent_status` and **leaves `status='open'`** — so a terminally-failed `yelp_lead` task is, by construction, an **open task parented to the lead** (`lead_id`). `GET /api/tasks/entity/lead/:id` → `listEntityTasks` (no `kind` filter; projection exposes `agent_type` + `agent_output.error`) returns it, rendering in that lead's open-task stack: dispatcher sees the failure reason + the `reply_to` (carried in lead notes) for a manual reply. `agent_status='failed'` excludes it from the `queued` claim scan; it drops out the moment a dispatcher marks it `done`. Mig-100 `agent_status` CHECK is untouched (no `stuck` value added). (No timeline exists for a phone-less Yelp lead → `set_action_required` is N/A; the lead parent is the correct surface — B2.)

## 6. Decoupling from the Mail Secretary (R5)
Detector + handler closure = `yelpLeadQueries`, `leadsService`, `yelpGreetingService`, `emailService`, `connection` — **no `mailAgentService` / `mailAgentClassifier` / `reviewInboundEmail`**. The ingest hook runs `maybeHandleYelpLead` BEFORE the mute + Mail-Secretary branch and short-circuits `{skipped:'yelp_lead'}` → the Secretary never sees Yelp relay mail (no duplicate review/AR task). `agent_type='yelp_lead'` is intentionally **NOT** in `eventCatalog.AGENT_TYPES` (internal type, enqueued directly by the detector, never a user-selectable rule action).

## 7. Scenarios
- **S1 — detect → lead → enqueue (AC1/R1).** Gated new-lead email → claim → parse → `createLead` → ENQUEUE one `queued yelp_lead` task; **the ingest tick sends NO greeting**. Result: exactly one Pulse-visible lead + one queued task. A customer reply / `no-reply@` confirmation → neither (001 §3 truth-table).
- **S2 — worker greets, closes (AC2/R2).** Next worker tick (**≤1 tick, ~5s**) claims the queued task → `threadAlreadyGreeted`(false) → `buildGreeting` → `sendEmail(to=reply_to)` → `markGreeted` → returns → worker sets `succeeded/done`. Exactly one relay greeting; one `agent_task.succeeded` (1 agent_run).
- **S3 — forced handler failure → retry ≤3 → stuck (AC3/R3).** `sendEmail` throws every attempt → re-queued with backoff attempt 1→2→3; after the 3rd, terminal `agent_status='failed'`, `next_attempt_at=NULL`, one `agent_task.failed`, `status` stays `open` → **stuck** open task on the lead (§5) carrying `attempt_count` + last error.
- **S4 — re-ingest / double worker-run → idempotent (AC4/R4).** Same `provider_message_id` re-ingested (push+poll overlap) → `claimYelpLead` conflict → **no 2nd lead, no 2nd task**. Handler run twice on one thread (natural retry OR crash between send and mark) → 2nd run short-circuits at `threadAlreadyGreeted` → **at most one greeting**, closes without re-sending.
- **S5 — Mail-Secretary down (AC5/R5).** `mailAgentService` disabled/erroring → Yelp still detected, lead created, task enqueued, greeting sent; the Secretary logs **no** duplicate review/AR for it. A NON-Yelp inbound email reaches the Secretary exactly as before (untouched path).
- **S6 — existing agent types unaffected (AC6/R6).** Forced `job_geocode` / `route_calc` / `zb_job_sync` / `mcp_tool` failure → default `max_attempts=1` → terminal `failed` + one `agent_task.failed`; no re-queue, no backoff, no stuck. `mcp_tool` (not universally idempotent) stays default-1 → never retries.
- **S7 — safe-fail (AC7/R7).** A thrown detector is fail-open → the email flows through the normal ingest pipeline (push route / poll tick never crash). A thrown handler is caught per-task by `processBatch` try/catch → the worker loop + sibling batch tasks keep running. The retry/backoff/stuck logic is itself wrapped → it cannot throw out of the loop.
- **S8 — lead at-least-once (AC8/R8).** `createLead` throws → `releaseClaim` → next poll re-creates the lead. Once the lead exists the claim is HELD → no dup lead, no dup greeting.
- **S9 — no `reply_to` → handled_no_send (R2).** Missing/mangled `reply_to` → handler `markGreeted(status:'handled_no_send')` (best-effort) + returns `{skipped:'no_reply_to'}` → task closes `succeeded/done`, **not** a retryable error, **never** a misrouted send. Lead still present for manual follow-up.
- **S10 — send-then-crash → no double-send (R4/B3).** Crash BETWEEN `sendEmail` (provider accepted) and `markGreeted` → task retryable. Backstop: `threadAlreadyGreeted` checked FIRST + Yelp's one-reply-per-thread rule. Design trades a rare lost greeting for **never** double-sending (Yelp rejects a 2nd reply). `markGreeted` non-fatal ⇒ a ledger error never forces a resend. Residual (accepted): `sendEmail` throws *after* the provider accepted → one retry could double-post — inherent to at-least-once email, matches 001's exposure.
- **S11 — env gate OFF (R1/N3/B5).** `YELP_AUTORESPONDER_ENABLED` unset or non-default company → detector returns not-handled immediately: no detect side-effects, no claim, no lead, no enqueue → normal pipeline. Gate checked at DETECT only → a task already `queued` still runs to completion if the flag flips OFF after enqueue (no stranded greeting).

## 8. Data isolation & migration
All reads/writes `company_id`-scoped (`companyId` from `linkInboundMessage`); the worker claims only `company_id IS NOT NULL` agent tasks; `yelp_lead_events` uniqueness is per-company; the greeting is sent only via that company's own mailbox. Migration 163 is additive/idempotent (`ADD COLUMN IF NOT EXISTS`), rollback drops the 3 columns; no existing row or agent type changes meaning (N5).

## 9. Edge-cases for Implementer / Tester
1. **B1 enqueue atomicity (lead ↔ task):** prefer enqueuing the task in the SAME transaction that finalizes the claim/creates the lead; or stamp `task_id` on the claim row so "`lead_id` present, `task_id` null" = re-enqueue-only on re-scan. **Never** release-after-lead (would duplicate the lead). Tester: assert claimed-but-taskless never becomes a silent no-greeting.
2. **Migration number:** re-verify next-free at build (`ls backend/db/migrations/`) — 161 consumed by a parallel worktree; keep the rollback paired.
3. **Worker regression test (top risk):** assert default `max_attempts=1` → terminal-on-first-failure + a single `agent_task.failed` for a non-opted type (proves the opt-in equivalence that protects geocode/route/zb/mcp_tool).
4. **`markGreeted` must stay non-fatal** in the handler — a throw *after* a successful send would force a double-send retry (Yelp rejects it).
5. **Enqueue `title`:** pick a human-readable stuck-task label (e.g. "Yelp greeting — <customer_name>") since it renders in the lead's open-task stack (§5).
6. **Subject line** `Re: <service_type||'your'> request` — confirm it matches 001's thread-continuation expectation so the relay threads correctly.
