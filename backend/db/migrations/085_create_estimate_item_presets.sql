-- =============================================================================
-- Migration 085: Estimate item presets (Price Book lite)
--
-- Per-company catalog of reusable item templates that auto-populate the
-- EstimateDetailPanel item search. Each preset stores default name/desc/qty/
-- unit_price/taxable; usage_count + last_used_at drive the "Recent / часто
-- используемые" suggestion order.
-- =============================================================================

CREATE TABLE IF NOT EXISTS estimate_item_presets (
    id                  BIGSERIAL PRIMARY KEY,
    company_id          UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    name                TEXT NOT NULL,
    description         TEXT,
    default_quantity    NUMERIC(10,2) NOT NULL DEFAULT 1 CHECK (default_quantity > 0),
    default_unit_price  NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (default_unit_price >= 0),
    default_taxable     BOOLEAN NOT NULL DEFAULT false,
    usage_count         INTEGER NOT NULL DEFAULT 0,
    last_used_at        TIMESTAMPTZ,
    created_by          UUID REFERENCES crm_users(id) ON DELETE SET NULL,
    archived_at         TIMESTAMPTZ,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Active presets are unique by (company, lower(name)) — prevents catalog duplicates.
CREATE UNIQUE INDEX IF NOT EXISTS uq_estimate_item_presets_active_name
    ON estimate_item_presets (company_id, lower(name))
    WHERE archived_at IS NULL;

-- Suggestion list / search ordering: most-used first, then recent.
CREATE INDEX IF NOT EXISTS idx_estimate_item_presets_lookup
    ON estimate_item_presets (company_id, archived_at, usage_count DESC, last_used_at DESC NULLS LAST);

-- (Trigram search index intentionally omitted — `pg_trgm` may not be available.
-- Substring search uses ILIKE on the (company_id, archived_at) index above.)

DROP TRIGGER IF EXISTS trg_estimate_item_presets_updated_at ON estimate_item_presets;
CREATE TRIGGER trg_estimate_item_presets_updated_at BEFORE UPDATE ON estimate_item_presets
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
