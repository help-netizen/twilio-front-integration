-- =============================================================================
-- Migration 057: Create invoices table (PF003)
-- Client-facing invoice documents
-- =============================================================================

CREATE TABLE IF NOT EXISTS invoices (
    id              BIGSERIAL PRIMARY KEY,
    company_id      UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    invoice_number  VARCHAR(50) NOT NULL,
    status          VARCHAR(30) NOT NULL DEFAULT 'draft'
                    CHECK (status IN ('draft','sent','viewed','partial','paid','overdue','void','refunded')),
    contact_id      BIGINT REFERENCES contacts(id) ON DELETE SET NULL,
    lead_id         BIGINT REFERENCES leads(id) ON DELETE SET NULL,
    job_id          BIGINT REFERENCES jobs(id) ON DELETE SET NULL,
    estimate_id     BIGINT REFERENCES estimates(id) ON DELETE SET NULL,
    title           TEXT,
    notes           TEXT,
    internal_note   TEXT,
    subtotal        NUMERIC(12,2) NOT NULL DEFAULT 0,
    tax_rate        NUMERIC(5,4) NOT NULL DEFAULT 0,
    tax_amount      NUMERIC(12,2) NOT NULL DEFAULT 0,
    discount_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
    total           NUMERIC(12,2) NOT NULL DEFAULT 0,
    amount_paid     NUMERIC(12,2) NOT NULL DEFAULT 0,
    balance_due     NUMERIC(12,2) NOT NULL DEFAULT 0,
    currency        VARCHAR(3) NOT NULL DEFAULT 'USD',
    payment_terms   VARCHAR(30),
    due_date        TIMESTAMPTZ,
    sent_at         TIMESTAMPTZ,
    paid_at         TIMESTAMPTZ,
    voided_at       TIMESTAMPTZ,
    created_by      UUID REFERENCES crm_users(id) ON DELETE SET NULL,
    updated_by      UUID REFERENCES crm_users(id) ON DELETE SET NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_invoices_number_company UNIQUE (company_id, invoice_number)
);

CREATE INDEX IF NOT EXISTS idx_invoices_company_status ON invoices(company_id, status);
CREATE INDEX IF NOT EXISTS idx_invoices_contact ON invoices(contact_id) WHERE contact_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_invoices_lead ON invoices(lead_id) WHERE lead_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_invoices_job ON invoices(job_id) WHERE job_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_invoices_estimate ON invoices(estimate_id) WHERE estimate_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_invoices_due_date ON invoices(due_date) WHERE status IN ('sent','viewed','partial','overdue');

CREATE TRIGGER trg_invoices_updated_at
    BEFORE UPDATE ON invoices
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

COMMENT ON TABLE invoices IS 'PF003: Client-facing invoice documents';
