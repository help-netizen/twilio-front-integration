-- =============================================================================
-- Migration 163: tasks retry columns — YELP-LEAD-AUTORESPONDER-002 (durable
-- task+agent refactor). ADDITIVE + OPT-IN retry on the shared agentWorker.
--
-- attempt_count / max_attempts / next_attempt_at let the shared agentWorker retry
-- a failed kind='agent' task with backoff — but ONLY when a row explicitly opts in
-- via max_attempts>1. The DEFAULT max_attempts=1 keeps EVERY existing agent type
-- (job_geocode / route_calc / zb_job_sync / mcp_tool / summarize_thread / noop)
-- terminal-on-first-failure, byte-for-byte as before (see agentWorker.processBatch:
-- next = attempt_count+1; next>=max_attempts → terminal). next_attempt_at defaults
-- NULL so the added claim predicate (next_attempt_at IS NULL OR <= now()) is always
-- true for non-opted rows → they are claimed exactly as before.
--
-- yelp_lead_events.task_id links a claim to its enqueued greeting task so the
-- detector's B1 reconcile can spot a "claimed-but-never-enqueued" row
-- (task_id IS NULL AND greeted_at IS NULL) and re-enqueue it — no new cron.
--
-- Additive, idempotent (ADD COLUMN IF NOT EXISTS), touches no existing rows. No
-- CHECK/enum change: agent_status='queued' (a re-queue) is already permitted by the
-- migration-100 CHECK, and "stuck" is DERIVED (agent_status='failed' AND
-- status='open' AND attempt_count>=max_attempts), not a new enum value.
-- Reversible via rollback_163_tasks_agent_retry.sql.
--
-- Migration number: max on disk = 162 (161 consumed by a parallel worktree) →
-- next free = 163. No new index — the existing idx_tasks_agent_queue still fronts
-- the claim; the tiny candidate set makes the next_attempt_at filter free.
-- =============================================================================

ALTER TABLE tasks
    ADD COLUMN IF NOT EXISTS attempt_count   INTEGER     NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS max_attempts    INTEGER     NOT NULL DEFAULT 1,
    ADD COLUMN IF NOT EXISTS next_attempt_at TIMESTAMPTZ;

ALTER TABLE yelp_lead_events
    ADD COLUMN IF NOT EXISTS task_id BIGINT;

COMMENT ON COLUMN tasks.attempt_count   IS 'YELP-LEAD-AUTORESPONDER-002: completed handler attempts for a kind=agent task (0 until the first run fails).';
COMMENT ON COLUMN tasks.max_attempts    IS 'YELP-LEAD-AUTORESPONDER-002: retry bound. DEFAULT 1 = terminal-on-first-failure (opt-in retry: only max_attempts>1 re-queues).';
COMMENT ON COLUMN tasks.next_attempt_at IS 'YELP-LEAD-AUTORESPONDER-002: earliest re-claim time after a backed-off retry; NULL = immediately eligible.';
COMMENT ON COLUMN yelp_lead_events.task_id IS 'YELP-LEAD-AUTORESPONDER-002: the enqueued yelp_lead agent task id; task_id NULL AND greeted_at NULL = claimed-but-never-enqueued (detector reconcile re-enqueues).';
