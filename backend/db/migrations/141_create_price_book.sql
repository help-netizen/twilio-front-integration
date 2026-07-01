-- =============================================================================
-- Migration 141: PRICEBOOK-001 — Price Book (Category → Group → Item)
--
-- Evolves the flat `estimate_item_presets` catalog into a 3-level Price Book for
-- estimates & invoices:
--   • Category — top-level grouping only (never added to a document).
--   • Group    — a named set of Items with a per-item quantity; selecting a group
--                in a doc expands into its Items as line items (group itself absent).
--   • Item     — `estimate_item_presets` (extended here); can be added standalone
--                or as part of a group. Group↔Item is many-to-many.
-- Idempotent (IF NOT EXISTS / ON CONFLICT).
-- =============================================================================

-- ── Categories ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS price_book_categories (
    id           BIGSERIAL PRIMARY KEY,
    company_id   UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    name         TEXT NOT NULL,
    description  TEXT,
    sort_order   INTEGER NOT NULL DEFAULT 0,
    archived_at  TIMESTAMPTZ,
    created_by   UUID REFERENCES crm_users(id) ON DELETE SET NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_price_book_categories_active_name
    ON price_book_categories (company_id, lower(name)) WHERE archived_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_price_book_categories_company
    ON price_book_categories (company_id, archived_at, sort_order);
DROP TRIGGER IF EXISTS trg_price_book_categories_updated_at ON price_book_categories;
CREATE TRIGGER trg_price_book_categories_updated_at BEFORE UPDATE ON price_book_categories
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ── Groups ───────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS price_book_groups (
    id           BIGSERIAL PRIMARY KEY,
    company_id   UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    category_id  BIGINT REFERENCES price_book_categories(id) ON DELETE SET NULL,
    name         TEXT NOT NULL,
    description  TEXT,
    sort_order   INTEGER NOT NULL DEFAULT 0,
    archived_at  TIMESTAMPTZ,
    created_by   UUID REFERENCES crm_users(id) ON DELETE SET NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_price_book_groups_active_name
    ON price_book_groups (company_id, lower(name)) WHERE archived_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_price_book_groups_company
    ON price_book_groups (company_id, archived_at, sort_order);
CREATE INDEX IF NOT EXISTS idx_price_book_groups_category ON price_book_groups (category_id);
DROP TRIGGER IF EXISTS trg_price_book_groups_updated_at ON price_book_groups;
CREATE TRIGGER trg_price_book_groups_updated_at BEFORE UPDATE ON price_book_groups
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ── Items = extend estimate_item_presets (preserves all existing data) ───────
ALTER TABLE estimate_item_presets
    ADD COLUMN IF NOT EXISTS category_id BIGINT REFERENCES price_book_categories(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS code        TEXT,
    ADD COLUMN IF NOT EXISTS unit        VARCHAR(20);
CREATE INDEX IF NOT EXISTS idx_estimate_item_presets_category
    ON estimate_item_presets (category_id);

-- ── Group ↔ Item membership (M2M; quantity + order live on the link) ─────────
CREATE TABLE IF NOT EXISTS price_book_group_items (
    id           BIGSERIAL PRIMARY KEY,
    company_id   UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    group_id     BIGINT NOT NULL REFERENCES price_book_groups(id) ON DELETE CASCADE,
    item_id      BIGINT NOT NULL REFERENCES estimate_item_presets(id) ON DELETE CASCADE,
    quantity     NUMERIC(10,2) NOT NULL DEFAULT 1 CHECK (quantity > 0),
    sort_order   INTEGER NOT NULL DEFAULT 0,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_price_book_group_items
    ON price_book_group_items (group_id, item_id);
CREATE INDEX IF NOT EXISTS idx_price_book_group_items_group
    ON price_book_group_items (group_id, sort_order);

-- ── Permissions: price_book.view (all roles that edit docs) + .manage (admin/mgr)
-- Backfill for EXISTING companies (050 covers new companies via onboarding bootstrap).
-- Idempotent — ON CONFLICT no-op. Mirrors migration 138.
INSERT INTO company_role_permissions (role_config_id, permission_key, is_allowed)
SELECT rc.id, p.key, true
FROM company_role_configs rc
CROSS JOIN (VALUES ('price_book.view'), ('price_book.manage')) AS p(key)
WHERE rc.role_key IN ('tenant_admin', 'manager')
ON CONFLICT (role_config_id, permission_key) DO NOTHING;

INSERT INTO company_role_permissions (role_config_id, permission_key, is_allowed)
SELECT rc.id, p.key, true
FROM company_role_configs rc
CROSS JOIN (VALUES ('price_book.view')) AS p(key)
WHERE rc.role_key IN ('dispatcher', 'provider')
ON CONFLICT (role_config_id, permission_key) DO NOTHING;
