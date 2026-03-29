-- =============================================================================
-- Migration 063: Create document_delivery_attachments join table (PF002+PF003)
-- Links deliveries to their attached files
-- =============================================================================

CREATE TABLE IF NOT EXISTS document_delivery_attachments (
    delivery_id     BIGINT NOT NULL REFERENCES document_deliveries(id) ON DELETE CASCADE,
    attachment_id   BIGINT NOT NULL REFERENCES document_attachments(id) ON DELETE CASCADE,
    disposition     VARCHAR(20) NOT NULL DEFAULT 'attachment'
                    CHECK (disposition IN ('attachment','inline')),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (delivery_id, attachment_id)
);

CREATE INDEX IF NOT EXISTS idx_dda_attachment ON document_delivery_attachments(attachment_id);

COMMENT ON TABLE document_delivery_attachments IS 'PF002+PF003: Many-to-many link between deliveries and attachments';
