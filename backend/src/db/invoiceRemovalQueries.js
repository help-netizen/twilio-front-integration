'use strict';

const db = require('./connection');

function queryFor(client) {
    return client?.query ? client.query.bind(client) : db.query;
}

async function getCompletedRemoval(companyId, sourceInvoiceId, client = null) {
    const query = queryFor(client);
    const { rows } = await query(
        `SELECT *
         FROM invoice_removals
         WHERE company_id = $1 AND source_invoice_id = $2`,
        [companyId, sourceInvoiceId]
    );
    return rows[0] || null;
}

async function getRemovalByRequestId(companyId, requestId, client = null) {
    const query = queryFor(client);
    const { rows } = await query(
        `SELECT *
         FROM invoice_removals
         WHERE company_id = $1 AND request_id = $2`,
        [companyId, requestId]
    );
    return rows[0] || null;
}

async function getSourceInvoice(companyId, sourceInvoiceId, client = null, { lock = false } = {}) {
    if (lock && !client?.query) {
        throw new Error('getSourceInvoice lock requires an active transaction');
    }
    const query = queryFor(client);
    const { rows } = await query(
        `SELECT i.*
         FROM invoices i
         WHERE i.company_id = $1 AND i.id = $2
         ${lock ? 'FOR UPDATE' : ''}`,
        [companyId, sourceInvoiceId]
    );
    return rows[0] || null;
}

/**
 * The dependent-row predicates are deliberately keyed on the globally unique
 * invoice id. An anomalous cross-tenant reference must block removal rather
 * than be hidden by tenant scope and left partly detached.
 */
async function hasCrossTenantReferences(companyId, sourceInvoiceId, client = null) {
    const query = queryFor(client);
    const { rows } = await query(
        `SELECT EXISTS (
                    SELECT 1 FROM payment_transactions pt
                    WHERE pt.invoice_id = i.id
                      AND pt.company_id <> i.company_id
                ) OR EXISTS (
                    SELECT 1 FROM stripe_payment_sessions s
                    WHERE s.invoice_id = i.id
                      AND s.company_id <> i.company_id
                ) OR EXISTS (
                    SELECT 1 FROM tasks t
                    WHERE t.invoice_id = i.id
                      AND t.company_id <> i.company_id
                ) OR EXISTS (
                    SELECT 1 FROM ai_generation_log agl
                    WHERE agl.invoice_id = i.id
                      AND agl.company_id <> i.company_id
                ) AS has_cross_tenant_reference
         FROM invoices i
         WHERE i.company_id = $1 AND i.id = $2`,
        [companyId, sourceInvoiceId]
    );
    return Boolean(rows[0]?.has_cross_tenant_reference);
}

async function getAppliedTransactions(
    companyId,
    sourceInvoiceId,
    client = null,
    { lock = false } = {}
) {
    if (lock && !client?.query) {
        throw new Error('getAppliedTransactions lock requires an active transaction');
    }
    const query = queryFor(client);
    const { rows } = await query(
        `SELECT pt.*,
                original.amount AS original_amount,
                original.metadata AS original_metadata
         FROM payment_transactions pt
         LEFT JOIN LATERAL (
             SELECT op.amount, op.metadata
             FROM payment_transactions op
             WHERE op.company_id = pt.company_id
               AND op.transaction_type = 'payment'
               AND (
                    (
                        pt.metadata->>'original_transaction_id' ~ '^[0-9]+$'
                        AND op.id = (pt.metadata->>'original_transaction_id')::BIGINT
                    )
                    OR (
                        NULLIF(pt.metadata->>'original_external_id', '') IS NOT NULL
                        AND op.external_id = pt.metadata->>'original_external_id'
                    )
               )
             ORDER BY op.id
             LIMIT 1
         ) original ON pt.transaction_type = 'refund'
         WHERE pt.company_id = $1 AND pt.invoice_id = $2
         ORDER BY pt.id
         ${lock ? 'FOR UPDATE OF pt' : ''}`,
        [companyId, sourceInvoiceId]
    );
    return rows;
}

async function getStripeSessions(
    companyId,
    sourceInvoiceId,
    client = null,
    { lock = false } = {}
) {
    if (lock && !client?.query) {
        throw new Error('getStripeSessions lock requires an active transaction');
    }
    const query = queryFor(client);
    const { rows } = await query(
        `SELECT *
         FROM stripe_payment_sessions
         WHERE company_id = $1 AND invoice_id = $2
         ORDER BY id
         ${lock ? 'FOR UPDATE' : ''}`,
        [companyId, sourceInvoiceId]
    );
    return rows;
}

async function getCandidateInvoices(companyId, sourceInvoice, client = null) {
    if (sourceInvoice.job_id == null) return [];
    const query = queryFor(client);
    const { rows } = await query(
        `SELECT i.*
         FROM invoices i
         WHERE i.company_id = $1
           AND i.job_id = $2
           AND i.id <> $3
           AND i.status NOT IN ('void', 'voided', 'refunded')
           AND UPPER(i.currency) = UPPER($4)
         ORDER BY i.created_at ASC, i.id ASC`,
        [companyId, sourceInvoice.job_id, sourceInvoice.id, sourceInvoice.currency || 'USD']
    );
    return rows;
}

async function lockCandidateInvoice(companyId, targetInvoiceId, client = null) {
    if (!client?.query) {
        throw new Error('lockCandidateInvoice requires an active transaction');
    }
    const { rows } = await client.query(
        `SELECT *
         FROM invoices
         WHERE company_id = $1 AND id = $2
         FOR UPDATE`,
        [companyId, targetInvoiceId]
    );
    return rows[0] || null;
}

async function createRemoval(companyId, data, client = null) {
    const query = queryFor(client);
    const { rows } = await query(
        `INSERT INTO invoice_removals (
            company_id, source_invoice_id, source_invoice_number, source_job_id,
            disposition, payment_action, target_invoice_id, target_invoice_number,
            detached_amount, detached_payment_count, detached_transaction_count,
            currency, preview_version, request_id, actor_id,
            invoice_snapshot, payment_snapshot
         ) VALUES (
            $1, $2, $3, $4,
            $5, $6, $7, $8,
            $9, $10, $11,
            $12, $13, $14, $15,
            $16::jsonb, $17::jsonb
         )
         RETURNING *`,
        [
            companyId,
            data.source_invoice_id,
            data.source_invoice_number,
            data.source_job_id,
            data.disposition,
            data.payment_action,
            data.target_invoice_id,
            data.target_invoice_number,
            data.detached_amount,
            data.detached_payment_count,
            data.detached_transaction_count,
            data.currency,
            data.preview_version,
            data.request_id,
            data.actor_id,
            JSON.stringify(data.invoice_snapshot),
            JSON.stringify(data.payment_snapshot),
        ]
    );
    return rows[0];
}

async function reassignPayments(
    companyId,
    sourceInvoiceId,
    sourceJobId,
    targetInvoiceId,
    client = null
) {
    const query = queryFor(client);
    const { rows } = await query(
        `UPDATE payment_transactions
         SET origin_invoice_id = COALESCE(origin_invoice_id, invoice_id),
             invoice_id = $4,
             job_id = COALESCE(job_id, $3),
             updated_at = NOW()
         WHERE company_id = $1
           AND invoice_id = $2
           AND (job_id IS NULL OR job_id = $3)
         RETURNING *`,
        [companyId, sourceInvoiceId, sourceJobId, targetInvoiceId]
    );
    return rows;
}

async function detachStripeSessions(
    companyId,
    sourceInvoice,
    client = null
) {
    const query = queryFor(client);
    const { rows } = await query(
        `UPDATE stripe_payment_sessions
         SET invoice_id = NULL,
             job_id = COALESCE(job_id, $3),
             metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
                 'removed_invoice_id', $2::TEXT,
                 'removed_invoice_number', $4::TEXT
             ),
             updated_at = NOW()
         WHERE company_id = $1 AND invoice_id = $2
         RETURNING *`,
        [companyId, sourceInvoice.id, sourceInvoice.job_id, sourceInvoice.invoice_number]
    );
    return rows;
}

async function voidInvoiceForRemoval(companyId, sourceInvoiceId, client = null) {
    const query = queryFor(client);
    const { rows } = await query(
        `UPDATE invoices
         SET status = 'void', voided_at = NOW(), updated_at = NOW()
         WHERE company_id = $1
           AND id = $2
           AND status NOT IN ('void', 'voided', 'refunded')
         RETURNING *`,
        [companyId, sourceInvoiceId]
    );
    return rows[0] || null;
}

async function saveRemovalResponse(companyId, removalId, response, client = null) {
    const query = queryFor(client);
    const { rows } = await query(
        `UPDATE invoice_removals
         SET response = $3::jsonb
         WHERE company_id = $1 AND id = $2
         RETURNING *`,
        [companyId, removalId, JSON.stringify(response)]
    );
    return rows[0] || null;
}

module.exports = {
    createRemoval,
    detachStripeSessions,
    getAppliedTransactions,
    getCandidateInvoices,
    getCompletedRemoval,
    getRemovalByRequestId,
    hasCrossTenantReferences,
    getSourceInvoice,
    getStripeSessions,
    lockCandidateInvoice,
    reassignPayments,
    saveRemovalResponse,
    voidInvoiceForRemoval,
};
