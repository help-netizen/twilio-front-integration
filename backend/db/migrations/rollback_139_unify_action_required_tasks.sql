-- Rollback 139 (AR-TASK-UNIFY-001).
-- WARNING: re-creating the unique index FAILS if any timeline now has more than
-- one open task (allowed since 139). Collapse duplicates to a single open task
-- per thread before rolling back.

DROP INDEX IF EXISTS idx_tasks_thread_open_due;

CREATE UNIQUE INDEX IF NOT EXISTS uq_tasks_one_open_per_thread
    ON tasks(thread_id) WHERE status = 'open';
