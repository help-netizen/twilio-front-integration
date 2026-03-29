-- =============================================================================
-- Migration 062: Create document_attachments table (PF002+PF003 shared)
-- File storage references for estimate/invoice PDFs and attachments
-- =============================================================================

CREATE TABLE IF NOT EXISTS document_attachments (
    id              BIGSERIAL PRIMARY KEY,
    company_id      UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    document_type   VARCHAR(20) NOT NULL CHECK (document_type IN ('estimate','invoice')),
    document_id     BIGINT NOT NULL,
    attachment_kind VARCHAR(30) NOT NULL DEFAULT 'pdf'
                    CHECK (attachment_kind IN ('pdf','generated_pdf','photo','signature','other')),
    revision_number INTEGER,
    file_name       VARCHAR(255) NOT NULL,
    content_type    VARCHAR(100),
    file_size       INTEGER,
    storage_key     TEXT NOT NULL,
    checksum_sha256 VARCHAR(64),
    uploaded_by     UUID REFERENCES crm_users(id) ON DELETE SET NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_document_attachments_document ON document_attachments(document_type, document_id);
CREATE INDEX IF NOT EXISTS idx_document_attachments_company ON document_attachments(company_id);

COMMENT ON TABLE document_attachments IS 'PF002+PF003: Shared file storage references for document PDFs and attachments';
