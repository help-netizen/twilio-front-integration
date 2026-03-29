-- =============================================================================
-- Migration 059: Create invoice_revisions table (PF003)
-- Snapshot history for invoice changes
-- =============================================================================

CREATE TABLE IF NOT EXISTS invoice_revisions (
    id              BIGSERIAL PRIMARY KEY,
    invoice_id      BIGINT NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
    revision_number INTEGER NOT NULL,
    snapshot        JSONB NOT NULL,
    created_by      UUID REFERENCES crm_users(id) ON DELETE SET NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_invoice_revision UNIQUE (invoice_id, revision_number)
);

CREATE INDEX IF NOT EXISTS idx_invoice_revisions_invoice ON invoice_revisions(invoice_id);

COMMENT ON TABLE invoice_revisions IS 'PF003: Immutable revision snapshots for invoices';
