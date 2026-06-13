-- ============================================================================
-- 104: Debt #6 — consolidate zb_payments into the canonical payment_transactions
-- ledger. Zenbooker is the master payment system, so its rows are authoritative
-- (external_source='zenbooker', payment_method='zenbooker_sync'). zb_payments is
-- kept as the Zenbooker landing/staging cache (the payments UI reads its
-- denormalised display fields) — this migration only projects it into the ledger.
--
-- Safe by construction: on prod payment_transactions is empty and no job has both
-- a native and a Zenbooker payment, so this is a clean one-directional backfill.
-- Idempotent via the partial unique index below. Does NOT touch fact_payments or
-- the marts (those are fed by the external /pulse ETL).
-- ============================================================================

-- Idempotent upsert target + Zenbooker-priority conflict key.
CREATE UNIQUE INDEX IF NOT EXISTS uq_payment_tx_external_zb
    ON payment_transactions (company_id, external_id)
    WHERE external_source = 'zenbooker';

-- Backfill existing Zenbooker payments into the ledger.
INSERT INTO payment_transactions (
    company_id, job_id, transaction_type, payment_method, status,
    amount, currency, reference_number, external_id, external_source,
    memo, metadata, processed_at, created_at, updated_at
)
SELECT
    zp.company_id,
    j.id AS job_id,                              -- NULL when the ZB job isn't linked locally
    'payment',
    'zenbooker_sync',
    CASE zp.transaction_status
        WHEN 'succeeded' THEN 'completed'
        WHEN 'failed'    THEN 'failed'
        WHEN 'voided'    THEN 'voided'
        ELSE 'pending'
    END,
    COALESCE(zp.amount_paid, 0),
    'USD',
    NULLIF(zp.invoice_id, ''),
    zp.transaction_id,
    'zenbooker',
    NULLIF(zp.client, '—'),
    jsonb_build_object(
        'zb_job_id', zp.job_id,
        'job_number', zp.job_number,
        'job_type', zp.job_type,
        'display_payment_method', zp.display_payment_method,
        'invoice_status', zp.invoice_status,
        'source', 'zb_payments_backfill_104'
    ),
    zp.payment_date,
    zp.created_at,
    now()
FROM zb_payments zp
LEFT JOIN jobs j ON j.zenbooker_job_id = zp.job_id AND j.company_id = zp.company_id
ON CONFLICT (company_id, external_id) WHERE external_source = 'zenbooker'
DO UPDATE SET
    job_id        = EXCLUDED.job_id,
    status        = EXCLUDED.status,
    amount        = EXCLUDED.amount,
    payment_method = EXCLUDED.payment_method,
    memo          = EXCLUDED.memo,
    metadata      = EXCLUDED.metadata,
    processed_at  = EXCLUDED.processed_at,
    updated_at    = now();

COMMENT ON INDEX uq_payment_tx_external_zb IS
    'Debt #6: one ledger row per Zenbooker transaction per company (idempotent backfill + write-through).';
