-- =============================================================================
-- 139: Unify Action Required with Tasks (AR-TASK-UNIFY-001)
-- "Action Required" on a Pulse timeline is now just an open task on that
-- timeline (task parent_type='timeline', reusing tasks.thread_id). A timeline
-- can hold MANY open tasks — like any other entity — so the v1 "at most one
-- open task per thread" unique index is dropped. Inbound's single auto-task is
-- upserted at the application layer (timelinesQueries.createTask), so it no
-- longer depends on this DB constraint. No column changes.
-- =============================================================================

DROP INDEX IF EXISTS uq_tasks_one_open_per_thread;

-- "Open tasks for a timeline, earliest-due first" — powers the in-card task
-- stack and the derived Action Required badge/section.
CREATE INDEX IF NOT EXISTS idx_tasks_thread_open_due
    ON tasks(thread_id, due_at) WHERE status = 'open';

COMMENT ON INDEX idx_tasks_thread_open_due IS 'AR-TASK-UNIFY-001: open tasks per timeline (thread)';
