-- =============================================================================
-- Migration 014: Update crm_users.role CHECK constraint
-- Old constraint only allowed legacy role values (viewer, admin etc.)
-- New RBAC uses: super_admin, company_admin, company_member
-- =============================================================================

-- Drop old constraint (may or may not exist with this exact name)
ALTER TABLE crm_users DROP CONSTRAINT IF EXISTS crm_users_role_check;

-- Add new constraint with correct role values
ALTER TABLE crm_users ADD CONSTRAINT crm_users_role_check
    CHECK (role IN ('super_admin', 'company_admin', 'company_member', 'viewer'));

-- Update any existing 'viewer' roles to 'company_member'
UPDATE crm_users SET role = 'company_member' WHERE role = 'viewer';

-- Also update default
ALTER TABLE crm_users ALTER COLUMN role SET DEFAULT 'company_member';
