-- =============================================================================
-- Migration 061: Create document_deliveries table (PF002+PF003 shared)
-- Tracks delivery of estimates/invoices via email, SMS, portal link
-- =============================================================================

CREATE TABLE IF NOT EXISTS document_deliveries (
    id              BIGSERIAL PRIMARY KEY,
    company_id      UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    document_type   VARCHAR(20) NOT NULL CHECK (document_type IN ('estimate','invoice')),
    document_id     BIGINT NOT NULL,
    delivery_method VARCHAR(20) NOT NULL CHECK (delivery_method IN ('email','sms','portal_link','manual')),
    recipient_email VARCHAR(255),
    recipient_phone VARCHAR(30),
    subject         TEXT,
    body            TEXT,
    status          VARCHAR(20) NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','sent','delivered','failed','bounced')),
    provider_message_id VARCHAR(255),
    portal_token_id UUID,
    sent_at         TIMESTAMPTZ,
    delivered_at    TIMESTAMPTZ,
    failed_at       TIMESTAMPTZ,
    failure_reason  TEXT,
    sent_by         UUID REFERENCES crm_users(id) ON DELETE SET NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_document_deliveries_company ON document_deliveries(company_id);
CREATE INDEX IF NOT EXISTS idx_document_deliveries_document ON document_deliveries(document_type, document_id);
CREATE INDEX IF NOT EXISTS idx_document_deliveries_status ON document_deliveries(status) WHERE status IN ('pending','sent');

CREATE TRIGGER trg_document_deliveries_updated_at
    BEFORE UPDATE ON document_deliveries
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

COMMENT ON TABLE document_deliveries IS 'PF002+PF003: Shared delivery tracking for estimate/invoice documents';
