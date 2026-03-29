/**
 * Payments Queries Module
 * PF004 Payment Collection MVP — Sprint 5
 *
 * Database queries for payment_transactions and payment_receipts.
 */
const db = require('./connection');

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
        SELECT t.*, COUNT(*) OVER() AS _total
        FROM payment_transactions t
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
        `SELECT * FROM payment_transactions WHERE id = $1 AND company_id = $2`,
        [id, companyId]
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
async function voidTransaction(id, companyId) {
    const { rows } = await db.query(
        `UPDATE payment_transactions
         SET status = 'voided', updated_at = NOW()
         WHERE id = $1 AND company_id = $2 AND status NOT IN ('voided', 'refunded')
         RETURNING *`,
        [id, companyId]
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
 * Get all transactions linked to an invoice.
 */
async function getTransactionsForInvoice(invoiceId) {
    const { rows } = await db.query(
        `SELECT * FROM payment_transactions WHERE invoice_id = $1 ORDER BY created_at DESC`,
        [invoiceId]
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

    const conditions = ['company_id = $1'];
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
    createTransaction,
    updateTransactionStatus,
    voidTransaction,
    createRefundTransaction,
    getReceipt,
    createReceipt,
    getTransactionsForInvoice,
    getTransactionSummary,
};
