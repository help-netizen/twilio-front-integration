-- Rollback for 157_tasks_actions.sql (OUTBOUND-PARTS-CALL-001 / OPC1-T2).
ALTER TABLE tasks DROP COLUMN IF EXISTS actions;
