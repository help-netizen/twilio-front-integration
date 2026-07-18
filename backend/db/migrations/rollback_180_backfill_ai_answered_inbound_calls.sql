-- AGENT-CALL-BADGE-001 is a data repair. A destructive rollback cannot tell
-- repaired rows from rows that already carried the canonical marker, so this
-- rollback is intentionally a documented no-op.
SELECT 1;
