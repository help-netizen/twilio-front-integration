-- =============================================================================
-- 207: ORDER-LIST-001 — internal parts-to-order lists
-- =============================================================================

ALTER TABLE estimates
    ADD COLUMN IF NOT EXISTS order_list JSONB NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE invoices
    ADD COLUMN IF NOT EXISTS order_list JSONB NOT NULL DEFAULT '[]'::jsonb;

DO $$ BEGIN
    ALTER TABLE estimates
        ADD CONSTRAINT chk_estimates_order_list_array
        CHECK (jsonb_typeof(order_list) = 'array');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    ALTER TABLE invoices
        ADD CONSTRAINT chk_invoices_order_list_array
        CHECK (jsonb_typeof(order_list) = 'array');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

COMMENT ON COLUMN estimates.order_list IS
    'Internal-only parts to order; never expose on customer-facing surfaces';

COMMENT ON COLUMN invoices.order_list IS
    'Internal-only parts to order; never expose on customer-facing surfaces';
