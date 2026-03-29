-- =============================================================================
-- Migration 065: Create payment_receipts table (PF004)
-- Receipt tracking for payment transactions
-- =============================================================================

CREATE TABLE IF NOT EXISTS payment_receipts (
    id              BIGSERIAL PRIMARY KEY,
    transaction_id  BIGINT NOT NULL REFERENCES payment_transactions(id) ON DELETE CASCADE,
    receipt_number  VARCHAR(50) NOT NULL,
    sent_to_email   VARCHAR(255),
    sent_to_phone   VARCHAR(30),
    sent_via        VARCHAR(20) CHECK (sent_via IN ('email','sms','portal')),
    pdf_storage_key TEXT,
    sent_at         TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_payment_receipts_transaction ON payment_receipts(transaction_id);

COMMENT ON TABLE payment_receipts IS 'PF004: Receipt tracking for payment transactions';
