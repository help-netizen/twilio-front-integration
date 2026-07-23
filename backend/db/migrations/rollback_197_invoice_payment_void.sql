-- Rollback migration 197 (ESTINV-T3-VOID).

DROP INDEX IF EXISTS uq_payment_tx_manual_invoice_event;

DELETE FROM payment_transactions
WHERE metadata->>'backfilled_by' = '197_invoice_payment_void';

ALTER TABLE payment_transactions
    DROP COLUMN IF EXISTS voided_by,
    DROP COLUMN IF EXISTS voided_at;
