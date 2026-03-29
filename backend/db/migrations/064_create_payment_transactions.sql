-- =============================================================================
-- Migration 064: Create payment_transactions table (PF004)
-- Canonical payment ledger (separate from legacy zb_payments sync)
-- =============================================================================

CREATE TABLE IF NOT EXISTS payment_transactions (
    id                  BIGSERIAL PRIMARY KEY,
    company_id          UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    contact_id          BIGINT REFERENCES contacts(id) ON DELETE SET NULL,
    estimate_id         BIGINT REFERENCES estimates(id) ON DELETE SET NULL,
    invoice_id          BIGINT REFERENCES invoices(id) ON DELETE SET NULL,
    job_id              BIGINT REFERENCES jobs(id) ON DELETE SET NULL,
    transaction_type    VARCHAR(20) NOT NULL
                        CHECK (transaction_type IN ('payment','refund','adjustment')),
    payment_method      VARCHAR(30) NOT NULL
                        CHECK (payment_method IN ('credit_card','ach','check','cash','other','zenbooker_sync')),
    status              VARCHAR(20) NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending','processing','completed','failed','refunded','voided')),
    amount              NUMERIC(12,2) NOT NULL,
    currency            VARCHAR(3) NOT NULL DEFAULT 'USD',
    reference_number    VARCHAR(100),
    external_id         VARCHAR(255),
    external_source     VARCHAR(50),
    memo                TEXT,
    metadata            JSONB NOT NULL DEFAULT '{}',
    processed_at        TIMESTAMPTZ,
    recorded_by         UUID REFERENCES crm_users(id) ON DELETE SET NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_payment_tx_company_status ON payment_transactions(company_id, status);
CREATE INDEX IF NOT EXISTS idx_payment_tx_invoice ON payment_transactions(invoice_id) WHERE invoice_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_payment_tx_contact ON payment_transactions(contact_id) WHERE contact_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_payment_tx_external ON payment_transactions(external_id) WHERE external_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_payment_tx_created ON payment_transactions(created_at DESC);

CREATE TRIGGER trg_payment_transactions_updated_at
    BEFORE UPDATE ON payment_transactions
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

COMMENT ON TABLE payment_transactions IS 'PF004: Canonical payment ledger for all payment types';
