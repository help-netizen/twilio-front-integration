-- Note attachments: files and images attached to notes on jobs, leads, contacts
CREATE TABLE IF NOT EXISTS note_attachments (
    id              BIGSERIAL PRIMARY KEY,
    company_id      UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    entity_type     VARCHAR(20) NOT NULL CHECK (entity_type IN ('job', 'lead', 'contact')),
    entity_id       BIGINT NOT NULL,
    note_index      INTEGER,
    file_name       VARCHAR(255) NOT NULL,
    content_type    VARCHAR(100),
    file_size       INTEGER,
    storage_key     TEXT NOT NULL,
    uploaded_by     UUID REFERENCES crm_users(id) ON DELETE SET NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_note_attachments_entity
    ON note_attachments(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_note_attachments_company
    ON note_attachments(company_id);
