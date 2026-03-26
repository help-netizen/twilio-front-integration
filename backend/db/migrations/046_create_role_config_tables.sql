-- =============================================================================
-- Migration 046: Create role configuration tables for PF007 RBAC
-- company_role_configs, company_role_permissions, company_role_scopes
-- =============================================================================

-- 1. Company role configs — one row per fixed system role per company
CREATE TABLE IF NOT EXISTS company_role_configs (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id  UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    role_key    VARCHAR(50) NOT NULL,
    display_name VARCHAR(100) NOT NULL,
    description TEXT,
    is_locked   BOOLEAN NOT NULL DEFAULT false,
    created_by  UUID REFERENCES crm_users(id),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT uq_company_role_config UNIQUE (company_id, role_key),
    CONSTRAINT chk_role_config_key CHECK (role_key IN ('tenant_admin', 'manager', 'dispatcher', 'provider'))
);

CREATE INDEX IF NOT EXISTS idx_role_configs_company ON company_role_configs(company_id);

CREATE TRIGGER trg_role_configs_updated_at BEFORE UPDATE ON company_role_configs
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

COMMENT ON TABLE company_role_configs IS 'Tenant-scoped configs for fixed system roles (PF007)';

-- 2. Company role permissions — permission matrix per role
CREATE TABLE IF NOT EXISTS company_role_permissions (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    role_config_id  UUID NOT NULL REFERENCES company_role_configs(id) ON DELETE CASCADE,
    permission_key  VARCHAR(100) NOT NULL,
    is_allowed      BOOLEAN NOT NULL DEFAULT false,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT uq_role_permission UNIQUE (role_config_id, permission_key)
);

CREATE INDEX IF NOT EXISTS idx_role_permissions_config ON company_role_permissions(role_config_id);

CREATE TRIGGER trg_role_permissions_updated_at BEFORE UPDATE ON company_role_permissions
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

COMMENT ON TABLE company_role_permissions IS 'Permission matrix for each system role within a company';

-- 3. Company role scopes — advanced restrictions per role
CREATE TABLE IF NOT EXISTS company_role_scopes (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    role_config_id  UUID NOT NULL REFERENCES company_role_configs(id) ON DELETE CASCADE,
    scope_key       VARCHAR(100) NOT NULL,
    scope_json      JSONB NOT NULL DEFAULT '{}',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT uq_role_scope UNIQUE (role_config_id, scope_key)
);

CREATE INDEX IF NOT EXISTS idx_role_scopes_config ON company_role_scopes(role_config_id);

CREATE TRIGGER trg_role_scopes_updated_at BEFORE UPDATE ON company_role_scopes
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

COMMENT ON TABLE company_role_scopes IS 'Advanced restriction scopes per role (e.g. job_visibility, financial_scope)';
