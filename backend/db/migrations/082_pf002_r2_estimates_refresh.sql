-- =============================================================================
-- Migration 082: PF002-R2 Estimates Composer Refresh
-- Align estimates schema with the repair-focused composer and approved lifecycle.
-- =============================================================================

-- Canonical status is now "approved" rather than legacy "accepted".
ALTER TABLE estimates DROP CONSTRAINT IF EXISTS estimates_status_check;

UPDATE estimates
SET status = 'approved'
WHERE status IN ('accepted', 'converted');

ALTER TABLE estimates
    ADD CONSTRAINT estimates_status_check
    CHECK (status IN ('draft','sent','viewed','approved','declined'));

ALTER TABLE estimates
    ADD COLUMN IF NOT EXISTS summary TEXT,
    ADD COLUMN IF NOT EXISTS discount_type VARCHAR(20),
    ADD COLUMN IF NOT EXISTS discount_value NUMERIC(12,2) NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS estimate_sequence INTEGER NOT NULL DEFAULT 1,
    ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS archived_by UUID REFERENCES crm_users(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS approved_snapshot JSONB,
    ADD COLUMN IF NOT EXISTS signature_name TEXT,
    ADD COLUMN IF NOT EXISTS signature_consented_at TIMESTAMPTZ;

ALTER TABLE estimates
    ALTER COLUMN tax_rate TYPE NUMERIC(7,4);

ALTER TABLE invoices
    ALTER COLUMN tax_rate TYPE NUMERIC(7,4);

UPDATE estimates
SET
    discount_type = COALESCE(discount_type, CASE WHEN discount_amount > 0 THEN 'fixed' ELSE NULL END),
    discount_value = CASE
        WHEN discount_value IS NULL OR discount_value = 0 THEN COALESCE(discount_amount, 0)
        ELSE discount_value
    END;

ALTER TABLE estimates DROP CONSTRAINT IF EXISTS estimates_discount_type_check;
ALTER TABLE estimates
    ADD CONSTRAINT estimates_discount_type_check
    CHECK (discount_type IS NULL OR discount_type IN ('fixed','percentage'));

ALTER TABLE estimates DROP CONSTRAINT IF EXISTS estimates_estimate_sequence_check;
ALTER TABLE estimates
    ADD CONSTRAINT estimates_estimate_sequence_check
    CHECK (estimate_sequence > 0);

CREATE INDEX IF NOT EXISTS idx_estimates_company_archived ON estimates(company_id, archived_at);
CREATE INDEX IF NOT EXISTS idx_estimates_company_job_sequence ON estimates(company_id, job_id, estimate_sequence) WHERE job_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_estimates_company_lead_sequence ON estimates(company_id, lead_id, estimate_sequence) WHERE lead_id IS NOT NULL;

ALTER TABLE estimate_items
    ADD COLUMN IF NOT EXISTS item_type TEXT,
    ADD COLUMN IF NOT EXISTS category_id BIGINT,
    ADD COLUMN IF NOT EXISTS price_book_item_id BIGINT;

ALTER TABLE estimate_items DROP CONSTRAINT IF EXISTS estimate_items_quantity_positive_check;
ALTER TABLE estimate_items
    ADD CONSTRAINT estimate_items_quantity_positive_check
    CHECK (quantity > 0);

ALTER TABLE estimate_items DROP CONSTRAINT IF EXISTS estimate_items_unit_price_nonnegative_check;
ALTER TABLE estimate_items
    ADD CONSTRAINT estimate_items_unit_price_nonnegative_check
    CHECK (unit_price >= 0);
