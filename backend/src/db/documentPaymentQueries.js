'use strict';

const db = require('./connection');

function queryFor(client) {
    return client?.query ? client.query.bind(client) : db.query;
}

function uniqueJobIds(rows) {
    return [...new Set((rows || [])
        .map(row => Number(row?.job_id))
        .filter(Number.isFinite))];
}

/*
 * One native transaction effect, shared by invoice allocation, estimate paid
 * display, and the Job rollup. A refunded payment remains gross while its
 * completed refund row offsets it. Stripe tips stay outside document balances.
 */
const LEDGER_EFFECTS_CTE = `
    original_payments AS (
        SELECT refund.id AS refund_id,
               original.external_source,
               original.amount,
               GREATEST(
                   CASE
                       WHEN original.metadata->>'tip' ~ '^[0-9]+([.][0-9]+)?$'
                           THEN (original.metadata->>'tip')::NUMERIC
                       ELSE 0
                   END,
                   0
               ) AS tip
        FROM payment_transactions refund
        LEFT JOIN payment_transactions original
          ON original.company_id = refund.company_id
         AND original.transaction_type = 'payment'
         AND (
                (
                    refund.metadata->>'original_transaction_id' ~ '^[0-9]+$'
                    AND original.id = (refund.metadata->>'original_transaction_id')::BIGINT
                )
             OR (
                    NULLIF(refund.metadata->>'original_external_id', '') IS NOT NULL
                    AND original.external_id = refund.metadata->>'original_external_id'
                )
         )
        WHERE refund.company_id = $1
          AND refund.job_id = ANY($2::BIGINT[])
          AND refund.transaction_type = 'refund'
    ),
    ledger_effects AS (
        SELECT pt.job_id,
               pt.invoice_id,
               COALESCE(NULLIF(pt.external_source, ''), op.external_source) AS effective_source,
               pt.transaction_type,
               pt.status,
               CASE
                   WHEN pt.voided_at IS NOT NULL THEN 0::NUMERIC
                   WHEN pt.transaction_type = 'payment'
                    AND pt.status IN ('completed', 'refunded')
                       THEN pt.amount
                   WHEN pt.transaction_type = 'refund'
                    AND pt.status = 'completed'
                       THEN -ABS(pt.amount)
                   ELSE 0::NUMERIC
               END AS paid_effect,
               CASE
                   WHEN pt.voided_at IS NOT NULL THEN 0::NUMERIC
                   WHEN pt.transaction_type = 'payment'
                    AND pt.status IN ('completed', 'refunded')
                       THEN GREATEST(
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
                   WHEN pt.transaction_type = 'refund'
                    AND pt.status = 'completed'
                       THEN -ABS(pt.amount) * CASE
                           WHEN COALESCE(ABS(op.amount), 0) > 0
                               THEN GREATEST(ABS(op.amount) - op.tip, 0) / ABS(op.amount)
                           ELSE 1
                       END
                   ELSE 0::NUMERIC
               END AS document_effect,
               CASE
                   -- A voided linked payment may still be present in the legacy
                   -- materialized invoice amount. Back out its historical document
                   -- contribution before applying the currently-active Job pool.
                   WHEN pt.transaction_type = 'payment'
                    AND (pt.status IN ('completed', 'refunded', 'voided') OR pt.voided_at IS NOT NULL)
                       THEN GREATEST(
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
                   WHEN pt.transaction_type = 'refund'
                    AND pt.status = 'completed'
                       THEN -ABS(pt.amount) * CASE
                           WHEN COALESCE(ABS(op.amount), 0) > 0
                               THEN GREATEST(ABS(op.amount) - op.tip, 0) / ABS(op.amount)
                           ELSE 1
                       END
                   ELSE 0::NUMERIC
               END AS linked_materialized_effect
        FROM payment_transactions pt
        LEFT JOIN original_payments op ON op.refund_id = pt.id
        WHERE pt.company_id = $1
          AND pt.job_id = ANY($2::BIGINT[])
          AND pt.transaction_type IN ('payment', 'refund')
    )`;

async function getInvoiceAllocations(companyId, jobIds, client = null) {
    const ids = [...new Set((jobIds || []).map(Number).filter(Number.isFinite))];
    if (ids.length === 0) return [];
    const query = queryFor(client);
    const { rows } = await query(`
        WITH ${LEDGER_EFFECTS_CTE},
        native_pool AS (
            -- Zenbooker money leaves the pool ONLY when it is already
            -- materialized on an invoice (invoice_id set), because then it is
            -- inside legacy_paid and counting it here would settle it twice.
            -- The filter used to drop every ZB row: in production not one of the
            -- 1403 completed ZB payments ($288,840) carries an invoice_id, and
            -- no invoice carries amount_paid without a linked payment — so real
            -- money never reached any document and jobs showed debts they did
            -- not have (measured 2026-08-16).
            SELECT job_id,
                   GREATEST(COALESCE(SUM(document_effect) FILTER (
                       WHERE NOT (effective_source = 'zenbooker' AND invoice_id IS NOT NULL)
                   ), 0), 0) AS pool_amount
            FROM ledger_effects
            GROUP BY job_id
        ),
        linked_native AS (
            SELECT invoice_id,
                   COALESCE(SUM(linked_materialized_effect) FILTER (
                       WHERE effective_source IS DISTINCT FROM 'zenbooker'
                   ), 0) AS linked_amount
            FROM ledger_effects
            WHERE invoice_id IS NOT NULL
            GROUP BY invoice_id
        ),
        invoice_capacity AS (
            SELECT i.id AS invoice_id,
                   i.job_id,
                   GREATEST(
                       COALESCE(i.amount_paid, 0) - COALESCE(ln.linked_amount, 0),
                       0
                   ) AS legacy_paid,
                   GREATEST(
                       COALESCE(i.total, 0) - GREATEST(
                           COALESCE(i.amount_paid, 0) - COALESCE(ln.linked_amount, 0),
                           0
                       ),
                       0
                   ) AS capacity,
                   COALESCE(np.pool_amount, 0) AS pool_amount,
                   i.created_at
            FROM invoices i
            LEFT JOIN linked_native ln ON ln.invoice_id = i.id
            LEFT JOIN native_pool np ON np.job_id = i.job_id
            WHERE i.company_id = $1
              AND i.job_id = ANY($2::BIGINT[])
              AND i.status NOT IN ('void', 'voided', 'refunded')
        ),
        ordered AS (
            SELECT ic.*,
                   COALESCE(SUM(capacity) OVER (
                       PARTITION BY job_id
                       ORDER BY created_at ASC, invoice_id ASC
                       ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
                   ), 0) AS prior_capacity
            FROM invoice_capacity ic
        )
        SELECT invoice_id,
               job_id,
               legacy_paid,
               capacity,
               LEAST(capacity, GREATEST(pool_amount - prior_capacity, 0)) AS job_payment_allocated,
               legacy_paid
                   + LEAST(capacity, GREATEST(pool_amount - prior_capacity, 0)) AS amount_paid
        FROM ordered`,
        [companyId, ids]
    );
    return rows;
}

async function getJobPaymentPools(companyId, jobIds, client = null) {
    const ids = [...new Set((jobIds || []).map(Number).filter(Number.isFinite))];
    if (ids.length === 0) return [];
    const query = queryFor(client);
    const { rows } = await query(`
        WITH ${LEDGER_EFFECTS_CTE}
        SELECT job_id,
               GREATEST(COALESCE(SUM(document_effect) FILTER (
                   WHERE NOT (effective_source = 'zenbooker' AND invoice_id IS NOT NULL)
               ), 0), 0) AS native_pool,
               COALESCE(SUM(paid_effect) FILTER (
                   WHERE effective_source IS DISTINCT FROM 'zenbooker'
                      OR invoice_id IS NULL
               ), 0) AS total_pool,
               BOOL_OR(
                   effective_source IS DISTINCT FROM 'zenbooker'
                   AND (
                       (transaction_type = 'payment' AND status IN ('completed', 'refunded'))
                       OR (transaction_type = 'refund' AND status = 'completed')
                   )
               ) AS has_native_transactions
        FROM ledger_effects
        GROUP BY job_id`,
        [companyId, ids]
    );
    return rows;
}

function moneyShape(value, sample) {
    const amount = Number(value || 0);
    return typeof sample === 'string' ? amount.toFixed(2) : amount;
}

function derivedInvoiceStatus(invoice, amountPaid) {
    if (['void', 'voided', 'refunded'].includes(invoice.status)) return invoice.status;
    const total = Number(invoice.total || 0);
    if (total > 0 && amountPaid >= total) return 'paid';
    if (amountPaid > 0) return 'partial';
    return ['paid', 'partial'].includes(invoice.status) ? 'sent' : invoice.status;
}

async function applyInvoiceAllocations(companyId, invoices, client = null) {
    if (!Array.isArray(invoices) || invoices.length === 0) return invoices || [];
    const allocations = await getInvoiceAllocations(companyId, uniqueJobIds(invoices), client);
    const byInvoice = new Map(allocations.map(row => [String(row.invoice_id), row]));

    return invoices.map(invoice => {
        const allocation = byInvoice.get(String(invoice.id));
        if (!allocation || ['void', 'voided', 'refunded'].includes(invoice.status)) {
            return invoice;
        }
        const amountPaid = Number(allocation.amount_paid || 0);
        const balanceDue = Number(invoice.total || 0) - amountPaid;
        return {
            ...invoice,
            amount_paid: moneyShape(amountPaid, invoice.amount_paid),
            balance_due: moneyShape(balanceDue, invoice.balance_due),
            status: derivedInvoiceStatus(invoice, amountPaid),
            job_payment_allocated: moneyShape(
                allocation.job_payment_allocated,
                invoice.amount_paid
            ),
        };
    });
}

async function applyEstimatePayments(companyId, estimates, client = null) {
    if (!Array.isArray(estimates) || estimates.length === 0) return estimates || [];
    const pools = await getJobPaymentPools(companyId, uniqueJobIds(estimates), client);
    const byJob = new Map(pools.map(row => [String(row.job_id), row]));

    return estimates.map(estimate => {
        const pool = byJob.get(String(estimate.job_id));
        if (!pool?.has_native_transactions) return estimate;
        const paid = Math.min(
            Math.max(
                Number(estimate.deposit_paid || 0) + Number(pool.native_pool || 0),
                0
            ),
            Math.max(Number(estimate.total || 0), 0)
        );
        return {
            ...estimate,
            deposit_paid: moneyShape(paid, estimate.deposit_paid),
            balance_due: moneyShape(Number(estimate.total || 0) - paid, estimate.total),
        };
    });
}

module.exports = {
    LEDGER_EFFECTS_CTE,
    getInvoiceAllocations,
    getJobPaymentPools,
    applyInvoiceAllocations,
    applyEstimatePayments,
};
