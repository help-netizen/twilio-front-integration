-- =============================================================================
-- Rollback 213: RECEIPT-REVIEW-001
-- =============================================================================

DROP INDEX IF EXISTS uq_payment_receipts_transaction_idempotency;

ALTER TABLE payment_receipts
    DROP COLUMN IF EXISTS provider_message_id,
    DROP COLUMN IF EXISTS idempotency_key;
