-- =============================================================================
-- Migration 052: Add schedule columns to tasks table (PF001)
-- Enables tasks to appear on the unified schedule view
-- =============================================================================

ALTER TABLE tasks
    ADD COLUMN IF NOT EXISTS start_at              TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS end_at                TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS assigned_provider_id  UUID REFERENCES crm_users(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS show_on_schedule      BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_tasks_schedule
    ON tasks(company_id, start_at, end_at) WHERE show_on_schedule = true;

CREATE INDEX IF NOT EXISTS idx_tasks_assigned_provider
    ON tasks(assigned_provider_id) WHERE assigned_provider_id IS NOT NULL;

COMMENT ON COLUMN tasks.start_at IS 'PF001: Schedule start time (nullable for non-scheduled tasks)';
COMMENT ON COLUMN tasks.end_at IS 'PF001: Schedule end time';
COMMENT ON COLUMN tasks.assigned_provider_id IS 'PF001: Assigned field provider for dispatch';
COMMENT ON COLUMN tasks.show_on_schedule IS 'PF001: Whether this task appears on the schedule view';
