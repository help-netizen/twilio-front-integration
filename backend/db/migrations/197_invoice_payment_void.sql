-- =============================================================================
-- Migration 197: Void manual invoice payments (ESTINV-T3-VOID)
-- =============================================================================

ALTER TABLE payment_transactions
    ADD COLUMN IF NOT EXISTS voided_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS voided_by UUID REFERENCES crm_users(id) ON DELETE SET NULL;

COMMENT ON COLUMN payment_transactions.voided_at IS
    'When a manual/offline payment was voided; the ledger row remains visible.';
COMMENT ON COLUMN payment_transactions.voided_by IS
    'crm_users.id of the actor who voided the manual/offline payment.';

-- Older generic voids used status alone. Give those rows a stable visible
-- timestamp without changing their financial effect.
UPDATE payment_transactions
SET voided_at = COALESCE(updated_at, created_at)
WHERE status = 'voided'
  AND voided_at IS NULL;

-- PF003 originally recorded invoice offline payments only as invoice_events.
-- Move positive, user-recorded, non-external events into the canonical ledger
-- so historical offline payments can be listed and voided without deleting the
-- immutable invoice event trail. Stripe events are deliberately excluded.
INSERT INTO payment_transactions (
    company_id,
    contact_id,
    invoice_id,
    job_id,
    transaction_type,
    payment_method,
    status,
    amount,
    currency,
    reference_number,
    external_id,
    external_source,
    memo,
    metadata,
    processed_at,
    recorded_by,
    created_at,
    updated_at
)
SELECT
    i.company_id,
    i.contact_id,
    i.id,
    i.job_id,
    'payment',
    CASE LOWER(COALESCE(ie.metadata->>'payment_method', 'other'))
        WHEN 'card' THEN 'credit_card'
        WHEN 'credit_card' THEN 'credit_card'
        WHEN 'ach' THEN 'ach'
        WHEN 'check' THEN 'check'
        WHEN 'cash' THEN 'cash'
        ELSE 'other'
    END,
    'completed',
    (ie.metadata->>'amount')::NUMERIC(12,2),
    i.currency,
    NULLIF(ie.metadata->>'reference', ''),
    'invoice_event:' || ie.id::TEXT,
    'manual',
    'Manual invoice payment (migrated from invoice event)',
    ie.metadata || jsonb_build_object(
        'invoice_event_id', ie.id::TEXT,
        'backfilled_by', '197_invoice_payment_void'
    ),
    ie.created_at,
    cu.id,
    ie.created_at,
    ie.created_at
FROM invoice_events ie
JOIN invoices i
  ON i.id = ie.invoice_id
LEFT JOIN crm_users cu
  ON cu.id::TEXT = ie.actor_id
 AND cu.company_id = i.company_id
WHERE ie.event_type = 'payment_recorded'
  AND ie.actor_type = 'user'
  AND COALESCE(ie.metadata->>'source', '') = ''
  AND COALESCE(ie.metadata->>'refund', 'false') <> 'true'
  AND COALESCE(ie.metadata->>'amount', '') ~ '^[0-9]+([.][0-9]+)?$'
  AND (ie.metadata->>'amount')::NUMERIC > 0
  AND NOT EXISTS (
      SELECT 1
      FROM payment_transactions pt
      WHERE pt.company_id = i.company_id
        AND pt.external_source = 'manual'
        AND pt.external_id = 'invoice_event:' || ie.id::TEXT
  )
ON CONFLICT DO NOTHING;

CREATE UNIQUE INDEX IF NOT EXISTS uq_payment_tx_manual_invoice_event
    ON payment_transactions(company_id, external_id)
    WHERE external_source = 'manual'
      AND external_id LIKE 'invoice_event:%';
