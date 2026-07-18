-- =============================================================================
-- Rollback 182: restore the pre-ZBPAY-MIGRATE-001 payment method vocabulary.
-- Imported rows are collapsed back to the legacy Zenbooker source method before
-- the narrower CHECK is restored, so rollback cannot strand an invalid row.
-- =============================================================================

UPDATE payment_transactions
SET payment_method = 'zenbooker_sync',
    updated_at = NOW()
WHERE payment_method IN (
    'zb_card', 'zb_check', 'zb_cash', 'zb_ach',
    'zb_venmo', 'zb_zelle', 'zb_other'
);

ALTER TABLE payment_transactions
    DROP CONSTRAINT IF EXISTS payment_transactions_payment_method_check;

ALTER TABLE payment_transactions
    ADD CONSTRAINT payment_transactions_payment_method_check
    CHECK (payment_method IN ('credit_card','ach','check','cash','other','zenbooker_sync'));
