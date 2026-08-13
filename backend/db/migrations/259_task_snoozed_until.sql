-- SNOOZE-REWORK-001: keep a task's visibility snooze separate from its deadline.

ALTER TABLE tasks
    ADD COLUMN IF NOT EXISTS snoozed_until TIMESTAMPTZ NULL;

CREATE INDEX IF NOT EXISTS idx_tasks_snoozed_until
    ON tasks(snoozed_until)
    WHERE snoozed_until IS NOT NULL;
