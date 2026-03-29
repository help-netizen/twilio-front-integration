/**
 * Payments Service
 * PF004 Payment Collection MVP — Sprint 5
 *
 * Business logic for payment transactions, refunds, voids, and receipts.
 * Operates on the canonical payment_transactions / payment_receipts tables.
 *
 * NOTE: The legacy Zenbooker sync helpers (syncPayments, listPayments, etc.)
 * that previously lived here have been relocated to
 * services/zenbookerPaymentsSyncService.js to avoid confusion.
 */

const paymentsQueries = require('../db/paymentsQueries');
const invoicesQueries = require('../db/invoicesQueries');

// =============================================================================
// Error class
// =============================================================================

class PaymentsServiceError extends Error {
    constructor(code, message, httpStatus = 500) {
        super(message);
        this.name = 'PaymentsServiceError';
        this.code = code;
        this.httpStatus = httpStatus;
    }
}

// =============================================================================
// Constants
// =============================================================================

const VALID_TRANSACTION_TYPES = ['payment', 'adjustment'];
const VALID_PAYMENT_METHODS = ['credit_card', 'ach', 'check', 'cash', 'other', 'zenbooker_sync'];
const MANUAL_PAYMENT_METHODS = ['cash', 'check', 'other'];

// =============================================================================
// Transaction CRUD
// =============================================================================

/**
 * List transactions with filters.
 */
async function listTransactions(companyId, filters = {}) {
    return paymentsQueries.listTransactions(companyId, filters);
}

/**
 * Get a single transaction, throws NOT_FOUND if missing.
 */
async function getTransaction(companyId, id) {
    const tx = await paymentsQueries.getTransactionById(companyId, id);
    if (!tx) {
        throw new PaymentsServiceError('NOT_FOUND', `Transaction ${id} not found`, 404);
    }
    return tx;
}

/**
 * Create a payment transaction.
 * Validates amount, transaction_type, payment_method.
 * If invoice_id is provided, also records payment on the invoice.
 */
async function createTransaction(companyId, userId, data) {
    const { amount, transaction_type, payment_method, invoice_id } = data;

    // Validation
    if (!amount || parseFloat(amount) <= 0) {
        throw new PaymentsServiceError('VALIDATION', 'amount must be greater than 0', 400);
    }
    if (!VALID_TRANSACTION_TYPES.includes(transaction_type)) {
        throw new PaymentsServiceError('VALIDATION', `transaction_type must be one of: ${VALID_TRANSACTION_TYPES.join(', ')}`, 400);
    }
    if (!VALID_PAYMENT_METHODS.includes(payment_method)) {
        throw new PaymentsServiceError('VALIDATION', `payment_method must be one of: ${VALID_PAYMENT_METHODS.join(', ')}`, 400);
    }

    const tx = await paymentsQueries.createTransaction(companyId, {
        ...data,
        status: 'completed',
        processed_at: new Date().toISOString(),
        recorded_by: userId,
    });

    // If linked to an invoice, update invoice amount_paid / balance_due
    if (invoice_id) {
        try {
            await invoicesQueries.recordPayment(invoice_id, companyId, parseFloat(amount));
        } catch (err) {
            console.warn(`[PaymentsService] Could not update invoice ${invoice_id} amount_paid:`, err.message);
        }
    }

    return tx;
}

/**
 * Record a manual/offline payment (cash, check, other).
 */
async function recordManualPayment(companyId, userId, data) {
    const { payment_method } = data;

    if (!MANUAL_PAYMENT_METHODS.includes(payment_method)) {
        throw new PaymentsServiceError('VALIDATION', `Manual payment_method must be one of: ${MANUAL_PAYMENT_METHODS.join(', ')}`, 400);
    }

    const memo = data.memo
        ? `Manual payment recorded — ${data.memo}`
        : 'Manual payment recorded';

    return createTransaction(companyId, userId, {
        ...data,
        transaction_type: 'payment',
        memo,
    });
}

// =============================================================================
// Refund / Void
// =============================================================================

/**
 * Refund a completed transaction.
 * Validates original exists, is completed, amount does not exceed original.
 * If linked to an invoice, reverses the amount_paid on the invoice.
 */
async function refundTransaction(companyId, userId, id, { amount, reason } = {}) {
    const original = await getTransaction(companyId, id);

    if (original.status !== 'completed') {
        throw new PaymentsServiceError('INVALID_STATUS', `Cannot refund transaction with status '${original.status}'. Only completed transactions can be refunded.`, 400);
    }

    const refundAmount = amount != null ? parseFloat(amount) : parseFloat(original.amount);
    if (refundAmount <= 0) {
        throw new PaymentsServiceError('VALIDATION', 'Refund amount must be greater than 0', 400);
    }
    if (refundAmount > parseFloat(original.amount)) {
        throw new PaymentsServiceError('VALIDATION', `Refund amount (${refundAmount}) exceeds original transaction amount (${original.amount})`, 400);
    }

    const refundTx = await paymentsQueries.createRefundTransaction(companyId, id, refundAmount, userId);

    // If linked to an invoice, reverse the amount_paid
    if (original.invoice_id) {
        try {
            await invoicesQueries.recordPayment(original.invoice_id, companyId, -refundAmount);
        } catch (err) {
            console.warn(`[PaymentsService] Could not reverse invoice ${original.invoice_id} amount_paid:`, err.message);
        }
    }

    return refundTx;
}

/**
 * Void a transaction. Only valid for pending/completed transactions.
 * If linked to an invoice, reverses the amount_paid on the invoice.
 */
async function voidTransaction(companyId, userId, id) {
    const original = await getTransaction(companyId, id);

    if (['voided', 'refunded'].includes(original.status)) {
        throw new PaymentsServiceError('INVALID_STATUS', `Cannot void transaction with status '${original.status}'`, 400);
    }

    const voided = await paymentsQueries.voidTransaction(id, companyId);
    if (!voided) {
        throw new PaymentsServiceError('VOID_FAILED', 'Could not void transaction', 500);
    }

    // If linked to an invoice and was completed, reverse the amount_paid
    if (original.invoice_id && original.status === 'completed') {
        try {
            await invoicesQueries.recordPayment(original.invoice_id, companyId, -parseFloat(original.amount));
        } catch (err) {
            console.warn(`[PaymentsService] Could not reverse invoice ${original.invoice_id} amount_paid:`, err.message);
        }
    }

    return voided;
}

// =============================================================================
// Receipts
// =============================================================================

/**
 * Get receipt for a transaction (validates company scope first).
 */
async function getReceipt(companyId, transactionId) {
    // Validate tx belongs to company
    await getTransaction(companyId, transactionId);
    const receipt = await paymentsQueries.getReceipt(transactionId);
    return receipt;
}

/**
 * Send/create a receipt for a transaction (MVP: creates record, no actual sending).
 */
async function sendReceipt(companyId, userId, transactionId, { channel, recipient } = {}) {
    // Validate tx belongs to company
    await getTransaction(companyId, transactionId);

    if (!channel || !['email', 'sms', 'portal'].includes(channel)) {
        throw new PaymentsServiceError('VALIDATION', 'channel must be one of: email, sms, portal', 400);
    }
    if (!recipient) {
        throw new PaymentsServiceError('VALIDATION', 'recipient is required', 400);
    }

    const receiptData = {
        sent_via: channel,
    };
    if (channel === 'email') {
        receiptData.sent_to_email = recipient;
    } else if (channel === 'sms') {
        receiptData.sent_to_phone = recipient;
    }

    const receipt = await paymentsQueries.createReceipt(transactionId, receiptData);
    return receipt;
}

// =============================================================================
// Invoice-related
// =============================================================================

/**
 * Get all transactions for an invoice (validates invoice belongs to company).
 */
async function getTransactionsForInvoice(companyId, invoiceId) {
    // Validate invoice belongs to company
    const invoice = await invoicesQueries.getInvoiceById(companyId, invoiceId);
    if (!invoice) {
        throw new PaymentsServiceError('NOT_FOUND', `Invoice ${invoiceId} not found`, 404);
    }
    return paymentsQueries.getTransactionsForInvoice(invoiceId);
}

// =============================================================================
// Summary
// =============================================================================

/**
 * Get aggregate transaction summary for a company.
 */
async function getSummary(companyId, filters = {}) {
    return paymentsQueries.getTransactionSummary(companyId, filters);
}

// =============================================================================
// Exports
// =============================================================================

module.exports = {
    PaymentsServiceError,
    listTransactions,
    getTransaction,
    createTransaction,
    recordManualPayment,
    refundTransaction,
    voidTransaction,
    getReceipt,
    sendReceipt,
    getTransactionsForInvoice,
    getSummary,
};
