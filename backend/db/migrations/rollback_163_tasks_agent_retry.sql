-- =============================================================================
-- Rollback migration 163 — YELP-LEAD-AUTORESPONDER-002 tasks retry columns.
-- Drops the 4 additive columns (3 on tasks, 1 on yelp_lead_events). Idempotent
-- (DROP COLUMN IF EXISTS); leaves no orphaned index/constraint. Re-applying the
-- forward migration afterwards succeeds (its guards are IF NOT EXISTS).
-- =============================================================================

ALTER TABLE tasks
    DROP COLUMN IF EXISTS next_attempt_at,
    DROP COLUMN IF EXISTS max_attempts,
    DROP COLUMN IF EXISTS attempt_count;

ALTER TABLE yelp_lead_events
    DROP COLUMN IF EXISTS task_id;
