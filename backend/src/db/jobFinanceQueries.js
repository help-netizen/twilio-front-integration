'use strict';

const { requireCompanyId } = require('./crmUtils');
const {
    getInvoiceAllocations,
    getJobPaymentPools,
} = require('./documentPaymentQueries');

/**
 * Canonical Job paid/due rollup shared by the Jobs list and Inspector. Native
 * payments count from the Job pool regardless of invoice_id. Legacy persisted
 * invoice money remains only after subtracting native rows that previously
 * materialized it. Zenbooker remains paid-history only and does not offset Due.
 */
async function listJobPaymentRollups(companyId, jobIds, client = null) {
    requireCompanyId(companyId);
    const ids = [...new Set((jobIds || []).map(Number).filter(Number.isFinite))];
    if (ids.length === 0) return [];
    const allocations = await getInvoiceAllocations(companyId, ids, client);
    const pools = await getJobPaymentPools(companyId, ids, client);
    const byJob = new Map();
    const ensure = (jobId) => {
        const key = String(jobId);
        if (!byJob.has(key)) {
            byJob.set(key, {
                job_id: jobId,
                invoice_total: 0,
                legacy_paid: 0,
                native_pool: 0,
                total_pool: 0,
                has_invoices: false,
            });
        }
        return byJob.get(key);
    };

    for (const invoice of allocations) {
        const row = ensure(invoice.job_id);
        row.has_invoices = true;
        row.invoice_total += Number(invoice.legacy_paid || 0)
            + Number(invoice.capacity || 0);
        row.legacy_paid += Number(invoice.legacy_paid || 0);
    }
    for (const pool of pools) {
        const row = ensure(pool.job_id);
        row.native_pool = Number(pool.native_pool || 0);
        row.total_pool = Number(pool.total_pool || 0);
    }

    return [...byJob.values()].filter(row => (
        row.has_invoices || row.native_pool !== 0 || row.total_pool !== 0
    )).map(row => ({
        job_id: row.job_id,
        total_paid: row.legacy_paid + row.total_pool,
        total_due: row.invoice_total - row.legacy_paid - row.native_pool,
    }));
}

/**
 * JOBS-HEADER-QUICKFILTERS-001 — a correlated SQL scalar computing a single job's
 * outstanding Due (dollars), with the SAME rules as listJobPaymentRollups' total_due:
 * non-void invoice totals minus the native Job pool. Legacy materialized native
 * invoice amounts are first backed out so old claimed rows cannot double count. Used as a
 * filter predicate by the Jobs-list "Not Paid" quick filter (WHERE <expr> > 0) so the
 * finance rollup participates in the paginated query rather than only post-page.
 *
 * @param {string} jobAlias    - the jobs-table alias in the outer query (e.g. 'j')
 * @param {string} companyParam - the company_id parameter placeholder (e.g. '$1')
 */
function outstandingDueExpr(jobAlias, companyParam) {
    return `(
        COALESCE((
            SELECT SUM(CASE
                WHEN i.status IN ('void','voided','refunded') THEN 0
                ELSE COALESCE(i.total, 0) - GREATEST(
                    COALESCE(i.amount_paid, 0) - COALESCE((
                        SELECT SUM(CASE
                            WHEN linked.transaction_type = 'payment'
                             AND (
                                 linked.status IN ('completed','refunded','voided')
                                 OR linked.voided_at IS NOT NULL
                             ) THEN GREATEST(
                                 linked.amount - GREATEST(
                                     CASE
                                         WHEN linked.metadata->>'tip' ~ '^[0-9]+([.][0-9]+)?$'
                                             THEN (linked.metadata->>'tip')::NUMERIC
                                         ELSE 0
                                     END,
                                     0
                                 ),
                                 0
                             )
                            WHEN linked.transaction_type = 'refund'
                             AND linked.status = 'completed' THEN -ABS(linked.amount) * CASE
                                 WHEN COALESCE(ABS(linked_origin.amount), 0) > 0 THEN
                                     GREATEST(
                                         ABS(linked_origin.amount) - GREATEST(
                                             CASE
                                                 WHEN linked_origin.metadata->>'tip' ~ '^[0-9]+([.][0-9]+)?$'
                                                     THEN (linked_origin.metadata->>'tip')::NUMERIC
                                                 ELSE 0
                                             END,
                                             0
                                         ),
                                         0
                                     ) / ABS(linked_origin.amount)
                                 ELSE 1
                             END
                            ELSE 0 END)
                        FROM payment_transactions linked
                        LEFT JOIN payment_transactions linked_origin
                          ON linked_origin.company_id = linked.company_id
                         AND linked_origin.transaction_type = 'payment'
                         AND linked_origin.id::TEXT = linked.metadata->>'original_transaction_id'
                        WHERE linked.company_id = ${companyParam}
                          AND linked.invoice_id = i.id
                          AND COALESCE(NULLIF(linked.external_source, ''), linked_origin.external_source)
                              IS DISTINCT FROM 'zenbooker'
                    ), 0),
                    0
                ) END)
            FROM invoices i
            WHERE i.job_id = ${jobAlias}.id AND i.company_id = ${companyParam}
        ), 0)
        - COALESCE((
            SELECT SUM(CASE
                         WHEN pt.transaction_type = 'payment' AND pt.status IN ('completed','refunded') THEN
                             GREATEST(
                                 pt.amount - GREATEST(
                                     CASE
                                         WHEN pt.metadata->>'tip' ~ '^[0-9]+([.][0-9]+)?$'
                                             THEN (pt.metadata->>'tip')::NUMERIC
                                         ELSE 0
                                     END,
                                     0
                                 ),
                                 0
                             )
                         WHEN pt.transaction_type = 'refund'  AND pt.status = 'completed' THEN
                             -ABS(pt.amount) * CASE
                                 WHEN COALESCE(ABS(refund_origin.amount), 0) > 0 THEN
                                     GREATEST(
                                         ABS(refund_origin.amount) - GREATEST(
                                             CASE
                                                 WHEN refund_origin.metadata->>'tip' ~ '^[0-9]+([.][0-9]+)?$'
                                                     THEN (refund_origin.metadata->>'tip')::NUMERIC
                                                 ELSE 0
                                             END,
                                             0
                                         ),
                                         0
                                     ) / ABS(refund_origin.amount)
                                 ELSE 1
                             END
                         ELSE 0 END)
            FROM payment_transactions pt
            LEFT JOIN payment_transactions refund_origin
              ON pt.transaction_type = 'refund'
             AND refund_origin.company_id = pt.company_id
             AND refund_origin.transaction_type = 'payment'
             AND refund_origin.id::TEXT = pt.metadata->>'original_transaction_id'
            WHERE pt.job_id = ${jobAlias}.id AND pt.company_id = ${companyParam}
              AND pt.voided_at IS NULL
              AND ((pt.transaction_type = 'payment' AND pt.status IN ('completed','refunded'))
                OR (pt.transaction_type = 'refund'  AND pt.status = 'completed'))
              AND COALESCE(NULLIF(pt.external_source, ''), refund_origin.external_source) IS DISTINCT FROM 'zenbooker'
        ), 0)
    )`;
}

module.exports = { listJobPaymentRollups, outstandingDueExpr };
