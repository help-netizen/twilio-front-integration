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
const estimatesQueries = require('../db/estimatesQueries');
const { logFinancialActivity } = require('./financialActivityService');

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
const MANUAL_PAYMENT_METHODS = ['credit_card', 'ach', 'check', 'cash', 'other'];

function normalizeManualPaymentMethod(paymentMethod) {
    return paymentMethod === 'card' ? 'credit_card' : paymentMethod;
}

function isManualOrigin(transaction) {
    const source = String(transaction?.external_source || '').trim().toLowerCase();
    return source === '' || source === 'manual';
}

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
async function getTransaction(companyId, id, client = null) {
    const tx = await paymentsQueries.getTransactionById(companyId, id, client);
    if (!tx) {
        throw new PaymentsServiceError('NOT_FOUND', `Transaction ${id} not found`, 404);
    }
    return tx;
}

async function validateRelatedEntities(companyId, data, client = null) {
    if (data.contact_id != null) {
        const contact = await estimatesQueries.getContactContext(
            companyId,
            data.contact_id,
            client
        );
        if (!contact) throw new PaymentsServiceError('NOT_FOUND', 'Contact not found', 404);
    }
    if (data.estimate_id != null) {
        const estimate = await estimatesQueries.getEstimateById(
            companyId,
            data.estimate_id,
            client
        );
        if (!estimate) throw new PaymentsServiceError('NOT_FOUND', 'Estimate not found', 404);
    }
    if (data.invoice_id != null) {
        const invoice = await invoicesQueries.getInvoiceById(
            companyId,
            data.invoice_id,
            client
        );
        if (!invoice) throw new PaymentsServiceError('NOT_FOUND', 'Invoice not found', 404);
    }
    if (data.job_id != null) {
        const job = await estimatesQueries.getJobContext(companyId, data.job_id, client);
        if (!job) throw new PaymentsServiceError('NOT_FOUND', 'Job not found', 404);
    }
}

/**
 * Create a payment transaction.
 * Validates amount, transaction_type, payment_method.
 * If invoice_id is provided, also records payment on the invoice.
 */
async function createTransaction(
    companyId,
    userId,
    data,
    client = null,
    activityActor = null,
    {
        action = 'payment.recorded',
        invoiceAction = 'invoice.payment_recorded',
    } = {}
) {
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
    await validateRelatedEntities(companyId, data, client);

    const tx = await paymentsQueries.createTransaction(companyId, {
        ...data,
        status: 'completed',
        processed_at: data.processed_at || new Date().toISOString(),
        recorded_by: userId,
    }, client);

    // If linked to an invoice, update invoice amount_paid / balance_due
    if (invoice_id) {
        const updated = await invoicesQueries.recordPayment(
            invoice_id,
            companyId,
            parseFloat(amount),
            client
        );
        if (!updated) {
            throw new PaymentsServiceError('NOT_FOUND', 'Invoice not found', 404);
        }
    }
    if (activityActor) {
        await logFinancialActivity({
            companyId,
            entityType: 'payment',
            action,
            entity: tx,
            actor: activityActor,
            summary: {
                amount: Number(amount),
                currency: tx.currency || data.currency || 'USD',
                status: tx.status,
            },
        }, { client });
        if (invoice_id && invoiceAction) {
            const invoice = await invoicesQueries.getInvoiceById(companyId, invoice_id, client);
            await logFinancialActivity({
                companyId,
                entityType: 'invoice',
                action: invoiceAction,
                entity: invoice,
                actor: activityActor,
                summary: {
                    payment_id: tx.id,
                    amount: Number(amount),
                    currency: tx.currency || data.currency || 'USD',
                },
            }, { client });
        }
    }

    return tx;
}

/**
 * Record a manual/offline payment.
 */
async function recordManualPayment(
    companyId,
    userId,
    data,
    client = null,
    activityActor = null,
    activityOptions = {}
) {
    const paymentMethod = normalizeManualPaymentMethod(data.payment_method);

    if (!MANUAL_PAYMENT_METHODS.includes(paymentMethod)) {
        throw new PaymentsServiceError('VALIDATION', `Manual payment_method must be one of: ${MANUAL_PAYMENT_METHODS.join(', ')}`, 400);
    }

    const memo = data.memo
        ? `Manual payment recorded — ${data.memo}`
        : 'Manual payment recorded';

    return createTransaction(
        companyId,
        userId,
        {
            ...data,
            payment_method: paymentMethod,
            transaction_type: 'payment',
            external_source: 'manual',
            memo,
        },
        client,
        activityActor,
        activityOptions
    );
}

// =============================================================================
// Refund / Void
// =============================================================================

/**
 * Refund a completed transaction.
 * Validates original exists, is completed, amount does not exceed original.
 * If linked to an invoice, reverses the amount_paid on the invoice.
 */
async function refundTransaction(
    companyId,
    userId,
    id,
    { amount, reason } = {},
    client = null,
    activityActor = null
) {
    const original = await getTransaction(companyId, id, client);

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

    const refundTx = await paymentsQueries.createRefundTransaction(
        companyId,
        id,
        refundAmount,
        userId,
        client
    );

    // If linked to an invoice, reverse the amount_paid
    if (original.invoice_id) {
        const updated = await invoicesQueries.recordPayment(
            original.invoice_id,
            companyId,
            -refundAmount,
            client
        );
        if (!updated) {
            throw new PaymentsServiceError('NOT_FOUND', 'Invoice not found', 404);
        }
    }
    if (activityActor) {
        await logFinancialActivity({
            companyId,
            entityType: 'payment',
            action: 'payment.refunded',
            entity: original,
            actor: activityActor,
            summary: {
                amount: refundAmount,
                currency: original.currency,
                payment_id: refundTx.id,
            },
        }, { client });
        if (original.invoice_id) {
            const invoice = await invoicesQueries.getInvoiceById(
                companyId,
                original.invoice_id,
                client
            );
            await logFinancialActivity({
                companyId,
                entityType: 'invoice',
                action: 'invoice.refunded',
                entity: invoice,
                actor: activityActor,
                summary: {
                    payment_id: original.id,
                    amount: refundAmount,
                    currency: original.currency,
                },
            }, { client });
        }
    }

    return refundTx;
}

/**
 * Void a transaction. Only valid for pending/completed transactions.
 * If linked to an invoice, reverses the amount_paid on the invoice.
 */
async function voidTransaction(
    companyId,
    userId,
    id,
    client = null,
    activityActor = null
) {
    const original = await getTransaction(companyId, id, client);

    if (!isManualOrigin(original)) {
        throw new PaymentsServiceError(
            'EXTERNAL_PAYMENT_NOT_VOIDABLE',
            'Stripe- and Zenbooker-sourced payments cannot be voided as manual payments.',
            409
        );
    }

    if (original.invoice_id) {
        const result = await voidInvoicePayment(
            companyId,
            userId,
            original.invoice_id,
            id,
            client,
            activityActor
        );
        return result.payment;
    }

    if (original.status === 'voided' || original.voided_at) {
        return original;
    }
    if (original.status === 'refunded') {
        throw new PaymentsServiceError('INVALID_STATUS', `Cannot void transaction with status '${original.status}'`, 400);
    }

    const voided = await paymentsQueries.voidTransaction(id, companyId, userId, client);
    if (!voided) {
        throw new PaymentsServiceError('VOID_FAILED', 'Could not void transaction', 500);
    }
    if (activityActor) {
        await logFinancialActivity({
            companyId,
            entityType: 'payment',
            action: 'payment.voided',
            entity: voided,
            actor: activityActor,
            summary: { status: 'voided' },
        }, { client });
    }

    return voided;
}

/**
 * Void a manual/offline payment linked to one invoice. Both resource IDs are
 * resolved inside the active company before the atomic ledger/invoice write.
 * Repeating the request returns 200 data with idempotent=true and writes no
 * second audit event.
 */
async function voidInvoicePayment(
    companyId,
    userId,
    invoiceId,
    paymentId,
    client = null,
    activityActor = null
) {
    if (!userId) {
        throw new PaymentsServiceError(
            'CRM_ACTOR_REQUIRED',
            'A CRM user is required to void an invoice payment.',
            401
        );
    }

    const invoice = await invoicesQueries.getInvoiceById(companyId, invoiceId, client);
    if (!invoice) {
        throw new PaymentsServiceError('NOT_FOUND', `Invoice ${invoiceId} not found`, 404);
    }

    const payment = await paymentsQueries.getTransactionForInvoice(
        companyId,
        invoiceId,
        paymentId,
        client
    );
    if (!payment) {
        throw new PaymentsServiceError('NOT_FOUND', `Payment ${paymentId} not found`, 404);
    }

    // Source is authoritative. A row that looks like cash/check but came from
    // Zenbooker (or Stripe) is external and must not cross the manual void path.
    if (!isManualOrigin(payment)) {
        throw new PaymentsServiceError(
            'EXTERNAL_PAYMENT_NOT_VOIDABLE',
            'Stripe- and Zenbooker-sourced payments cannot be voided as manual payments.',
            409
        );
    }

    if (payment.status === 'voided' || payment.voided_at) {
        return { payment, invoice, idempotent: true };
    }
    if (payment.transaction_type !== 'payment' || payment.status !== 'completed') {
        throw new PaymentsServiceError(
            'INVALID_STATUS',
            `Cannot void a '${payment.status}' ${payment.transaction_type}.`,
            409
        );
    }

    const mutation = await paymentsQueries.voidInvoicePayment(
        companyId,
        invoiceId,
        paymentId,
        userId,
        client
    );
    if (!mutation) {
        throw new PaymentsServiceError('NOT_FOUND', `Payment ${paymentId} not found`, 404);
    }
    if (mutation.did_void && !mutation.invoice_updated) {
        throw new PaymentsServiceError(
            'VOID_FAILED',
            'Payment was not applied to the tenant-scoped invoice.',
            500
        );
    }

    const currentPayment = await paymentsQueries.getTransactionForInvoice(
        companyId,
        invoiceId,
        paymentId,
        client
    );
    const currentInvoice = await invoicesQueries.getInvoiceById(
        companyId,
        invoiceId,
        client
    );
    if (!currentPayment || !currentInvoice) {
        throw new PaymentsServiceError('NOT_FOUND', `Payment ${paymentId} not found`, 404);
    }

    if (!mutation.did_void) {
        return {
            payment: currentPayment,
            invoice: currentInvoice,
            idempotent: true,
        };
    }

    if (activityActor) {
        await logFinancialActivity({
            companyId,
            entityType: 'payment',
            action: 'payment.voided',
            entity: currentPayment,
            actor: activityActor,
            summary: {
                status: 'voided',
                amount: Number(payment.amount),
                currency: payment.currency,
            },
        }, { client });
        await logFinancialActivity({
            companyId,
            entityType: 'invoice',
            action: 'invoice.payment_voided',
            entity: currentInvoice,
            actor: activityActor,
            summary: {
                payment_id: paymentId,
                amount: Number(payment.amount),
                currency: payment.currency,
            },
        }, { client });
    }

    return {
        payment: currentPayment,
        invoice: currentInvoice,
        idempotent: false,
    };
}

// =============================================================================
// Receipts
// =============================================================================

/**
 * Get receipt for a transaction (validates company scope first).
 */
async function getReceipt(companyId, transactionId, client = null) {
    // Validate tx belongs to company
    await getTransaction(companyId, transactionId, client);
    const receipt = await paymentsQueries.getReceipt(companyId, transactionId, client);
    return receipt;
}

const RECEIPT_EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function isStripeCardPayment(transaction) {
    return transaction?.external_source === 'stripe'
        && transaction?.payment_method === 'credit_card';
}

function normalizeReceiptEmail(value, { required = false } = {}) {
    const email = typeof value === 'string' ? value.trim().toLowerCase() : '';
    if (!email && required) {
        throw new PaymentsServiceError('NO_EMAIL', 'No customer email is available for this payment', 422);
    }
    if (!email || email.length > 254 || !RECEIPT_EMAIL_SHAPE.test(email)) {
        throw new PaymentsServiceError('INVALID_EMAIL', 'Enter a valid customer email', 400);
    }
    return email;
}

function assertReceiptTransaction(context, transactionId) {
    if (!context) {
        throw new PaymentsServiceError('NOT_FOUND', `Transaction ${transactionId} not found`, 404);
    }
    if (context.transaction_type !== 'payment' || context.status !== 'completed') {
        throw new PaymentsServiceError(
            'RECEIPT_UNAVAILABLE',
            'A receipt is available only for a completed payment',
            409
        );
    }
}

function receiptViewModel(context) {
    return {
        transaction_id: context.id,
        amount: context.amount,
        currency: context.currency,
        payment_method: context.payment_method,
        processed_at: context.processed_at,
        created_at: context.created_at,
        reference_number: context.reference_number,
        customer_name: context.customer_name || null,
        job_id: context.receipt_job_id || context.job_id || null,
    };
}

async function resolveStripeCharge(context) {
    const provider = require('./stripeConnectProvider');
    const accountId = context.stripe_account_id;
    let chargeId = context.stripe_charge_id
        || (String(context.external_id || '').startsWith('ch_') ? context.external_id : null);
    const paymentIntentId = context.stripe_payment_intent_id
        || context.metadata?.payment_intent_id
        || (String(context.external_id || '').startsWith('pi_') ? context.external_id : null);

    if (!accountId || (!chargeId && !paymentIntentId)) {
        throw new PaymentsServiceError(
            'STRIPE_RECEIPT_UNAVAILABLE',
            'Stripe receipt details are unavailable for this payment',
            409
        );
    }

    if (!chargeId) {
        const paymentIntent = await provider.retrievePaymentIntent(accountId, paymentIntentId);
        if (paymentIntent.status !== 'succeeded') {
            throw new PaymentsServiceError(
                'PAYMENT_NOT_SUCCEEDED',
                'Payment has not succeeded',
                409
            );
        }
        chargeId = typeof paymentIntent.latest_charge === 'string'
            ? paymentIntent.latest_charge
            : paymentIntent.latest_charge?.id;
    }
    if (!chargeId) {
        throw new PaymentsServiceError(
            'STRIPE_RECEIPT_UNAVAILABLE',
            'Stripe receipt details are unavailable for this payment',
            409
        );
    }
    return { provider, accountId, chargeId };
}

/**
 * Return the actionable receipt target for one owned transaction. Stripe card
 * payments resolve to Stripe's hosted receipt; recorded payments return a
 * normalized receipt model for the authenticated frontend to present.
 */
async function getTransactionReceiptView(companyId, transactionId) {
    const context = await paymentsQueries.getTransactionReceiptContext(companyId, transactionId);
    assertReceiptTransaction(context, transactionId);

    const receipt = receiptViewModel(context);
    if (!isStripeCardPayment(context)) {
        return {
            receipt_type: 'recorded',
            receipt_url: null,
            receipt,
        };
    }

    const { provider, accountId, chargeId } = await resolveStripeCharge(context);
    const charge = await provider.retrieveCharge(accountId, chargeId);
    if (!charge?.receipt_url) {
        throw new PaymentsServiceError(
            'STRIPE_RECEIPT_UNAVAILABLE',
            'Stripe receipt details are unavailable for this payment',
            409
        );
    }
    return {
        receipt_type: 'stripe',
        receipt_url: charge.receipt_url,
        receipt,
    };
}

function escapeReceiptHtml(value) {
    return String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');
}

function recordedReceiptEmailBody(context) {
    const amount = new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: context.currency || 'USD',
    }).format(Number(context.amount || 0));
    const dateValue = context.processed_at || context.created_at;
    const date = dateValue
        ? new Date(dateValue).toLocaleDateString('en-US', {
            year: 'numeric',
            month: 'long',
            day: 'numeric',
            timeZone: 'UTC',
        })
        : '';
    const reference = context.reference_number
        ? `<p><strong>Reference:</strong> ${escapeReceiptHtml(context.reference_number)}</p>`
        : '';
    const greeting = context.customer_name
        ? `<p>Hello ${escapeReceiptHtml(context.customer_name)},</p>`
        : '';

    return `${greeting}<p>Thank you. We received your payment.</p>`
        + `<p><strong>Amount:</strong> ${escapeReceiptHtml(amount)}</p>`
        + `<p><strong>Date:</strong> ${escapeReceiptHtml(date)}</p>`
        + `<p><strong>Method:</strong> ${escapeReceiptHtml(context.payment_method)}</p>`
        + reference;
}

async function sendRecordedReceiptEmail(companyId, actor, context, email) {
    const emailMailboxService = require('./emailMailboxService');
    const mailbox = await emailMailboxService.getMailboxStatus(companyId);
    if (!mailbox || mailbox.status !== 'connected') {
        throw new PaymentsServiceError(
            'MAILBOX_NOT_CONNECTED',
            'Connect Google Email to send.',
            409
        );
    }

    let companyName = '';
    try {
        const companyQueries = require('../db/companyQueries');
        const company = await companyQueries.getCompanyById(companyId);
        companyName = String(company?.name || '').trim();
    } catch {
        // Subject falls back to the generic copy below.
    }
    const subject = companyName
        ? `Payment receipt from ${companyName}`
        : 'Payment receipt';

    try {
        const emailService = require('./emailService');
        await emailService.sendEmail(companyId, {
            to: email,
            subject,
            body: recordedReceiptEmailBody(context),
            files: [],
            userId: actor?.id || null,
            userEmail: actor?.email || null,
        });
    } catch (err) {
        const message = err?.message || '';
        if (err?.statusCode === 409 || /mailbox is not connected|requires reconnection/i.test(message)) {
            throw new PaymentsServiceError(
                'MAILBOX_NOT_CONNECTED',
                'Connect Google Email to send.',
                409
            );
        }
        throw err;
    }
}

/**
 * Deliver one owned transaction's receipt to its customer. Stripe card rows use
 * Stripe's native receipt; recorded cash/check rows use the company mailbox.
 */
async function emailTransactionReceipt(
    companyId,
    transactionId,
    rawEmail,
    actor = null,
    client = null,
    activityActor = null
) {
    // Tenant ownership is resolved before email validation or any external call,
    // keeping foreign and missing transaction ids indistinguishable.
    const context = await paymentsQueries.getTransactionReceiptContext(
        companyId,
        transactionId,
        client
    );
    assertReceiptTransaction(context, transactionId);
    const email = normalizeReceiptEmail(rawEmail || context.customer_email, { required: true });

    let contactEmailSaved = false;
    if (context.receipt_contact_id && !String(context.receipt_contact_email || '').trim()) {
        const { propagateContactDetails } = require('./contactPropagationService');
        const outcome = await propagateContactDetails(
            companyId,
            context.receipt_contact_id,
            { email },
            { source: 'payment_receipt', logPrefix: '[PaymentReceipt]', redactEmail: true }
        );
        contactEmailSaved = outcome.email === 'added';
    }

    let receiptUrl = null;
    let delivery = 'email';
    try {
        if (isStripeCardPayment(context)) {
            const { provider, accountId, chargeId } = await resolveStripeCharge(context);
            const charge = await provider.updateChargeReceiptEmail(accountId, chargeId, email);
            receiptUrl = charge?.receipt_url || null;
            delivery = 'stripe';
        } else {
            await sendRecordedReceiptEmail(companyId, actor, context, email);
        }
    } catch (err) {
        if (activityActor) {
            await logFinancialActivity({
                companyId,
                entityType: 'payment',
                action: 'payment.receipt_send_failed',
                entity: context,
                actor: activityActor,
                summary: { channel: 'email' },
            });
        }
        throw err;
    }

    const { recordDocumentSendNote } = require('./documentSendNoteService');
    await recordDocumentSendNote({
        companyId,
        jobId: context.receipt_job_id || context.job_id || null,
        actor,
        documentType: 'receipt',
        amount: context.amount,
        channel: 'email',
        recipient: email,
    });
    if (activityActor) {
        await logFinancialActivity({
            companyId,
            entityType: 'payment',
            action: 'payment.receipt_sent',
            entity: context,
            actor: activityActor,
            summary: { channel: 'email' },
        }, { client });
    }

    return {
        sent: true,
        delivery,
        receipt_url: receiptUrl,
        contact_email_saved: contactEmailSaved,
    };
}

/**
 * Send/create a receipt for a transaction (MVP: creates record, no actual sending).
 */
async function sendReceipt(
    companyId,
    userId,
    transactionId,
    { channel, recipient } = {},
    client = null,
    activityActor = null
) {
    // Validate tx belongs to company
    const transaction = await getTransaction(companyId, transactionId, client);

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

    const receipt = await paymentsQueries.createReceipt(
        companyId,
        transactionId,
        receiptData,
        client
    );
    if (activityActor) {
        await logFinancialActivity({
            companyId,
            entityType: 'payment',
            action: 'payment.receipt_sent',
            entity: transaction,
            actor: activityActor,
            summary: { channel },
        }, { client });
    }
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
    return paymentsQueries.getTransactionsForInvoice(companyId, invoiceId);
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
    voidInvoicePayment,
    getReceipt,
    getTransactionReceiptView,
    emailTransactionReceipt,
    sendReceipt,
    getTransactionsForInvoice,
    getSummary,
};
