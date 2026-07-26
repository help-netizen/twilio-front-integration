-- =============================================================================
-- Rollback 209: ACTIVITY-LOG-001 P1
-- =============================================================================

DROP INDEX IF EXISTS idx_audit_log_company_parent_created;
DROP INDEX IF EXISTS idx_audit_log_company_target_created;
