-- =============================================================================
-- Migration 058: Create invoice_items table (PF003)
-- Line items for invoices
-- =============================================================================

CREATE TABLE IF NOT EXISTS invoice_items (
    id              BIGSERIAL PRIMARY KEY,
    invoice_id      BIGINT NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
    sort_order      INTEGER NOT NULL DEFAULT 0,
    name            TEXT NOT NULL,
    description     TEXT,
    quantity        NUMERIC(10,2) NOT NULL DEFAULT 1,
    unit            VARCHAR(20),
    unit_price      NUMERIC(12,2) NOT NULL DEFAULT 0,
    amount          NUMERIC(12,2) NOT NULL DEFAULT 0,
    taxable         BOOLEAN NOT NULL DEFAULT true,
    metadata        JSONB NOT NULL DEFAULT '{}',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_invoice_items_invoice ON invoice_items(invoice_id, sort_order);

CREATE TRIGGER trg_invoice_items_updated_at
    BEFORE UPDATE ON invoice_items
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

COMMENT ON TABLE invoice_items IS 'PF003: Line items for invoice documents';
