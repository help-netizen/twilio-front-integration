-- Roll back SNOOZE-REWORK-001. Safe to run repeatedly.

DROP INDEX IF EXISTS idx_tasks_snoozed_until;

ALTER TABLE tasks
    DROP COLUMN IF EXISTS snoozed_until;
