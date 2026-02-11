-- =============================================================================
-- Migration 011: Create company_memberships table + alter crm_users
-- Links users to companies with roles
-- =============================================================================

-- 1. Add company_id to crm_users (nullable initially for backfill)
ALTER TABLE crm_users ADD COLUMN IF NOT EXISTS company_id UUID REFERENCES companies(id);

-- 2. Company memberships — authoritative source for user roles per company
CREATE TABLE IF NOT EXISTS company_memberships (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     UUID NOT NULL REFERENCES crm_users(id) ON DELETE CASCADE,
    company_id  UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    role        VARCHAR(50) NOT NULL DEFAULT 'company_member',
    status      VARCHAR(20) NOT NULL DEFAULT 'active',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT uq_user_company UNIQUE (user_id, company_id),
    CONSTRAINT chk_membership_role CHECK (role IN ('super_admin', 'company_admin', 'company_member'))
);

CREATE INDEX IF NOT EXISTS idx_memberships_user ON company_memberships(user_id);
CREATE INDEX IF NOT EXISTS idx_memberships_company ON company_memberships(company_id);
CREATE INDEX IF NOT EXISTS idx_memberships_role ON company_memberships(role);

CREATE TRIGGER trg_memberships_updated_at BEFORE UPDATE ON company_memberships
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

COMMENT ON TABLE company_memberships IS 'User-company-role associations (multi-tenant RBAC)';

-- 3. Invariant: at least one company_admin per active company
-- Enforced via trigger (§7)
CREATE OR REPLACE FUNCTION check_last_admin()
RETURNS TRIGGER AS $$
BEGIN
    -- Only check when role is changed FROM company_admin or membership is deleted/deactivated
    IF (TG_OP = 'DELETE' AND OLD.role = 'company_admin') OR
       (TG_OP = 'UPDATE' AND OLD.role = 'company_admin' AND (NEW.role != 'company_admin' OR NEW.status != 'active')) THEN
        IF NOT EXISTS (
            SELECT 1 FROM company_memberships
            WHERE company_id = OLD.company_id
              AND role = 'company_admin'
              AND status = 'active'
              AND id != OLD.id
        ) THEN
            RAISE EXCEPTION 'LAST_ADMIN_REQUIRED: Cannot remove the last company_admin from company %', OLD.company_id;
        END IF;
    END IF;
    
    IF TG_OP = 'DELETE' THEN
        RETURN OLD;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_protect_last_admin
    BEFORE UPDATE OR DELETE ON company_memberships
    FOR EACH ROW EXECUTE FUNCTION check_last_admin();
