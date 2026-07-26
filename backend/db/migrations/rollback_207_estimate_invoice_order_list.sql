-- =============================================================================
-- Rollback 207: ORDER-LIST-001
-- =============================================================================

ALTER TABLE invoices
    DROP CONSTRAINT IF EXISTS chk_invoices_order_list_array,
    DROP COLUMN IF EXISTS order_list;

ALTER TABLE estimates
    DROP CONSTRAINT IF EXISTS chk_estimates_order_list_array,
    DROP COLUMN IF EXISTS order_list;
