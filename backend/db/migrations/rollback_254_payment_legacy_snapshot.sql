-- =============================================================================
-- Rollback PAY-DEZB-001 legacy presentation snapshot
-- =============================================================================

UPDATE payment_transactions
SET metadata = CASE
        WHEN metadata->'pay_dezb_001_snapshot'->>'had_legacy' = 'true' THEN
            jsonb_set(
                metadata - 'pay_dezb_001_snapshot',
                '{legacy}',
                metadata->'pay_dezb_001_snapshot'->'previous_legacy',
                true
            )
        ELSE metadata - 'pay_dezb_001_snapshot' - 'legacy'
    END,
    updated_at = now()
WHERE external_source = 'zenbooker'
  AND metadata ? 'pay_dezb_001_snapshot';

COMMENT ON COLUMN payment_transactions.metadata IS 'Canonical payment metadata';
