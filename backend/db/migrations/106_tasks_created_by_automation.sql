-- ============================================================================
-- 106: tasks.created_by — allow 'automation' (and 'agent'). The AUTO-001 rules
-- engine creates tasks with created_by='automation' (ruleActions.create_task),
-- but the original constraint (migration 038) only permitted 'system'/'user',
-- so every rule-created task failed with tasks_created_by_check. Extend it.
-- Idempotent.
-- ============================================================================

ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_created_by_check;
ALTER TABLE tasks ADD CONSTRAINT tasks_created_by_check
    CHECK (created_by = ANY (ARRAY['system', 'user', 'automation', 'agent']));
