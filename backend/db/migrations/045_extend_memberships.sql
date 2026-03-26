-- =============================================================================
-- Migration 045: Extend company_memberships for PF007 fixed system roles
-- Adds role_key, invite tracking, lifecycle timestamps
-- =============================================================================

-- New role_key column: fixed system roles (authoritative after migration)
ALTER TABLE company_memberships ADD COLUMN IF NOT EXISTS role_key VARCHAR(50);
ALTER TABLE company_memberships ADD CONSTRAINT chk_membership_role_key
    CHECK (role_key IS NULL OR role_key IN ('tenant_admin', 'manager', 'dispatcher', 'provider'));

-- Primary membership flag
ALTER TABLE company_memberships ADD COLUMN IF NOT EXISTS is_primary BOOLEAN NOT NULL DEFAULT false;

-- Invite tracking
ALTER TABLE company_memberships ADD COLUMN IF NOT EXISTS invited_by UUID REFERENCES crm_users(id);
ALTER TABLE company_memberships ADD COLUMN IF NOT EXISTS invited_at TIMESTAMPTZ;
ALTER TABLE company_memberships ADD COLUMN IF NOT EXISTS activated_at TIMESTAMPTZ;
ALTER TABLE company_memberships ADD COLUMN IF NOT EXISTS disabled_at TIMESTAMPTZ;
ALTER TABLE company_memberships ADD COLUMN IF NOT EXISTS disabled_reason TEXT;

-- Backfill: map legacy roles → fixed system roles
UPDATE company_memberships SET role_key = 'tenant_admin' WHERE role = 'company_admin' AND role_key IS NULL;
UPDATE company_memberships SET role_key = 'dispatcher'   WHERE role = 'company_member' AND role_key IS NULL;
UPDATE company_memberships SET role_key = 'dispatcher'   WHERE role = 'super_admin' AND role_key IS NULL;

-- Backfill: mark first membership per user as primary
UPDATE company_memberships SET is_primary = true
WHERE id IN (
    SELECT DISTINCT ON (user_id) id
    FROM company_memberships
    WHERE status = 'active'
    ORDER BY user_id, created_at ASC
);

-- Backfill: set activated_at for existing active memberships
UPDATE company_memberships SET activated_at = created_at WHERE status = 'active' AND activated_at IS NULL;

-- Now add FK for crm_users.primary_membership_id
ALTER TABLE crm_users ADD CONSTRAINT fk_crm_users_primary_membership
    FOREIGN KEY (primary_membership_id) REFERENCES company_memberships(id);

-- Backfill primary_membership_id on crm_users
UPDATE crm_users u SET primary_membership_id = m.id
FROM company_memberships m
WHERE m.user_id = u.id AND m.is_primary = true AND u.primary_membership_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_memberships_role_key ON company_memberships(role_key);

-- Update check_last_admin trigger to also protect tenant_admin via role_key
CREATE OR REPLACE FUNCTION check_last_admin()
RETURNS TRIGGER AS $$
BEGIN
    -- Check legacy role column
    IF (TG_OP = 'DELETE' AND OLD.role = 'company_admin') OR
       (TG_OP = 'UPDATE' AND OLD.role = 'company_admin' AND (NEW.role != 'company_admin' OR NEW.status != 'active')) THEN
        IF NOT EXISTS (
            SELECT 1 FROM company_memberships
            WHERE company_id = OLD.company_id
              AND (role = 'company_admin' OR role_key = 'tenant_admin')
              AND status = 'active'
              AND id != OLD.id
        ) THEN
            RAISE EXCEPTION 'LAST_ADMIN_REQUIRED: Cannot remove the last admin from company %', OLD.company_id;
        END IF;
    END IF;

    -- Check new role_key column
    IF (TG_OP = 'DELETE' AND OLD.role_key = 'tenant_admin') OR
       (TG_OP = 'UPDATE' AND OLD.role_key = 'tenant_admin' AND (NEW.role_key != 'tenant_admin' OR NEW.status != 'active')) THEN
        IF NOT EXISTS (
            SELECT 1 FROM company_memberships
            WHERE company_id = OLD.company_id
              AND (role = 'company_admin' OR role_key = 'tenant_admin')
              AND status = 'active'
              AND id != OLD.id
        ) THEN
            RAISE EXCEPTION 'LAST_ADMIN_REQUIRED: Cannot remove the last admin from company %', OLD.company_id;
        END IF;
    END IF;

    IF TG_OP = 'DELETE' THEN
        RETURN OLD;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
