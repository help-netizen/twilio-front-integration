-- =============================================================================
-- Rollback 211: TXN-STATUS-VOID-001
-- =============================================================================

ALTER TABLE payment_transactions
    DROP COLUMN IF EXISTS void_reason;
