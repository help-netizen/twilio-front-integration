    SELECT
        t.company_id,
        t.id,
        COALESCE(t.external_id, t.id::text) AS transaction_id,
        CASE
            WHEN t.external_source = 'zenbooker'
                THEN COALESCE(NULLIF(zp.invoice_id, ''), NULLIF(t.reference_number, ''), '')
            ELSE COALESCE(t.invoice_id::text, '')
        END AS invoice_id,
        CASE
            WHEN t.external_source = 'zenbooker'
                THEN COALESCE(NULLIF(t.metadata->>'zb_job_id', ''), NULLIF(zp.job_id, ''), '')
            ELSE COALESCE(COALESCE(t.job_id, i.job_id)::text, '')
        END AS job_id,
        COALESCE(local_job.id, zb_job.id) AS local_job_id,
        COALESCE(t.contact_id, i.contact_id, local_job.contact_id, zb_job.contact_id) AS contact_id,
        t.invoice_id AS canonical_invoice_id,
        COALESCE(t.job_id, i.job_id, local_job.id, zb_job.id) AS canonical_job_id,
        COALESCE(NULLIF(local_job.job_number, ''), NULLIF(zb_job.job_number, ''),
                 NULLIF(zp.job_number, ''), NULLIF(t.metadata->>'job_number', ''), '—') AS job_number,
        COALESCE(NULLIF(c.full_name, ''), NULLIF(local_job.customer_name, ''),
                 NULLIF(zb_job.customer_name, ''), NULLIF(zp.client, ''),
                 CASE WHEN t.external_source = 'zenbooker' THEN NULLIF(t.memo, '') END, '—') AS client,
        COALESCE(NULLIF(local_job.service_name, ''), NULLIF(zb_job.service_name, ''),
                 NULLIF(zp.job_type, ''), NULLIF(t.metadata->>'job_type', ''), '—') AS job_type,
        COALESCE(NULLIF(local_job.blanc_status, ''), NULLIF(zb_job.blanc_status, ''),
                 NULLIF(zp.status, ''), '—') AS status,
        t.transaction_type,
        t.payment_method,
        CASE
            WHEN t.external_source = 'zenbooker' AND NULLIF(zp.payment_methods, '') IS NOT NULL
                THEN zp.payment_methods
            WHEN t.payment_method IN ('credit_card', 'zb_card') THEN 'card'
            WHEN t.payment_method IN ('check', 'zb_check') THEN 'check'
            WHEN t.payment_method IN ('cash', 'zb_cash') THEN 'cash'
            WHEN t.payment_method IN ('ach', 'zb_ach') THEN 'ach'
            WHEN t.payment_method = 'zb_venmo' THEN 'venmo'
            WHEN t.payment_method = 'zb_zelle' THEN 'zelle'
            ELSE 'other'
        END AS payment_methods,
        CASE
            WHEN t.external_source = 'zenbooker' AND NULLIF(zp.display_payment_method, '') IS NOT NULL
                THEN zp.display_payment_method
            WHEN t.payment_method IN ('credit_card', 'zb_card') THEN 'Card'
            WHEN t.payment_method IN ('check', 'zb_check') THEN 'check'
            WHEN t.payment_method IN ('cash', 'zb_cash') THEN 'cash'
            WHEN t.payment_method IN ('ach', 'zb_ach') THEN 'ACH'
            WHEN t.payment_method = 'zb_venmo' THEN 'Venmo'
            WHEN t.payment_method = 'zb_zelle' THEN 'Zelle'
            ELSE 'Other'
        END AS display_payment_method,
        t.amount AS amount_paid,
        t.amount,
        t.currency,
        COALESCE(t.processed_at, t.created_at) AS payment_date,
        COALESCE(NULLIF(local_job.job_source, ''), NULLIF(zb_job.job_source, ''),
                 NULLIF(zp.source, ''), '') AS source,
        COALESCE(NULLIF(provider_data.tech, ''), '—') AS tech,
        COALESCE(provider_data.provider_names, ARRAY[]::text[]) AS provider_names,
        CASE WHEN t.status = 'completed' THEN 'succeeded' ELSE t.status END AS transaction_status,
        t.status AS payment_status,
        CASE
            WHEN COALESCE(local_job.id, zb_job.id) IS NOT NULL THEN false
            WHEN t.external_source = 'zenbooker' THEN COALESCE(zp.missing_job_link, true)
            ELSE false
        END AS missing_job_link,
        COALESCE(i.status, zp.invoice_status) AS invoice_status,
        COALESCE(i.total, zp.invoice_total) AS invoice_total,
        COALESCE(i.amount_paid, zp.invoice_amount_paid) AS invoice_amount_paid,
        COALESCE(i.balance_due, zp.invoice_amount_due) AS invoice_amount_due,
        CASE
            WHEN i.id IS NOT NULL THEN i.balance_due <= 0
            ELSE COALESCE(zp.invoice_paid_in_full, false)
        END AS invoice_paid_in_full,
        COALESCE((t.metadata->>'check_deposited') = 'true', false) AS check_deposited,
        CASE
            WHEN t.payment_method IN ('check', 'zb_check') THEN true
            WHEN LOWER(BTRIM(COALESCE(zp.display_payment_method, ''))) IN ('check', 'cheque') THEN true
            WHEN LOWER(COALESCE(zp.payment_methods, '')) LIKE '%check%' THEN true
            ELSE false
        END AS is_check,
        COALESCE(zp.tags, '') AS tags,
        COALESCE(custom_fields.value, '') AS custom_fields,
        t.reference_number,
        t.reference_number AS reference,
        t.memo,
        t.external_id,
        t.external_source,
        CASE
            WHEN i.id IS NOT NULL THEN jsonb_build_object(
                'status', i.status,
                'total', i.total::text,
                'amount_paid', i.amount_paid::text,
                'amount_due', i.balance_due::text,
                'paid_in_full', i.balance_due <= 0
            )
            ELSE zp.invoice_detail
        END AS invoice_detail,
        CASE
            WHEN COALESCE(local_job.id, zb_job.id) IS NOT NULL THEN jsonb_build_object(
                'job_number', COALESCE(local_job.job_number, zb_job.job_number),
                'service_name', COALESCE(local_job.service_name, zb_job.service_name),
                'service_address', COALESCE(local_job.address, zb_job.address),
                'providers', COALESCE(provider_data.providers, '[]'::jsonb)
            )
            ELSE zp.job_detail
        END AS job_detail,
        CASE WHEN t.external_source = 'zenbooker'
             THEN COALESCE(zp.attachments, '[]'::jsonb)
             ELSE '[]'::jsonb
        END AS attachments,
        (
            COALESCE(zp.metadata, '{}'::jsonb)
            || COALESCE(t.metadata, '{}'::jsonb)
        ) - 'pay_ledger_unify_001_check_deposited_backfill' AS metadata
    FROM payment_transactions t
    LEFT JOIN invoices i
      ON i.company_id = t.company_id
     AND i.id = t.invoice_id
    LEFT JOIN jobs local_job
      ON local_job.company_id = t.company_id
     AND local_job.id = COALESCE(t.job_id, i.job_id)
    LEFT JOIN jobs zb_job
      ON zb_job.company_id = t.company_id
     AND t.external_source = 'zenbooker'
     AND local_job.id IS NULL
     AND zb_job.zenbooker_job_id = NULLIF(t.metadata->>'zb_job_id', '')
    LEFT JOIN contacts c
      ON c.company_id = t.company_id
     AND c.id = COALESCE(t.contact_id, i.contact_id, local_job.contact_id, zb_job.contact_id)
    LEFT JOIN zb_payments zp
      ON zp.company_id = t.company_id
     AND t.external_source = 'zenbooker'
     AND zp.transaction_id = t.external_id
    LEFT JOIN LATERAL (
        SELECT
            COALESCE(jsonb_agg(provider.value ORDER BY provider.ordinality), '[]'::jsonb) AS providers,
            COALESCE(string_agg(BTRIM(provider.value->>'name'), ', ' ORDER BY provider.ordinality), '') AS tech,
            COALESCE(
                array_agg(BTRIM(provider.value->>'name') ORDER BY provider.ordinality),
                ARRAY[]::text[]
            ) AS provider_names
        FROM jsonb_array_elements(
            CASE
                WHEN jsonb_typeof(COALESCE(local_job.assigned_techs, zb_job.assigned_techs, '[]'::jsonb)) = 'array'
                    THEN COALESCE(local_job.assigned_techs, zb_job.assigned_techs, '[]'::jsonb)
                ELSE '[]'::jsonb
            END
        ) WITH ORDINALITY AS provider(value, ordinality)
        WHERE BTRIM(COALESCE(provider.value->>'name', '')) <> ''
    ) provider_data ON true
    LEFT JOIN LATERAL (
        SELECT COALESCE(string_agg(field.value, '; ' ORDER BY field.key), '') AS value
        FROM jsonb_each_text(
            CASE
                WHEN jsonb_typeof(COALESCE(local_job.metadata, zb_job.metadata, '{}'::jsonb)) = 'object'
                    THEN COALESCE(local_job.metadata, zb_job.metadata, '{}'::jsonb)
                ELSE '{}'::jsonb
            END
        ) AS field(key, value)
        WHERE field.value <> ''
    ) custom_fields ON true
    WHERE t.company_id = $1
