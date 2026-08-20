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

async function getInvoiceAllocations(companyId, jobIds, client = null, invoiceIds = []) {
    const ids = [...new Set((jobIds || []).map(Number).filter(Number.isFinite))];
    if (ids.length === 0) return [];
    const scopedInvoiceIds = [...new Set(
        (invoiceIds || []).map(Number).filter(Number.isFinite)
    )];
    const query = queryFor(client);
    const { rows } = await query(`
        WITH ${LEDGER_EFFECTS_CTE},
        linked_native AS (
            SELECT invoice_id,
                   COALESCE(SUM(linked_materialized_effect) FILTER (
                       WHERE effective_source IS DISTINCT FROM 'zenbooker'
                   ), 0) AS linked_amount
            FROM ledger_effects
            WHERE invoice_id IS NOT NULL
            GROUP BY invoice_id
        ),
        direct_application AS (
            -- Linked Zenbooker rows are already represented by the legacy
            -- materialized amount_paid. Every other linked row is the current,
            -- explicit application marker.
            SELECT invoice_id,
                   COALESCE(SUM(document_effect) FILTER (
                       WHERE effective_source IS DISTINCT FROM 'zenbooker'
                   ), 0) AS applied_amount
            FROM ledger_effects
            WHERE invoice_id IS NOT NULL
            GROUP BY invoice_id
        ),
        unapplied_pool AS (
            SELECT job_id,
                   COALESCE(SUM(document_effect), 0) AS unapplied_amount
            FROM ledger_effects
            WHERE invoice_id IS NULL
            GROUP BY job_id
        ),
        active_invoice_count AS (
            SELECT job_id, COUNT(*)::INTEGER AS invoice_count
            FROM invoices
            WHERE company_id = $1
              AND job_id = ANY($2::BIGINT[])
              AND status NOT IN ('void', 'voided', 'refunded')
            GROUP BY job_id
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
                   COALESCE(da.applied_amount, 0) AS directly_applied,
                   CASE
                       WHEN COALESCE(aic.invoice_count, 0) = 1
                           THEN COALESCE(up.unapplied_amount, 0)
                       ELSE 0
                   END AS unapplied_display,
                   CASE
                       WHEN i.status NOT IN ('void', 'voided', 'refunded')
                        AND COALESCE(aic.invoice_count, 0) = 1
                           THEN 0
                       ELSE COALESCE(up.unapplied_amount, 0)
                   END AS job_unapplied_credit
            FROM invoices i
            LEFT JOIN linked_native ln ON ln.invoice_id = i.id
            LEFT JOIN direct_application da ON da.invoice_id = i.id
            LEFT JOIN unapplied_pool up ON up.job_id = i.job_id
            LEFT JOIN active_invoice_count aic ON aic.job_id = i.job_id
            WHERE i.company_id = $1
              AND i.job_id = ANY($2::BIGINT[])
              AND (
                    i.status NOT IN ('void', 'voided', 'refunded')
                    OR i.id = ANY($3::BIGINT[])
              )
        )
        SELECT invoice_id,
               job_id,
               legacy_paid,
               capacity,
               GREATEST(directly_applied + unapplied_display, -legacy_paid)
                   AS job_payment_allocated,
               GREATEST(legacy_paid + directly_applied + unapplied_display, 0)
                   AS amount_paid,
               job_unapplied_credit
        FROM invoice_capacity`,
        [companyId, ids, scopedInvoiceIds]
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
    const allocations = await getInvoiceAllocations(
        companyId,
        uniqueJobIds(invoices),
        client,
        invoices.map(invoice => invoice.id)
    );
    const byInvoice = new Map(allocations.map(row => [String(row.invoice_id), row]));

    return invoices.map(invoice => {
        const allocation = byInvoice.get(String(invoice.id));
        const jobUnappliedCredit = moneyShape(
            allocation?.job_unapplied_credit || 0,
            invoice.amount_paid
        );
        if (!allocation || ['void', 'voided', 'refunded'].includes(invoice.status)) {
            return { ...invoice, job_unapplied_credit: jobUnappliedCredit };
        }
        const amountPaid = Number(allocation.amount_paid || 0);
        const balanceDue = Math.max(Number(invoice.total || 0) - amountPaid, 0);
        return {
            ...invoice,
            amount_paid: moneyShape(amountPaid, invoice.amount_paid),
            balance_due: moneyShape(balanceDue, invoice.balance_due),
            status: derivedInvoiceStatus(invoice, amountPaid),
            job_payment_allocated: moneyShape(
                allocation.job_payment_allocated,
                invoice.amount_paid
            ),
            job_unapplied_credit: jobUnappliedCredit,
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
