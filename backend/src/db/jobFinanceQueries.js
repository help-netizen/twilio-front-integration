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
                   SUM(CASE WHEN i.status NOT IN ('void','voided','refunded') THEN COALESCE(i.balance_due, 0) ELSE 0 END) AS invoice_due
            FROM invoices i
            WHERE i.job_id = ANY($1) AND i.company_id = $2
            GROUP BY i.company_id, i.job_id
        ),
        standalone_rollup AS (
            SELECT pt.company_id, pt.job_id,
                   SUM(pt.amount) AS standalone_paid,
                   SUM(pt.amount) FILTER (
                       WHERE pt.external_source IS DISTINCT FROM 'zenbooker'
                   ) AS standalone_due_offset
            FROM payment_transactions pt
            WHERE pt.job_id = ANY($1)
              AND pt.company_id = $2
              AND pt.invoice_id IS NULL
              AND pt.transaction_type = 'payment'
              AND pt.status = 'completed'
              AND pt.voided_at IS NULL
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

module.exports = { listJobPaymentRollups };
