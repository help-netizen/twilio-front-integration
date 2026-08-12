-- =============================================================================
-- PAY-DEZB-001: freeze imported payment presentation data on the canonical row
-- =============================================================================

WITH legacy_snapshots AS (
    SELECT
        pt.company_id,
        pt.id,
        jsonb_strip_nulls(jsonb_build_object(
            'invoice_id', zp.invoice_id,
            'job_id', zp.job_id,
            'local_job_id', fallback_job.id,
            'contact_id', fallback_job.contact_id,
            'canonical_job_id', fallback_job.id,
            'job_number', COALESCE(NULLIF(fallback_job.job_number, ''), zp.job_number),
            'client', COALESCE(NULLIF(fallback_job.customer_name, ''), zp.client),
            'job_type', COALESCE(NULLIF(fallback_job.service_name, ''), zp.job_type),
            'status', COALESCE(NULLIF(fallback_job.blanc_status, ''), zp.status),
            'payment_methods', zp.payment_methods,
            'display_payment_method', zp.display_payment_method,
            'source', COALESCE(NULLIF(fallback_job.job_source, ''), zp.source),
            'missing_job_link', CASE
                WHEN fallback_job.id IS NOT NULL THEN false
                ELSE zp.missing_job_link
            END,
            'invoice_status', zp.invoice_status,
            'invoice_total', zp.invoice_total,
            'invoice_amount_paid', zp.invoice_amount_paid,
            'invoice_amount_due', zp.invoice_amount_due,
            'invoice_paid_in_full', zp.invoice_paid_in_full,
            'tags', zp.tags,
            'assigned_techs', fallback_job.assigned_techs,
            'job_metadata', fallback_job.metadata,
            'invoice_detail', zp.invoice_detail,
            'job_detail', CASE
                WHEN fallback_job.id IS NOT NULL THEN jsonb_build_object(
                    'job_number', fallback_job.job_number,
                    'service_name', fallback_job.service_name,
                    'service_address', fallback_job.address,
                    'providers', COALESCE(fallback_job.assigned_techs, '[]'::jsonb)
                )
                ELSE zp.job_detail
            END,
            'metadata', COALESCE(zp.metadata, '{}'::jsonb)
        )) AS legacy
    FROM payment_transactions pt
    JOIN zb_payments zp
      ON zp.company_id = pt.company_id
     AND zp.transaction_id = pt.external_id
    LEFT JOIN jobs current_job
      ON current_job.company_id = pt.company_id
     AND current_job.id = pt.job_id
    LEFT JOIN jobs fallback_job
      ON fallback_job.company_id = pt.company_id
     AND current_job.id IS NULL
     AND fallback_job.zenbooker_job_id = NULLIF(pt.metadata->>'zb_job_id', '')
    WHERE pt.external_source = 'zenbooker'
      AND NOT (COALESCE(pt.metadata, '{}'::jsonb) ? 'pay_dezb_001_snapshot')
)
UPDATE payment_transactions pt
SET metadata = jsonb_set(
        COALESCE(pt.metadata, '{}'::jsonb)
            || jsonb_build_object(
                'pay_dezb_001_snapshot', jsonb_build_object(
                    'had_legacy', COALESCE(pt.metadata, '{}'::jsonb) ? 'legacy',
                    'previous_legacy', pt.metadata->'legacy'
                )
            ),
        '{legacy}',
        legacy_snapshots.legacy,
        true
    ),
    updated_at = now()
FROM legacy_snapshots
WHERE pt.company_id = legacy_snapshots.company_id
  AND pt.id = legacy_snapshots.id;

COMMENT ON COLUMN payment_transactions.metadata IS
    'Canonical payment metadata; metadata.legacy contains frozen PAY-DEZB-001 presentation snapshots for imported history';
