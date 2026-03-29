-- =============================================================================
-- Migration 053: Create estimates table (PF002)
-- Client-facing document for quoting work
-- =============================================================================

CREATE TABLE IF NOT EXISTS estimates (
    id              BIGSERIAL PRIMARY KEY,
    company_id      UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    estimate_number VARCHAR(50) NOT NULL,
    status          VARCHAR(30) NOT NULL DEFAULT 'draft'
                    CHECK (status IN ('draft','sent','viewed','accepted','declined','expired','converted')),
    contact_id      BIGINT REFERENCES contacts(id) ON DELETE SET NULL,
    lead_id         BIGINT REFERENCES leads(id) ON DELETE SET NULL,
    job_id          BIGINT REFERENCES jobs(id) ON DELETE SET NULL,
    title           TEXT,
    notes           TEXT,
    internal_note   TEXT,
    subtotal        NUMERIC(12,2) NOT NULL DEFAULT 0,
    tax_rate        NUMERIC(5,4) NOT NULL DEFAULT 0,
    tax_amount      NUMERIC(12,2) NOT NULL DEFAULT 0,
    discount_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
    total           NUMERIC(12,2) NOT NULL DEFAULT 0,
    currency        VARCHAR(3) NOT NULL DEFAULT 'USD',
    deposit_required BOOLEAN NOT NULL DEFAULT false,
    deposit_type    VARCHAR(20) CHECK (deposit_type IN ('fixed','percentage')),
    deposit_value   NUMERIC(12,2),
    deposit_paid    NUMERIC(12,2) NOT NULL DEFAULT 0,
    signature_required BOOLEAN NOT NULL DEFAULT false,
    signed_at       TIMESTAMPTZ,
    valid_until     TIMESTAMPTZ,
    sent_at         TIMESTAMPTZ,
    accepted_at     TIMESTAMPTZ,
    declined_at     TIMESTAMPTZ,
    created_by      UUID REFERENCES crm_users(id) ON DELETE SET NULL,
    updated_by      UUID REFERENCES crm_users(id) ON DELETE SET NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_estimates_number_company UNIQUE (company_id, estimate_number)
);

CREATE INDEX IF NOT EXISTS idx_estimates_company_status ON estimates(company_id, status);
CREATE INDEX IF NOT EXISTS idx_estimates_contact ON estimates(contact_id) WHERE contact_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_estimates_lead ON estimates(lead_id) WHERE lead_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_estimates_job ON estimates(job_id) WHERE job_id IS NOT NULL;

CREATE TRIGGER trg_estimates_updated_at
    BEFORE UPDATE ON estimates
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

COMMENT ON TABLE estimates IS 'PF002: Client-facing estimate/quote documents';
