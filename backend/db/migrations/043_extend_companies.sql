-- =============================================================================
-- Migration 043: Extend companies table for PF007 platform admin
-- Adds timezone, locale, contact fields, lifecycle timestamps
-- =============================================================================

ALTER TABLE companies ADD COLUMN IF NOT EXISTS timezone VARCHAR(100) DEFAULT 'America/New_York';
ALTER TABLE companies ADD COLUMN IF NOT EXISTS locale VARCHAR(20) DEFAULT 'en-US';
ALTER TABLE companies ADD COLUMN IF NOT EXISTS contact_email VARCHAR(255);
ALTER TABLE companies ADD COLUMN IF NOT EXISTS contact_phone VARCHAR(50);
ALTER TABLE companies ADD COLUMN IF NOT EXISTS billing_email VARCHAR(255);
ALTER TABLE companies ADD COLUMN IF NOT EXISTS created_by_user_id UUID REFERENCES crm_users(id);
ALTER TABLE companies ADD COLUMN IF NOT EXISTS suspended_at TIMESTAMPTZ;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS status_reason TEXT;

-- Update status CHECK to include new lifecycle states
ALTER TABLE companies DROP CONSTRAINT IF EXISTS companies_status_check;
ALTER TABLE companies ADD CONSTRAINT companies_status_check
    CHECK (status IN ('active', 'suspended', 'archived', 'onboarding'));

-- Backfill: set timezone for existing companies
UPDATE companies SET timezone = 'America/New_York' WHERE timezone IS NULL;
