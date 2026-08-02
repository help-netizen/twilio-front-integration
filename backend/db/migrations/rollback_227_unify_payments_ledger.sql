-- =============================================================================
-- Rollback PAY-LEDGER-UNIFY-001
-- =============================================================================

DROP INDEX IF EXISTS idx_payment_tx_company_payment_date_cursor;

-- Remove only values introduced by migration 227. Canonical values that
-- predated the migration were never marked and remain untouched.
UPDATE payment_transactions
SET metadata = COALESCE(metadata, '{}'::jsonb)
        - 'check_deposited'
        - 'pay_ledger_unify_001_check_deposited_backfill',
    updated_at = now()
WHERE metadata->>'pay_ledger_unify_001_check_deposited_backfill' = 'true';
