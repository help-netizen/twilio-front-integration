-- =============================================================================
-- 211: TXN-STATUS-VOID-001 — persist manual payment void reasons
-- =============================================================================

ALTER TABLE payment_transactions
    ADD COLUMN IF NOT EXISTS void_reason TEXT;

COMMENT ON COLUMN payment_transactions.void_reason IS
    'Trimmed operator reason for voiding a manual/offline payment; null on historical rows.';
