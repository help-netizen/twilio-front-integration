'use strict';

const db = require('./connection');
const { requireCompanyId } = require('./crmUtils');

function queryFor(client) {
    return client?.query ? client.query.bind(client) : db.query;
}

/*
 * OB-70 canonical Job finance projection. Every Job-level consumer reads this
 * exact query: active estimates, active invoices, non-tip net payments, tips,
 * signed Due, and unapplied Job credit.
 */
const JOB_FINANCE_SQL = `
    WITH requested_jobs AS (
        SELECT job.id AS job_id
        FROM jobs job
        WHERE job.company_id = $1
          AND ($2::BIGINT[] IS NULL OR job.id = ANY($2::BIGINT[]))
    ),
    estimate_totals AS (
        SELECT estimate.job_id,
               COALESCE(SUM(estimate.total), 0)::NUMERIC AS estimated
        FROM estimates estimate
        JOIN requested_jobs requested ON requested.job_id = estimate.job_id
        WHERE estimate.company_id = $1
          AND estimate.archived_at IS NULL
          AND estimate.status <> 'declined'
        GROUP BY estimate.job_id
    ),
    invoice_totals AS (
        SELECT invoice.job_id,
               COALESCE(SUM(invoice.total), 0)::NUMERIC AS invoiced
        FROM invoices invoice
        JOIN requested_jobs requested ON requested.job_id = invoice.job_id
        WHERE invoice.company_id = $1
          AND invoice.status NOT IN ('void', 'voided', 'refunded')
        GROUP BY invoice.job_id
    ),
    payment_base AS (
        SELECT payment.*,
               COALESCE(payment.job_id, applied_invoice.job_id) AS effective_job_id,
               original.amount AS original_amount,
               original.metadata AS original_metadata
        FROM payment_transactions payment
        LEFT JOIN invoices applied_invoice
          ON applied_invoice.id = payment.invoice_id
         AND applied_invoice.company_id = payment.company_id
        LEFT JOIN LATERAL (
            SELECT original_payment.amount, original_payment.metadata
            FROM payment_transactions original_payment
            WHERE original_payment.company_id = payment.company_id
              AND original_payment.transaction_type = 'payment'
              AND (
                    (
                        payment.metadata->>'original_transaction_id' ~ '^[0-9]+$'
                        AND original_payment.id =
                            (payment.metadata->>'original_transaction_id')::BIGINT
                    )
                    OR (
                        NULLIF(payment.metadata->>'original_external_id', '') IS NOT NULL
                        AND original_payment.external_id =
                            payment.metadata->>'original_external_id'
                    )
              )
            ORDER BY original_payment.id
            LIMIT 1
        ) original ON payment.transaction_type = 'refund'
        WHERE payment.company_id = $1
          AND COALESCE(payment.job_id, applied_invoice.job_id) IN (
              SELECT requested.job_id FROM requested_jobs requested
          )
          AND payment.transaction_type IN ('payment', 'refund')
    ),
    payment_effects AS (
        SELECT payment.id,
               payment.effective_job_id AS job_id,
               payment.invoice_id,
               CASE
                   WHEN payment.voided_at IS NOT NULL THEN 0::NUMERIC
                   WHEN payment.transaction_type = 'payment'
                    AND payment.status IN ('completed', 'refunded')
                       THEN GREATEST(
                           payment.amount - LEAST(
                               GREATEST(
                                   CASE
                                       WHEN payment.metadata->>'tip' ~ '^[0-9]+([.][0-9]+)?$'
                                           THEN (payment.metadata->>'tip')::NUMERIC
                                       ELSE 0
                                   END,
                                   0
                               ),
                               GREATEST(payment.amount, 0)
                           ),
                           0
                       )
                   WHEN payment.transaction_type = 'refund'
                    AND payment.status = 'completed'
                       THEN -ABS(payment.amount) * CASE
                           WHEN COALESCE(ABS(payment.original_amount), 0) > 0
                               THEN GREATEST(
                                   ABS(payment.original_amount) - LEAST(
                                       GREATEST(
                                           CASE
                                               WHEN payment.original_metadata->>'tip'
                                                    ~ '^[0-9]+([.][0-9]+)?$'
                                                   THEN (payment.original_metadata->>'tip')::NUMERIC
                                               ELSE 0
                                           END,
                                           0
                                       ),
                                       ABS(payment.original_amount)
                                   ),
                                   0
                               ) / ABS(payment.original_amount)
                           ELSE 1
                       END
                   ELSE 0::NUMERIC
               END AS paid_effect,
               CASE
                   WHEN payment.voided_at IS NOT NULL THEN 0::NUMERIC
                   WHEN payment.transaction_type = 'payment'
                    AND payment.status IN ('completed', 'refunded')
                       THEN LEAST(
                           GREATEST(
                               CASE
                                   WHEN payment.metadata->>'tip' ~ '^[0-9]+([.][0-9]+)?$'
                                       THEN (payment.metadata->>'tip')::NUMERIC
                                   ELSE 0
                               END,
                               0
                           ),
                           GREATEST(payment.amount, 0)
                       )
                   ELSE 0::NUMERIC
               END AS tip_effect
        FROM payment_base payment
    ),
    payment_totals AS (
        SELECT effect.job_id,
               COALESCE(SUM(effect.paid_effect), 0)::NUMERIC AS paid,
               COALESCE(SUM(effect.tip_effect), 0)::NUMERIC AS tips,
               COALESCE(SUM(effect.paid_effect) FILTER (
                   WHERE effect.invoice_id IS NULL
               ), 0)::NUMERIC AS unapplied_credit
        FROM payment_effects effect
        GROUP BY effect.job_id
    ),
    finance_projection AS (
        SELECT requested.job_id,
               COALESCE(estimate.estimated, 0)::NUMERIC AS estimated,
               COALESCE(invoice.invoiced, 0)::NUMERIC AS invoiced,
               COALESCE(payment.paid, 0)::NUMERIC AS paid,
               COALESCE(invoice.invoiced, 0)::NUMERIC
                   - COALESCE(payment.paid, 0)::NUMERIC AS due,
               COALESCE(payment.tips, 0)::NUMERIC AS tips,
               COALESCE(payment.unapplied_credit, 0)::NUMERIC AS unapplied_credit
        FROM requested_jobs requested
        LEFT JOIN estimate_totals estimate ON estimate.job_id = requested.job_id
        LEFT JOIN invoice_totals invoice ON invoice.job_id = requested.job_id
        LEFT JOIN payment_totals payment ON payment.job_id = requested.job_id
    )
    SELECT job_id, estimated, invoiced, paid, due, tips, unapplied_credit
    FROM finance_projection
    WHERE ($3::BOOLEAN = FALSE OR due > 0)
    ORDER BY job_id`;

function normalizeFinance(row) {
    if (!row) return null;
    return {
        job_id: row.job_id,
        estimated: Number(row.estimated || 0),
        invoiced: Number(row.invoiced || 0),
        paid: Number(row.paid || 0),
        due: Number(row.due || 0),
        tips: Number(row.tips || 0),
        unapplied_credit: Number(row.unapplied_credit || 0),
    };
}

async function listJobFinances(
    companyId,
    jobIds = null,
    client = null,
    { positiveDueOnly = false } = {}
) {
    requireCompanyId(companyId);
    const ids = jobIds == null
        ? null
        : [...new Set(jobIds.map(Number).filter(Number.isFinite))];
    if (ids?.length === 0) return [];
    const query = queryFor(client);
    const { rows } = await query(JOB_FINANCE_SQL, [companyId, ids, positiveDueOnly]);
    return rows.map(normalizeFinance);
}

async function getJobFinance(companyId, jobId, client = null) {
    const [finance] = await listJobFinances(companyId, [jobId], client);
    return finance || null;
}

// Compatibility adapter for older internal callers; the formula remains the
// canonical projection above.
async function listJobPaymentRollups(companyId, jobIds, client = null) {
    const rows = await listJobFinances(companyId, jobIds, client);
    return rows.map(row => ({
        job_id: row.job_id,
        total_paid: row.paid,
        total_due: row.due,
    }));
}

module.exports = {
    JOB_FINANCE_SQL,
    getJobFinance,
    listJobFinances,
    listJobPaymentRollups,
};
