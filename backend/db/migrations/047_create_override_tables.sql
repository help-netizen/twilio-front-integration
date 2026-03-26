-- =============================================================================
-- Migration 047: Create membership override tables for PF007 RBAC
-- Employee-level permission and scope overrides
-- =============================================================================

-- 1. Permission overrides — granular per-user toggles on top of role matrix
CREATE TABLE IF NOT EXISTS company_membership_permission_overrides (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    membership_id   UUID NOT NULL REFERENCES company_memberships(id) ON DELETE CASCADE,
    permission_key  VARCHAR(100) NOT NULL,
    override_mode   VARCHAR(10) NOT NULL,
    created_by      UUID REFERENCES crm_users(id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT uq_membership_perm_override UNIQUE (membership_id, permission_key),
    CONSTRAINT chk_override_mode CHECK (override_mode IN ('allow', 'deny'))
);

CREATE INDEX IF NOT EXISTS idx_membership_perm_overrides ON company_membership_permission_overrides(membership_id);

CREATE TRIGGER trg_membership_perm_overrides_updated_at BEFORE UPDATE ON company_membership_permission_overrides
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

COMMENT ON TABLE company_membership_permission_overrides IS 'Per-employee permission overrides on top of role matrix (PF007)';

-- 2. Scope overrides — per-user scope restrictions
CREATE TABLE IF NOT EXISTS company_membership_scope_overrides (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    membership_id   UUID NOT NULL REFERENCES company_memberships(id) ON DELETE CASCADE,
    scope_key       VARCHAR(100) NOT NULL,
    scope_json      JSONB NOT NULL DEFAULT '{}',
    created_by      UUID REFERENCES crm_users(id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT uq_membership_scope_override UNIQUE (membership_id, scope_key)
);

CREATE INDEX IF NOT EXISTS idx_membership_scope_overrides ON company_membership_scope_overrides(membership_id);

CREATE TRIGGER trg_membership_scope_overrides_updated_at BEFORE UPDATE ON company_membership_scope_overrides
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

COMMENT ON TABLE company_membership_scope_overrides IS 'Per-employee scope overrides (e.g. assigned_only, financial visibility) (PF007)';
