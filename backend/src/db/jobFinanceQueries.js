'use strict';

const db = require('./connection');
const { requireCompanyId, queryFor } = require('./crmUtils');

/**
 * Canonical Job paid/due rollup shared by the Jobs list and Inspector.
 * Invoice-linked ledger rows are excluded because invoice money already carries
 * them. Native standalone payments offset due; Zenbooker standalone imports do
 * not manufacture a credit balance.
 */
async function listJobPaymentRollups(companyId, jobIds, client = null) {
    requireCompanyId(companyId);
    const ids = [...new Set((jobIds || []).map(Number).filter(Number.isFinite))];
    if (ids.length === 0) return [];
    const query = queryFor(client, db);
    const { rows } = await query(`
        WITH invoice_rollup AS (
            SELECT i.company_id, i.job_id,
                   SUM(CASE WHEN i.status NOT IN ('void','voided','refunded') THEN COALESCE(i.amount_paid, 0) ELSE 0 END) AS invoice_paid,
                   SUM(CASE WHEN i.status NOT IN ('void','voided','refunded')
                       THEN COALESCE(i.total, 0) - COALESCE(i.amount_paid, 0)
                       ELSE 0
                   END) AS invoice_due
            FROM invoices i
            WHERE i.job_id = ANY($1) AND i.company_id = $2
            GROUP BY i.company_id, i.job_id
        ),
        standalone_rollup AS (
            SELECT pt.company_id, pt.job_id,
                   SUM(
                       CASE
                           WHEN pt.transaction_type = 'payment'
                            AND pt.status IN ('completed', 'refunded')
                               THEN pt.amount
                           WHEN pt.transaction_type = 'refund'
                            AND pt.status = 'completed'
                               THEN -ABS(pt.amount)
                           ELSE 0
                       END
                   ) AS standalone_paid,
                   SUM(
                       CASE
                           WHEN pt.transaction_type = 'payment'
                            AND pt.status IN ('completed', 'refunded')
                               THEN pt.amount
                           WHEN pt.transaction_type = 'refund'
                            AND pt.status = 'completed'
                               THEN -ABS(pt.amount)
                           ELSE 0
                       END
                   ) FILTER (
                       WHERE COALESCE(
                           NULLIF(pt.external_source, ''),
                           refund_origin.external_source
                       ) IS DISTINCT FROM 'zenbooker'
                   ) AS standalone_due_offset
            FROM payment_transactions pt
            LEFT JOIN payment_transactions refund_origin
              ON pt.transaction_type = 'refund'
             AND refund_origin.company_id = pt.company_id
             AND refund_origin.transaction_type = 'payment'
             AND refund_origin.id::TEXT = pt.metadata->>'original_transaction_id'
            WHERE pt.job_id = ANY($1)
              AND pt.company_id = $2
              AND pt.invoice_id IS NULL
              AND pt.voided_at IS NULL
              AND (
                    (pt.transaction_type = 'payment'
                     AND pt.status IN ('completed', 'refunded'))
                 OR (pt.transaction_type = 'refund'
                     AND pt.status = 'completed')
              )
            GROUP BY pt.company_id, pt.job_id
        ),
        jobs_with_money AS (
            SELECT company_id, job_id FROM invoice_rollup
            UNION
            SELECT company_id, job_id FROM standalone_rollup
        )
        SELECT jwm.job_id,
               COALESCE(ir.invoice_paid, 0) + COALESCE(sr.standalone_paid, 0) AS total_paid,
               COALESCE(ir.invoice_due, 0) - COALESCE(sr.standalone_due_offset, 0) AS total_due
        FROM jobs_with_money jwm
        LEFT JOIN invoice_rollup ir
          ON ir.company_id = jwm.company_id
         AND ir.job_id = jwm.job_id
        LEFT JOIN standalone_rollup sr
          ON sr.company_id = jwm.company_id
         AND sr.job_id = jwm.job_id
        WHERE jwm.company_id = $2
    `, [ids, companyId]);
    return rows;
}

/**
 * JOBS-HEADER-QUICKFILTERS-001 — a correlated SQL scalar computing a single job's
 * outstanding Due (dollars), with the SAME rules as listJobPaymentRollups' total_due:
 * non-void invoice balance minus NON-zenbooker standalone payment offsets. Used as a
 * filter predicate by the Jobs-list "Not Paid" quick filter (WHERE <expr> > 0) so the
 * finance rollup participates in the paginated query rather than only post-page.
 *
 * @param {string} jobAlias    - the jobs-table alias in the outer query (e.g. 'j')
 * @param {string} companyParam - the company_id parameter placeholder (e.g. '$1')
 */
function outstandingDueExpr(jobAlias, companyParam) {
    return `(
        COALESCE((
            SELECT SUM(CASE WHEN i.status NOT IN ('void','voided','refunded')
                            THEN COALESCE(i.total, 0) - COALESCE(i.amount_paid, 0) ELSE 0 END)
            FROM invoices i
            WHERE i.job_id = ${jobAlias}.id AND i.company_id = ${companyParam}
        ), 0)
        - COALESCE((
            SELECT SUM(CASE
                         WHEN pt.transaction_type = 'payment' AND pt.status IN ('completed','refunded') THEN pt.amount
                         WHEN pt.transaction_type = 'refund'  AND pt.status = 'completed' THEN -ABS(pt.amount)
                         ELSE 0 END)
            FROM payment_transactions pt
            LEFT JOIN payment_transactions refund_origin
              ON pt.transaction_type = 'refund'
             AND refund_origin.company_id = pt.company_id
             AND refund_origin.transaction_type = 'payment'
             AND refund_origin.id::TEXT = pt.metadata->>'original_transaction_id'
            WHERE pt.job_id = ${jobAlias}.id AND pt.company_id = ${companyParam}
              AND pt.invoice_id IS NULL AND pt.voided_at IS NULL
              AND ((pt.transaction_type = 'payment' AND pt.status IN ('completed','refunded'))
                OR (pt.transaction_type = 'refund'  AND pt.status = 'completed'))
              AND COALESCE(NULLIF(pt.external_source, ''), refund_origin.external_source) IS DISTINCT FROM 'zenbooker'
        ), 0)
    )`;
}

module.exports = { listJobPaymentRollups, outstandingDueExpr };
