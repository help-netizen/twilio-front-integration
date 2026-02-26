-- =============================================================================
-- Migration 036: Add check_deposited flag to zb_payments
-- =============================================================================

ALTER TABLE zb_payments ADD COLUMN IF NOT EXISTS check_deposited BOOLEAN DEFAULT false;
