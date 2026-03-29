-- =============================================================================
-- Migration 054: Create estimate_items table (PF002)
-- Line items for estimates
-- =============================================================================

CREATE TABLE IF NOT EXISTS estimate_items (
    id              BIGSERIAL PRIMARY KEY,
    estimate_id     BIGINT NOT NULL REFERENCES estimates(id) ON DELETE CASCADE,
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

CREATE INDEX IF NOT EXISTS idx_estimate_items_estimate ON estimate_items(estimate_id, sort_order);

CREATE TRIGGER trg_estimate_items_updated_at
    BEFORE UPDATE ON estimate_items
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

COMMENT ON TABLE estimate_items IS 'PF002: Line items for estimate documents';
