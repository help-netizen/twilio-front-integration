-- =============================================================================
-- Migration 035: Create zb_payments table (local cache of Zenbooker transactions)
-- =============================================================================

CREATE TABLE IF NOT EXISTS zb_payments (
    id                      BIGSERIAL PRIMARY KEY,
    company_id              UUID NOT NULL REFERENCES companies(id),
    transaction_id          TEXT NOT NULL,

    -- Invoice / Job references (Zenbooker IDs)
    invoice_id              TEXT,
    job_id                  TEXT,

    -- Flattened row fields (pre-assembled for fast list queries)
    job_number              TEXT DEFAULT '—',
    client                  TEXT DEFAULT '—',
    job_type                TEXT DEFAULT '—',
    status                  TEXT DEFAULT '—',
    payment_methods         TEXT DEFAULT '',
    display_payment_method  TEXT DEFAULT '',
    amount_paid             NUMERIC(12,2) DEFAULT 0,
    tags                    TEXT DEFAULT '',
    payment_date            TIMESTAMPTZ,
    source                  TEXT DEFAULT '',
    tech                    TEXT DEFAULT '—',
    transaction_status      TEXT DEFAULT '',
    missing_job_link        BOOLEAN DEFAULT false,

    -- Invoice summary
    invoice_status          TEXT,
    invoice_total           NUMERIC(12,2),
    invoice_amount_paid     NUMERIC(12,2),
    invoice_amount_due      NUMERIC(12,2),
    invoice_paid_in_full    BOOLEAN DEFAULT false,

    -- Detail data (JSONB for GET /:id)
    job_detail              JSONB DEFAULT 'null'::jsonb,
    invoice_detail          JSONB DEFAULT 'null'::jsonb,
    attachments             JSONB DEFAULT '[]'::jsonb,
    metadata                JSONB DEFAULT '{}'::jsonb,

    -- Raw payloads for debugging
    zb_raw_transaction      JSONB DEFAULT '{}'::jsonb,
    zb_raw_invoice          JSONB DEFAULT 'null'::jsonb,
    zb_raw_job              JSONB DEFAULT 'null'::jsonb,

    created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- Unique constraint: one transaction per company
    CONSTRAINT uq_zb_payments_company_txn UNIQUE (company_id, transaction_id)
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_zb_payments_company_id ON zb_payments(company_id);
CREATE INDEX IF NOT EXISTS idx_zb_payments_payment_date ON zb_payments(payment_date DESC);
CREATE INDEX IF NOT EXISTS idx_zb_payments_transaction_id ON zb_payments(transaction_id);
CREATE INDEX IF NOT EXISTS idx_zb_payments_company_date ON zb_payments(company_id, payment_date DESC);

-- Auto-update trigger
CREATE TRIGGER trg_zb_payments_updated_at BEFORE UPDATE ON zb_payments
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

COMMENT ON TABLE zb_payments IS 'Local cache of Zenbooker transactions with pre-assembled row data';
