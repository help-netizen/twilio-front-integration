/**
 * Payments Queries Module
 * PF004 Payment Collection MVP — Sprint 5
 *
 * Database queries for payment_transactions and payment_receipts.
 */
const db = require('./connection');

const STRIPE_TRANSACTION_JOINS = `
        LEFT JOIN LATERAL (
            SELECT s.id, s.contact_id, s.invoice_id, s.job_id,
                   s.stripe_payment_intent_id, s.stripe_charge_id,
                   s.stripe_account_id
            FROM stripe_payment_sessions s
            WHERE s.company_id = t.company_id
              AND (
                    s.stripe_payment_intent_id = t.external_id
                 OR s.stripe_charge_id = t.external_id
                 OR s.stripe_checkout_session_id = t.external_id
                 OR s.stripe_payment_intent_id = NULLIF(t.metadata->>'payment_intent_id', '')
                 OR s.stripe_checkout_session_id = NULLIF(t.metadata->>'checkout_session_id', '')
              )
            ORDER BY s.created_at DESC
            LIMIT 1
        ) stripe_session ON true
        LEFT JOIN stripe_connected_accounts stripe_account
          ON stripe_account.company_id = t.company_id
`;

const STRIPE_TRANSACTION_COLUMNS = `
        CASE
            WHEN t.external_source = 'stripe' AND t.payment_method = 'credit_card'
            THEN COALESCE(
                stripe_session.stripe_charge_id,
                stripe_session.stripe_payment_intent_id,
                NULLIF(t.metadata->>'payment_intent_id', ''),
                CASE
                    WHEN LEFT(t.external_id, 3) IN ('ch_', 'pi_') THEN t.external_id
                    ELSE NULL
                END
            )
            ELSE NULL
        END AS stripe_payment_id,
        CASE
            WHEN t.external_source = 'stripe' AND t.payment_method = 'credit_card'
            THEN stripe_account.livemode
            ELSE NULL
        END AS stripe_livemode
`;

// =============================================================================
// Transaction CRUD
// =============================================================================

/**
 * List payment transactions with dynamic filters and pagination.
 *
 * @param {string}   companyId
 * @param {Object}   filters
 * @param {string}  [filters.status]
 * @param {string}  [filters.transactionType]
 * @param {string}  [filters.paymentMethod]
 * @param {string}  [filters.contactId]
 * @param {string}  [filters.invoiceId]
 * @param {string}  [filters.estimateId]
 * @param {string}  [filters.jobId]
 * @param {string}  [filters.search]          - reference_number, memo ILIKE
 * @param {string}  [filters.startDate]
 * @param {string}  [filters.endDate]
 * @param {number}  [filters.limit=50]
 * @param {number}  [filters.offset=0]
 * @returns {Promise<{rows: object[], total: number}>}
 */
async function listTransactions(companyId, filters = {}) {
    const {
        status,
        transactionType,
        paymentMethod,
        contactId,
        invoiceId,
        estimateId,
        jobId,
        externalSource,
        search,
        startDate,
        endDate,
        limit = 50,
        offset = 0,
    } = filters;

    const conditions = ['t.company_id = $1'];
    const params = [companyId];
    let idx = 1;

    if (status) {
        idx++;
        conditions.push(`t.status = $${idx}`);
        params.push(status);
    }
    if (transactionType) {
        idx++;
        conditions.push(`t.transaction_type = $${idx}`);
        params.push(transactionType);
    }
    if (paymentMethod) {
        idx++;
        conditions.push(`t.payment_method = $${idx}`);
        params.push(paymentMethod);
    }
    if (contactId) {
        idx++;
        conditions.push(`t.contact_id = $${idx}`);
        params.push(contactId);
    }
    if (invoiceId) {
        idx++;
        conditions.push(`t.invoice_id = $${idx}`);
        params.push(invoiceId);
    }
    if (estimateId) {
        idx++;
        conditions.push(`t.estimate_id = $${idx}`);
        params.push(estimateId);
    }
    if (jobId) {
        idx++;
        conditions.push(`t.job_id = $${idx}`);
        params.push(jobId);
    }
    if (externalSource === 'manual') {
        // "manual/offline" = locally recorded, not synced from an external processor.
        conditions.push(`(t.external_source IS NULL OR t.external_source IN ('', 'manual'))`);
    } else if (externalSource) {
        idx++;
        conditions.push(`t.external_source = $${idx}`);
        params.push(externalSource);
    }
    if (search) {
        idx++;
        conditions.push(`(t.reference_number ILIKE $${idx} OR t.memo ILIKE $${idx})`);
        params.push(`%${search}%`);
    }
    if (startDate) {
        idx++;
        conditions.push(`t.created_at >= $${idx}`);
        params.push(startDate);
    }
    if (endDate) {
        idx++;
        conditions.push(`t.created_at <= $${idx}`);
        params.push(endDate);
    }

    const where = conditions.join(' AND ');

    idx++;
    const limitIdx = idx;
    params.push(limit);

    idx++;
    const offsetIdx = idx;
    params.push(offset);

    const sql = `
        SELECT t.*, ${STRIPE_TRANSACTION_COLUMNS}, COUNT(*) OVER() AS _total
        FROM payment_transactions t
        ${STRIPE_TRANSACTION_JOINS}
        WHERE ${where}
        ORDER BY t.created_at DESC
        LIMIT $${limitIdx} OFFSET $${offsetIdx}
    `;

    const { rows } = await db.query(sql, params);

    const total = rows.length > 0 ? parseInt(rows[0]._total, 10) : 0;
    const cleaned = rows.map(({ _total, ...rest }) => rest);

    return { rows: cleaned, total };
}

/**
 * Get a single transaction by ID (scoped to company).
 */
async function getTransactionById(companyId, id) {
    const { rows } = await db.query(
        `SELECT t.*, ${STRIPE_TRANSACTION_COLUMNS}
         FROM payment_transactions t
         ${STRIPE_TRANSACTION_JOINS}
         WHERE t.company_id = $1 AND t.id = $2`,
        [companyId, id]
    );
    return rows[0] || null;
}

/**
 * Resolve a receipt action from the owned ledger row through its Stripe session
 * and customer/job fallbacks. The transaction company predicate is the security
 * boundary; every joined tenant table is pinned back to that owned row.
 */
async function getTransactionReceiptContext(companyId, id) {
    const { rows } = await db.query(
        `SELECT t.*,
                stripe_session.id AS stripe_session_id,
                stripe_session.stripe_payment_intent_id,
                stripe_session.stripe_charge_id,
                COALESCE(stripe_session.stripe_account_id, stripe_account.stripe_account_id)
                    AS stripe_account_id,
                stripe_account.livemode AS stripe_livemode,
                COALESCE(t.contact_id, stripe_session.contact_id, i.contact_id, j.contact_id)
                    AS receipt_contact_id,
                c.email AS receipt_contact_email,
                COALESCE(NULLIF(c.email, ''), NULLIF(j.customer_email, ''))
                    AS customer_email,
                COALESCE(NULLIF(c.full_name, ''), NULLIF(j.customer_name, ''))
                    AS customer_name,
                COALESCE(t.job_id, stripe_session.job_id, i.job_id)
                    AS receipt_job_id
         FROM payment_transactions t
         ${STRIPE_TRANSACTION_JOINS}
         LEFT JOIN invoices i
           ON i.id = COALESCE(t.invoice_id, stripe_session.invoice_id)
          AND i.company_id = t.company_id
         LEFT JOIN jobs j
           ON j.id = COALESCE(t.job_id, stripe_session.job_id, i.job_id)
          AND j.company_id = t.company_id
         LEFT JOIN contacts c
           ON c.id = COALESCE(t.contact_id, stripe_session.contact_id, i.contact_id, j.contact_id)
          AND c.company_id = t.company_id
         WHERE t.company_id = $1 AND t.id = $2`,
        [companyId, id]
    );
    return rows[0] || null;
}

/**
 * Create a new payment transaction.
 */
async function createTransaction(companyId, data) {
    const {
        contact_id,
        estimate_id,
        invoice_id,
        job_id,
        transaction_type,
        payment_method,
        status = 'completed',
        amount,
        currency = 'USD',
        reference_number,
        external_id,
        external_source,
        memo,
        metadata = {},
        processed_at,
        recorded_by,
    } = data;

    const { rows } = await db.query(
        `INSERT INTO payment_transactions (
            company_id, contact_id, estimate_id, invoice_id, job_id,
            transaction_type, payment_method, status,
            amount, currency, reference_number,
            external_id, external_source, memo, metadata,
            processed_at, recorded_by
        ) VALUES (
            $1, $2, $3, $4, $5,
            $6, $7, $8,
            $9, $10, $11,
            $12, $13, $14, $15,
            $16, $17
        ) RETURNING *`,
        [
            companyId, contact_id || null, estimate_id || null, invoice_id || null, job_id || null,
            transaction_type, payment_method, status,
            amount, currency, reference_number || null,
            external_id || null, external_source || null, memo || null, JSON.stringify(metadata),
            processed_at || null, recorded_by || null,
        ]
    );

    return rows[0];
}

/**
 * Idempotency lookup: find an existing transaction by external source + id, scoped
 * to the company. Used by the Stripe webhook sync to avoid duplicate ledger rows.
 */
async function findByExternalSourceId(companyId, externalSource, externalId) {
    if (!externalId) return null;
    const { rows } = await db.query(
        `SELECT * FROM payment_transactions
         WHERE company_id = $1 AND external_source = $2 AND external_id = $3
         LIMIT 1`,
        [companyId, externalSource, externalId]
    );
    return rows[0] || null;
}

/**
 * Update transaction status with optional extra sets (e.g. processed_at=NOW()).
 */
async function updateTransactionStatus(id, companyId, status, extraSets = {}) {
    const setClauses = ['status = $3'];
    const params = [id, companyId, status];
    let idx = 3;

    for (const [col, val] of Object.entries(extraSets)) {
        idx++;
        // Whitelist columns to prevent SQL injection
        const allowedCols = ['processed_at', 'memo', 'reference_number', 'metadata'];
        if (!allowedCols.includes(col)) continue;
        setClauses.push(`${col} = $${idx}`);
        params.push(val);
    }

    const sql = `
        UPDATE payment_transactions
        SET ${setClauses.join(', ')}
        WHERE id = $1 AND company_id = $2
        RETURNING *
    `;

    const { rows } = await db.query(sql, params);
    return rows[0] || null;
}

/**
 * Void a transaction (only if not already voided/refunded).
 */
async function voidTransaction(id, companyId, voidedBy) {
    const { rows } = await db.query(
        `UPDATE payment_transactions
         SET status = 'voided',
             voided_at = NOW(),
             voided_by = $3,
             updated_at = NOW()
         WHERE id = $1 AND company_id = $2 AND status NOT IN ('voided', 'refunded')
         RETURNING *`,
        [id, companyId, voidedBy]
    );
    return rows[0] || null;
}

/**
 * Create a refund transaction linked to the original.
 * Also updates the original transaction status to 'refunded'.
 */
async function createRefundTransaction(companyId, originalTxId, amount, recordedBy) {
    // Fetch original
    const { rows: origRows } = await db.query(
        `SELECT * FROM payment_transactions WHERE id = $1 AND company_id = $2`,
        [originalTxId, companyId]
    );
    const original = origRows[0];
    if (!original) return null;

    // Insert refund transaction
    const { rows: refundRows } = await db.query(
        `INSERT INTO payment_transactions (
            company_id, contact_id, estimate_id, invoice_id, job_id,
            transaction_type, payment_method, status,
            amount, currency, reference_number,
            memo, metadata, processed_at, recorded_by
        ) VALUES (
            $1, $2, $3, $4, $5,
            'refund', $6, 'completed',
            $7, $8, $9,
            $10, $11, NOW(), $12
        ) RETURNING *`,
        [
            companyId, original.contact_id, original.estimate_id, original.invoice_id, original.job_id,
            original.payment_method,
            -Math.abs(amount), original.currency, original.reference_number,
            `Refund for transaction #${originalTxId}`,
            JSON.stringify({ original_transaction_id: originalTxId }),
            recordedBy,
        ]
    );

    // Update original status to 'refunded'
    await db.query(
        `UPDATE payment_transactions SET status = 'refunded', updated_at = NOW() WHERE id = $1`,
        [originalTxId]
    );

    return refundRows[0];
}

// =============================================================================
// Receipts
// =============================================================================

/**
 * Get receipt for a transaction.
 */
async function getReceipt(transactionId) {
    const { rows } = await db.query(
        `SELECT * FROM payment_receipts WHERE transaction_id = $1`,
        [transactionId]
    );
    return rows[0] || null;
}

/**
 * Create a receipt with auto-generated receipt_number (REC-YYYYMMDD-NNN).
 */
async function createReceipt(transactionId, data) {
    const { sent_to_email, sent_to_phone, sent_via } = data;

    // Generate receipt number: REC-YYYYMMDD-NNN
    const today = new Date();
    const dateStr = today.toISOString().slice(0, 10).replace(/-/g, '');

    const { rows: countRows } = await db.query(
        `SELECT COUNT(*) AS cnt FROM payment_receipts
         WHERE receipt_number LIKE $1`,
        [`REC-${dateStr}-%`]
    );
    const seq = parseInt(countRows[0].cnt, 10) + 1;
    const receiptNumber = `REC-${dateStr}-${String(seq).padStart(3, '0')}`;

    const { rows } = await db.query(
        `INSERT INTO payment_receipts (
            transaction_id, receipt_number,
            sent_to_email, sent_to_phone, sent_via, sent_at
        ) VALUES ($1, $2, $3, $4, $5, NOW())
        RETURNING *`,
        [
            transactionId, receiptNumber,
            sent_to_email || null, sent_to_phone || null, sent_via || null,
        ]
    );

    return rows[0];
}

// =============================================================================
// Invoice-related queries
// =============================================================================

/**
 * Get one transaction linked to an invoice, with both IDs scoped to company.
 */
async function getTransactionForInvoice(companyId, invoiceId, paymentId) {
    const { rows } = await db.query(
        `SELECT *
         FROM payment_transactions
         WHERE company_id = $1
           AND invoice_id = $2
           AND id = $3`,
        [companyId, invoiceId, paymentId]
    );
    return rows[0] || null;
}

/**
 * Atomically void a completed invoice payment and reverse only that payment's
 * contribution to the materialized invoice totals.
 */
async function voidInvoicePayment(companyId, invoiceId, paymentId, voidedBy) {
    const { rows } = await db.query(
        `WITH candidate AS MATERIALIZED (
            SELECT pt.*
            FROM payment_transactions pt
            WHERE pt.company_id = $1
              AND pt.invoice_id = $2
              AND pt.id = $3
            FOR UPDATE
        ),
        voided_payment AS (
            UPDATE payment_transactions pt
            SET status = 'voided',
                voided_at = NOW(),
                voided_by = $4,
                updated_at = NOW()
            FROM candidate c
            WHERE pt.id = c.id
              AND pt.company_id = $1
              AND pt.invoice_id = $2
              AND pt.transaction_type = 'payment'
              AND pt.status = 'completed'
              AND pt.voided_at IS NULL
            RETURNING pt.*
        ),
        updated_invoice AS (
            UPDATE invoices i
            SET amount_paid = GREATEST(
                    COALESCE(i.amount_paid, 0) - ABS(v.amount),
                    0
                ),
                balance_due = COALESCE(i.total, 0) - GREATEST(
                    COALESCE(i.amount_paid, 0) - ABS(v.amount),
                    0
                ),
                status = CASE
                    WHEN i.status IN ('void', 'refunded') THEN i.status
                    WHEN COALESCE(i.total, 0) - GREATEST(
                        COALESCE(i.amount_paid, 0) - ABS(v.amount),
                        0
                    ) <= 0 THEN 'paid'
                    WHEN GREATEST(
                        COALESCE(i.amount_paid, 0) - ABS(v.amount),
                        0
                    ) > 0 THEN 'partial'
                    ELSE 'sent'
                END,
                paid_at = CASE
                    WHEN COALESCE(i.total, 0) - GREATEST(
                        COALESCE(i.amount_paid, 0) - ABS(v.amount),
                        0
                    ) <= 0 THEN COALESCE(i.paid_at, NOW())
                    ELSE NULL
                END,
                updated_at = NOW()
            FROM voided_payment v
            WHERE i.id = $2
              AND i.company_id = $1
            RETURNING i.*
        )
        SELECT
            EXISTS (SELECT 1 FROM voided_payment) AS did_void,
            EXISTS (SELECT 1 FROM updated_invoice) AS invoice_updated
        FROM candidate`,
        [companyId, invoiceId, paymentId, voidedBy]
    );
    return rows[0] || null;
}

/**
 * Get all transactions linked to an invoice, scoped to company. Voided rows
 * remain visible but sort after active payments.
 */
async function getTransactionsForInvoice(companyId, invoiceId) {
    const { rows } = await db.query(
        `SELECT pt.*,
                COALESCE(pt.processed_at, pt.created_at) AS transaction_date
         FROM payment_transactions pt
         WHERE pt.company_id = $1
           AND pt.invoice_id = $2
         ORDER BY (pt.voided_at IS NOT NULL) ASC,
                  COALESCE(pt.processed_at, pt.created_at) DESC,
                  pt.id DESC`,
        [companyId, invoiceId]
    );
    return rows;
}

// =============================================================================
// Aggregate summary
// =============================================================================

/**
 * Get transaction summary aggregates for a company.
 */
async function getTransactionSummary(companyId, filters = {}) {
    const { startDate, endDate } = filters;

    const conditions = ['company_id = $1', 'voided_at IS NULL'];
    const params = [companyId];
    let idx = 1;

    if (startDate) {
        idx++;
        conditions.push(`created_at >= $${idx}`);
        params.push(startDate);
    }
    if (endDate) {
        idx++;
        conditions.push(`created_at <= $${idx}`);
        params.push(endDate);
    }

    const where = conditions.join(' AND ');

    const { rows } = await db.query(`
        SELECT
            COALESCE(SUM(CASE WHEN transaction_type = 'payment' AND status = 'completed' THEN amount ELSE 0 END), 0) AS total_collected,
            COALESCE(SUM(CASE WHEN transaction_type = 'refund' AND status = 'completed' THEN ABS(amount) ELSE 0 END), 0) AS total_refunded,
            COALESCE(SUM(CASE WHEN status = 'pending' THEN amount ELSE 0 END), 0) AS total_pending,
            COALESCE(
                SUM(CASE WHEN transaction_type = 'payment' AND status = 'completed' THEN amount ELSE 0 END) -
                SUM(CASE WHEN transaction_type = 'refund' AND status = 'completed' THEN ABS(amount) ELSE 0 END),
            0) AS net_amount
        FROM payment_transactions
        WHERE ${where}
    `, params);

    return {
        total_collected: parseFloat(rows[0].total_collected),
        total_refunded: parseFloat(rows[0].total_refunded),
        total_pending: parseFloat(rows[0].total_pending),
        net_amount: parseFloat(rows[0].net_amount),
    };
}

// =============================================================================
// Exports
// =============================================================================

module.exports = {
    listTransactions,
    getTransactionById,
    getTransactionReceiptContext,
    createTransaction,
    findByExternalSourceId,
    updateTransactionStatus,
    voidTransaction,
    getTransactionForInvoice,
    voidInvoicePayment,
    createRefundTransaction,
    getReceipt,
    createReceipt,
    getTransactionsForInvoice,
    getTransactionSummary,
};
