-- =============================================================================
-- Migration 040: Add custom_fields column to zb_payments
-- Stores extracted custom form fields (e.g. claim_id) from Zenbooker job
-- =============================================================================

ALTER TABLE zb_payments ADD COLUMN IF NOT EXISTS custom_fields TEXT DEFAULT '';
