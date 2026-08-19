ALTER TABLE invoices
    DROP CONSTRAINT IF EXISTS invoices_discount_type_check;

ALTER TABLE invoices
    DROP COLUMN IF EXISTS discount_value,
    DROP COLUMN IF EXISTS discount_type;
