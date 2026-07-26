-- =============================================================================
-- 209: ACTIVITY-LOG-001 P1 — canonical History read-model indexes
-- =============================================================================

CREATE INDEX IF NOT EXISTS idx_audit_log_company_target_created
    ON audit_log (company_id, target_type, target_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_audit_log_company_parent_created
    ON audit_log (
        company_id,
        (details->>'parent_type'),
        (details->>'parent_id'),
        created_at DESC
    )
    WHERE details ? 'parent_type' AND details ? 'parent_id';
