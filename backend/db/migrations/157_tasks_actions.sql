-- OUTBOUND-PARTS-CALL-001 (OPC1-T2 / TASK-ACTIONS) — add a nullable jsonb `actions`
-- column to `tasks`.
--
-- Orthogonal to `agent_output`/`kind` (owned by MAIL-AGENT-001 / AUTO-001 and read by
-- TASKS-COUNT-BADGE / AR-TASK-UNIFY / agentWorker) — overloading those would break them.
-- `actions` is nullable and ignored by every existing query. Shape:
--   [{ type, label, icon?, state? }]  where type ∈ the closed action registry.
-- No index/constraint change on `tasks`.

ALTER TABLE tasks ADD COLUMN IF NOT EXISTS actions jsonb;

COMMENT ON COLUMN tasks.actions IS 'OUTBOUND-PARTS-CALL-001 (TASK-ACTIONS): typed action buttons on a task, e.g. [{ type, label, icon?, state? }]. Nullable, orthogonal to kind/agent_output.';

-- OUTBOUND-PARTS-CALL-001 (OPC1-T17 fix): the auto-task created by
-- `partsCallService.onPartArrived` carries `kind='part_arrived_call'` (§B.3). The
-- original `tasks_kind_check` (migration 100) only permitted ('user','agent'), so
-- that INSERT would violate the CHECK — and because `onPartArrived` is fired
-- fire-and-forget (its throw is swallowed by the hook's `.catch`), the auto-task
-- would SILENTLY never be created on a real DB (the mocked jest never saw the
-- constraint). Relax the CHECK additively to include the closed `part_arrived_call`
-- kind. Idempotent: drop-if-exists then re-add.
ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_kind_check;
ALTER TABLE tasks ADD CONSTRAINT tasks_kind_check
    CHECK (kind IN ('user', 'agent', 'part_arrived_call'));
