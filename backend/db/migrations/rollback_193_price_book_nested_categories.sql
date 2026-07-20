-- Rollback 193: PRICEBOOK-NESTED-001.
-- Refuses lossy rollback once nested/imported feature data exists.

DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'price_book_categories' AND column_name = 'parent_id'
    ) THEN
        IF EXISTS (SELECT 1 FROM price_book_categories WHERE parent_id IS NOT NULL) THEN
            RAISE EXCEPTION 'cannot rollback 193 while nested categories exist';
        END IF;
    END IF;

    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'estimate_item_presets' AND column_name = 'item_type'
    ) THEN
        IF EXISTS (SELECT 1 FROM estimate_item_presets WHERE item_type IS NOT NULL) THEN
            RAISE EXCEPTION 'cannot rollback 193 while imported item_type data exists';
        END IF;
    END IF;

    IF EXISTS (
        SELECT 1
        FROM estimate_item_presets
        WHERE archived_at IS NULL
        GROUP BY company_id, lower(name)
        HAVING count(*) > 1
    ) THEN
        RAISE EXCEPTION 'cannot rollback 193 while duplicate active item names exist';
    END IF;
END $$;

DROP TRIGGER IF EXISTS trg_price_book_categories_tree_guard ON price_book_categories;
DROP FUNCTION IF EXISTS enforce_price_book_category_tree();

ALTER TABLE price_book_categories
    DROP CONSTRAINT IF EXISTS fk_price_book_categories_parent_company;

DROP INDEX IF EXISTS idx_price_book_categories_parent;
DROP INDEX IF EXISTS uq_price_book_categories_active_root_name;
DROP INDEX IF EXISTS uq_price_book_categories_active_sibling_name;
DROP INDEX IF EXISTS uq_price_book_categories_company_id_id;
DROP INDEX IF EXISTS uq_estimate_item_presets_active_code;

CREATE UNIQUE INDEX IF NOT EXISTS uq_price_book_categories_active_name
    ON price_book_categories (company_id, lower(name))
    WHERE archived_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_estimate_item_presets_active_name
    ON estimate_item_presets (company_id, lower(name))
    WHERE archived_at IS NULL;

ALTER TABLE price_book_categories
    DROP COLUMN IF EXISTS parent_id;
ALTER TABLE estimate_item_presets
    DROP COLUMN IF EXISTS item_type;
