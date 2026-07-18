-- =============================================================================
-- Migration 182: Zenbooker-specific canonical payment methods
-- ZBPAY-MIGRATE-001 P1
--
-- Keep legacy zenbooker_sync during the rolling migration. The idempotent
-- projector retypes existing source rows to zb_* on the next payment sync.
-- =============================================================================

ALTER TABLE payment_transactions
    DROP CONSTRAINT IF EXISTS payment_transactions_payment_method_check;

ALTER TABLE payment_transactions
    ADD CONSTRAINT payment_transactions_payment_method_check
    CHECK (payment_method IN (
        'credit_card', 'ach', 'check', 'cash', 'other', 'zenbooker_sync',
        'zb_card', 'zb_check', 'zb_cash', 'zb_ach',
        'zb_venmo', 'zb_zelle', 'zb_other'
    ));

COMMENT ON CONSTRAINT payment_transactions_payment_method_check ON payment_transactions IS
    'Canonical native methods plus source-distinct Zenbooker mirror methods (ZBPAY-MIGRATE-001)';
