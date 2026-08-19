-- OB-69: preserve the source discount representation on invoices so fixed
-- and percentage discounts round-trip like estimates. discount_amount remains
-- the derived stored amount used by existing invoice total calculations.

ALTER TABLE invoices
    ADD COLUMN IF NOT EXISTS discount_type VARCHAR(20),
    ADD COLUMN IF NOT EXISTS discount_value NUMERIC(12,2);

UPDATE invoices
SET discount_type = COALESCE(
        discount_type,
        CASE WHEN discount_amount > 0 THEN 'fixed' ELSE NULL END
    ),
    discount_value = COALESCE(discount_value, discount_amount);

ALTER TABLE invoices
    DROP CONSTRAINT IF EXISTS invoices_discount_type_check;

ALTER TABLE invoices
    ADD CONSTRAINT invoices_discount_type_check
    CHECK (discount_type IS NULL OR discount_type IN ('fixed', 'percentage'));
