-- ============================================================================
-- 105: tasks.updated_at — the AUTO-001 agent worker and the automation retry
-- route write `updated_at = now()` on tasks, but migration 100's ALTER TABLE
-- only added the agent_* columns, not updated_at. Add it. Idempotent.
-- ============================================================================

ALTER TABLE tasks
    ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();
