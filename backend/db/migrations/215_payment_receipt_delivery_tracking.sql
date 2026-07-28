-- =============================================================================
-- 213: RECEIPT-REVIEW-001 — receipt delivery idempotency and provider tracking
-- =============================================================================

ALTER TABLE payment_receipts
    ADD COLUMN IF NOT EXISTS idempotency_key TEXT,
    ADD COLUMN IF NOT EXISTS provider_message_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS uq_payment_receipts_transaction_idempotency
    ON payment_receipts (transaction_id, idempotency_key)
    WHERE idempotency_key IS NOT NULL;

COMMENT ON COLUMN payment_receipts.idempotency_key IS
    'Caller-supplied or server-generated key used to suppress duplicate receipt email sends.';

COMMENT ON COLUMN payment_receipts.provider_message_id IS
    'Gmail provider message id written after the receipt email is accepted.';
