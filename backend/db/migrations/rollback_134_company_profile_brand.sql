-- Rollback for Migration 134: COMPANY-PROFILE-001 — company branding + payment details
-- Drops the logo + payment columns added to companies.

ALTER TABLE companies DROP COLUMN IF EXISTS logo_storage_key;
ALTER TABLE companies DROP COLUMN IF EXISTS payment_bank_name;
ALTER TABLE companies DROP COLUMN IF EXISTS payment_account_name;
ALTER TABLE companies DROP COLUMN IF EXISTS payment_account_number;
ALTER TABLE companies DROP COLUMN IF EXISTS payment_routing_number;
ALTER TABLE companies DROP COLUMN IF EXISTS payment_swift;
ALTER TABLE companies DROP COLUMN IF EXISTS payment_instructions;
