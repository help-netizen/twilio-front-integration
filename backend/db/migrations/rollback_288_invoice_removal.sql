DROP TABLE IF EXISTS invoice_removals;

DROP INDEX IF EXISTS idx_payment_tx_company_origin_invoice;

ALTER TABLE payment_transactions
    DROP COLUMN IF EXISTS origin_invoice_id;
