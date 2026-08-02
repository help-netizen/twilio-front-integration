-- =============================================================================
-- PAY-LEDGER-UNIFY-001: canonical /payments ledger support
-- =============================================================================

-- Preserve check-deposit decisions already made on the Zenbooker landing row.
-- An existing canonical decision always wins, making this backfill idempotent.
UPDATE payment_transactions pt
SET metadata = COALESCE(pt.metadata, '{}'::jsonb)
        || jsonb_build_object(
            'check_deposited', zp.check_deposited,
            'pay_ledger_unify_001_check_deposited_backfill', true
        ),
    updated_at = now()
FROM zb_payments zp
WHERE pt.company_id = zp.company_id
  AND pt.external_source = 'zenbooker'
  AND pt.external_id = zp.transaction_id
  AND NOT (COALESCE(pt.metadata, '{}'::jsonb) ? 'check_deposited');

-- Supports the canonical page's default date/id keyset walk.
CREATE INDEX IF NOT EXISTS idx_payment_tx_company_payment_date_cursor
    ON payment_transactions (
        company_id,
        COALESCE(processed_at, created_at) DESC,
        id DESC
    );

COMMENT ON INDEX idx_payment_tx_company_payment_date_cursor IS
    'PAY-LEDGER-UNIFY-001 canonical /payments date/id cursor';
