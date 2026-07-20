-- =============================================================================
-- Migration 193: PRICEBOOK-NESTED-001 — nested Price Book categories
--
-- Adds a company-scoped category tree (maximum three levels), preserves Workiz
-- Service/Product curation, and replaces the two legacy uniqueness rules that
-- conflict with nested category names and SKU-keyed imported items.
-- Existing row values are not modified. Replay-safe.
-- =============================================================================

ALTER TABLE price_book_categories
    ADD COLUMN IF NOT EXISTS parent_id BIGINT;

ALTER TABLE estimate_item_presets
    ADD COLUMN IF NOT EXISTS item_type TEXT;

-- A composite unique key is required by the same-company self-reference.
CREATE UNIQUE INDEX IF NOT EXISTS uq_price_book_categories_company_id_id
    ON price_book_categories (company_id, id);

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'fk_price_book_categories_parent_company'
          AND conrelid = 'price_book_categories'::regclass
    ) THEN
        ALTER TABLE price_book_categories
            ADD CONSTRAINT fk_price_book_categories_parent_company
            FOREIGN KEY (company_id, parent_id)
            REFERENCES price_book_categories (company_id, id)
            ON DELETE RESTRICT
            NOT VALID;
    END IF;
END $$;

ALTER TABLE price_book_categories
    VALIDATE CONSTRAINT fk_price_book_categories_parent_company;

-- PostgreSQL considers NULL values distinct in a normal unique index. Separate
-- root and child indexes therefore enforce both root and sibling uniqueness.
DROP INDEX IF EXISTS uq_price_book_categories_active_name;
CREATE UNIQUE INDEX IF NOT EXISTS uq_price_book_categories_active_root_name
    ON price_book_categories (company_id, lower(name))
    WHERE parent_id IS NULL AND archived_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_price_book_categories_active_sibling_name
    ON price_book_categories (company_id, parent_id, lower(name))
    WHERE parent_id IS NOT NULL AND archived_at IS NULL;

-- Imported names legitimately repeat after the "SKU - " prefix is removed.
-- Active nonblank SKU/code is the import identity; code-NULL legacy rows remain
-- unconstrained and byte-untouched.
DROP INDEX IF EXISTS uq_estimate_item_presets_active_name;
CREATE UNIQUE INDEX IF NOT EXISTS uq_estimate_item_presets_active_code
    ON estimate_item_presets (company_id, lower(btrim(code)))
    WHERE archived_at IS NULL AND code IS NOT NULL AND btrim(code) <> '';

CREATE OR REPLACE FUNCTION enforce_price_book_category_tree()
RETURNS TRIGGER AS $$
DECLARE
    parent_depth INTEGER := 0;
    subtree_height INTEGER := 1;
    reaches_self BOOLEAN := false;
BEGIN
    IF TG_OP = 'UPDATE' AND NEW.company_id IS DISTINCT FROM OLD.company_id THEN
        RAISE EXCEPTION 'price book category company_id is immutable'
            USING ERRCODE = '23514';
    END IF;

    -- Serialize structural writes within a company. The row locks below cover the
    -- common reparent race; this transaction lock also covers concurrent inserts.
    PERFORM pg_advisory_xact_lock(hashtextextended(NEW.company_id::text, 193));

    IF NEW.parent_id IS NOT NULL THEN
        IF NEW.parent_id = NEW.id THEN
            RAISE EXCEPTION 'price book category cannot be its own parent'
                USING ERRCODE = '23514';
        END IF;

        PERFORM id
        FROM price_book_categories
        WHERE company_id = NEW.company_id
          AND id IN (NEW.id, NEW.parent_id)
        ORDER BY id
        FOR UPDATE;

        WITH RECURSIVE ancestors AS (
            SELECT c.id, c.parent_id, 1 AS depth, ARRAY[c.id]::BIGINT[] AS path
            FROM price_book_categories c
            WHERE c.company_id = NEW.company_id AND c.id = NEW.parent_id
            UNION ALL
            SELECT c.id, c.parent_id, a.depth + 1, a.path || c.id
            FROM price_book_categories c
            JOIN ancestors a ON c.id = a.parent_id
            WHERE c.company_id = NEW.company_id
              AND NOT c.id = ANY(a.path)
        )
        SELECT COALESCE(max(depth), 0), COALESCE(bool_or(id = NEW.id), false)
        INTO parent_depth, reaches_self
        FROM ancestors;

        IF reaches_self THEN
            RAISE EXCEPTION 'price book category cycle is not allowed'
                USING ERRCODE = '23514';
        END IF;
    END IF;

    IF TG_OP = 'UPDATE' THEN
        WITH RECURSIVE descendants AS (
            SELECT c.id, 1 AS depth, ARRAY[c.id]::BIGINT[] AS path
            FROM price_book_categories c
            WHERE c.company_id = NEW.company_id AND c.id = NEW.id
            UNION ALL
            SELECT c.id, d.depth + 1, d.path || c.id
            FROM price_book_categories c
            JOIN descendants d ON c.parent_id = d.id
            WHERE c.company_id = NEW.company_id
              AND NOT c.id = ANY(d.path)
        )
        SELECT COALESCE(max(depth), 1)
        INTO subtree_height
        FROM descendants;
    END IF;

    IF parent_depth + subtree_height > 3 THEN
        RAISE EXCEPTION 'price book categories support at most three levels'
            USING ERRCODE = '23514';
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_price_book_categories_tree_guard ON price_book_categories;
CREATE TRIGGER trg_price_book_categories_tree_guard
    BEFORE INSERT OR UPDATE OF parent_id, company_id
    ON price_book_categories
    FOR EACH ROW EXECUTE FUNCTION enforce_price_book_category_tree();

CREATE INDEX IF NOT EXISTS idx_price_book_categories_parent
    ON price_book_categories (company_id, parent_id, archived_at, sort_order);
