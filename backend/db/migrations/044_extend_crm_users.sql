-- =============================================================================
-- Migration 044: Extend crm_users for PF007 platform role separation
-- Adds platform_role, primary_membership_id, onboarding_status
-- =============================================================================

-- Platform role: separates platform authority from tenant membership
ALTER TABLE crm_users ADD COLUMN IF NOT EXISTS platform_role VARCHAR(50) NOT NULL DEFAULT 'none';
ALTER TABLE crm_users ADD CONSTRAINT crm_users_platform_role_check
    CHECK (platform_role IN ('none', 'super_admin'));

-- Primary membership pointer (resolved at login)
ALTER TABLE crm_users ADD COLUMN IF NOT EXISTS primary_membership_id UUID;
-- FK added after company_memberships columns are finalized

-- Onboarding lifecycle
ALTER TABLE crm_users ADD COLUMN IF NOT EXISTS onboarding_status VARCHAR(20) NOT NULL DEFAULT 'active';
ALTER TABLE crm_users ADD CONSTRAINT crm_users_onboarding_status_check
    CHECK (onboarding_status IN ('invited', 'active', 'disabled'));

ALTER TABLE crm_users ADD COLUMN IF NOT EXISTS last_invited_at TIMESTAMPTZ;

-- Backfill: existing super_admin users get platform_role = 'super_admin'
UPDATE crm_users SET platform_role = 'super_admin'
WHERE role = 'super_admin' AND platform_role = 'none';

CREATE INDEX IF NOT EXISTS idx_crm_users_platform_role ON crm_users(platform_role);
