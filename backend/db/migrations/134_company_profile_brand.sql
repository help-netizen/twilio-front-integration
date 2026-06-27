-- ============================================================================
-- 134: COMPANY-PROFILE-001 — company branding + payment (ACH) details
--
-- Tenant-facing Company Profile becomes the brand source for invoice/estimate
-- PDFs. Adds an uploadable logo (storage key, mirrors technician_profiles) and
-- the payment/ACH fields overlaid onto document templates' `brand.ach`.
--
-- The company NAME, contact_email/phone, billing_email and address
-- (city/state/zip/lat/lng) already exist on `companies` — not re-added here.
--
-- Idempotent and additive (all nullable).
-- ============================================================================

ALTER TABLE companies ADD COLUMN IF NOT EXISTS logo_storage_key       TEXT;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS payment_bank_name      TEXT;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS payment_account_name   TEXT;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS payment_account_number TEXT;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS payment_routing_number TEXT;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS payment_swift          TEXT;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS payment_instructions   TEXT;
