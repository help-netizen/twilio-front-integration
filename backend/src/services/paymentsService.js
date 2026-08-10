/**
 * Payments Service
 * PF004 Payment Collection MVP — Sprint 5
 *
 * Business logic for payment transactions, refunds, voids, and receipts.
 * Operates on the canonical payment_transactions / payment_receipts tables.
 *
 * NOTE: Frozen imported-payment reads remain in
 * services/zenbookerPaymentsSyncService.js for the legacy Payments-page data layer.
 */

const { randomUUID } = require('crypto');
const paymentsQueries = require('../db/paymentsQueries');
const invoicesQueries = require('../db/invoicesQueries');
const estimatesQueries = require('../db/estimatesQueries');
const { logFinancialActivity } = require('./financialActivityService');
const eventBus = require('./eventBus');

function emitPaymentEvent(companyId, eventType, payment, activityActor, client = null, idempotencyKey = null) {
    return eventBus.emit(companyId, eventType, {
        payment_id: payment.id,
        job_id: payment.job_id || null,
        invoice_id: payment.invoice_id || null,
        amount: Number(payment.amount),
        record_refs: [{ type: 'payment', id: payment.id }],
    }, {
        actorType: activityActor?.type || 'system',
        actorId: activityActor?.type === 'user' ? activityActor.id || null : null,
        aggregateType: 'payment',
        aggregateId: payment.id,
        idempotencyKey,
        client,
    });
}

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
    return source === 'manual';
}

function normalizeVoidReason(reason, { allowMissing = false } = {}) {
    if ((reason === undefined || reason === null) && allowMissing) return null;
    if (typeof reason !== 'string') {
        throw new PaymentsServiceError(
            'VALIDATION',
            'reason must be a string between 1 and 500 characters',
            400
        );
    }
    const normalized = reason.trim();
    if (normalized.length < 1 || normalized.length > 500) {
        throw new PaymentsServiceError(
            'VALIDATION',
            'reason must be between 1 and 500 characters',
            400
        );
    }
    return normalized;
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

function publicTransactionDetail(context, receiptHistory) {
    const {
        stripe_session_id: _stripeSessionId,
        stripe_payment_intent_id: _stripePaymentIntentId,
        stripe_charge_id: _stripeChargeId,
        stripe_account_id: _stripeAccountId,
        receipt_contact_id: _receiptContactId,
        receipt_contact_email: _receiptContactEmail,
        customer_email: _customerEmail,
        receipt_job_id: receiptJobId,
        receipt_invoice_id: receiptInvoiceId,
        job_number: _jobNumber,
        service_name: _serviceName,
        company_timezone: _companyTimezone,
        ...detail
    } = context;

    return {
        ...detail,
        job_id: receiptJobId || context.job_id || null,
        invoice_id: receiptInvoiceId || context.invoice_id || null,
        brand: context.brand || null,
        last4: context.last4 || null,
        invoice_number: context.invoice_number || null,
        customer_name: context.customer_name || null,
        created_by_name: context.created_by_name || null,
        territory: context.territory || null,
        stripe_payment_id: context.stripe_payment_id || null,
        stripe_customer_id: context.stripe_customer_id || null,
        voided_by_name: context.voided_by_name || null,
        receipt_history: receiptHistory,
    };
}

async function enrichStripeCardContext(context) {
    if (!isStripeCardPayment(context)) return context;
    try {
        const { provider, accountId, chargeId } = await resolveStripeCharge(context);
        const charge = await provider.retrieveCharge(accountId, chargeId);
        const card = charge?.payment_method_details?.card;
        const stripeCustomer = typeof charge?.customer === 'string'
            ? charge.customer
            : charge?.customer?.id;
        return {
            ...context,
            brand: card?.brand || context.brand || null,
            last4: card?.last4 || context.last4 || null,
            stripe_customer_id: stripeCustomer || context.stripe_customer_id || null,
        };
    } catch {
        // Card metadata is review enrichment. An unavailable Stripe read must not
        // make an otherwise-owned local transaction unavailable.
        return context;
    }
}

/**
 * Rich flat transaction detail for both payments screens.
 */
async function getTransactionDetail(companyId, id) {
    const context = await paymentsQueries.getTransactionReceiptContext(companyId, id);
    if (!context) {
        throw new PaymentsServiceError('NOT_FOUND', `Transaction ${id} not found`, 404);
    }
    const [enriched, receiptHistory] = await Promise.all([
        enrichStripeCardContext(context),
        paymentsQueries.listReceiptHistory(companyId, id),
    ]);
    return publicTransactionDetail(enriched, receiptHistory);
}

async function validateRelatedEntities(companyId, data, client = null) {
    const related = {};
    if (data.contact_id != null) {
        const contact = await estimatesQueries.getContactContext(
            companyId,
            data.contact_id,
            client
        );
        if (!contact) throw new PaymentsServiceError('NOT_FOUND', 'Contact not found', 404);
        related.contact = contact;
    }
    if (data.estimate_id != null) {
        const estimate = await estimatesQueries.getEstimateById(
            companyId,
            data.estimate_id,
            client
        );
        if (!estimate) throw new PaymentsServiceError('NOT_FOUND', 'Estimate not found', 404);
        related.estimate = estimate;
    }
    if (data.invoice_id != null) {
        const invoice = await invoicesQueries.getInvoiceById(
            companyId,
            data.invoice_id,
            client
        );
        if (!invoice) throw new PaymentsServiceError('NOT_FOUND', 'Invoice not found', 404);
        related.invoice = invoice;
    }
    if (data.job_id != null) {
        const job = await estimatesQueries.getJobContext(companyId, data.job_id, client);
        if (!job) throw new PaymentsServiceError('NOT_FOUND', 'Job not found', 404);
        related.job = job;
    }
    return related;
}

/**
 * Create a payment transaction.
 * Validates amount, transaction_type, payment_method.
 * invoice_id is receipt/reference metadata only. Job-linked money is derived
 * live from the Job ledger pool and never mutates invoice aggregates.
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
    const related = await validateRelatedEntities(companyId, data, client);
    const transactionData = related.invoice ? {
        ...data,
        job_id: related.invoice.job_id || data.job_id || null,
        contact_id: related.invoice.contact_id || data.contact_id || null,
    } : data;
    if (
        transaction_type === 'payment'
        && transactionData.external_source !== 'zenbooker'
        && transactionData.job_id == null
    ) {
        throw new PaymentsServiceError(
            'JOB_REQUIRED',
            'A native payment must belong to a job',
            400
        );
    }

    const tx = await paymentsQueries.createTransaction(companyId, {
        ...transactionData,
        status: 'completed',
        processed_at: data.processed_at || new Date().toISOString(),
        recorded_by: userId,
    }, client);
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

    if (transaction_type === 'payment') {
        await emitPaymentEvent(
            companyId,
            'payment.recorded',
            tx,
            activityActor,
            client,
            `payment.recorded:${tx.id}`
        );
        await emitPaymentEvent(
            companyId,
            'payment.succeeded',
            tx,
            activityActor,
            client,
            `payment.succeeded:${tx.id}`
        );
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
 * Document balances observe the refund live through the Job payment pool.
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

    await emitPaymentEvent(
        companyId,
        'payment.refunded',
        original,
        activityActor,
        client,
        `payment.refunded:${refundTx.id}`
    );

    return refundTx;
}

/**
 * Canonical manual-payment void. The payment row is locked before eligibility
 * is evaluated, so invoice-linked, standalone, repeat, and concurrent requests
 * all converge through one mutation path.
 */
async function voidPayment(
    companyId,
    userId,
    id,
    {
        reason,
        invoiceId = null,
        allowMissingReason = false,
    } = {},
    client = null,
    activityActor = null
) {
    if (!userId) {
        throw new PaymentsServiceError(
            'CRM_ACTOR_REQUIRED',
            'A CRM user is required to void a payment.',
            401
        );
    }
    if (!client?.query) {
        throw new PaymentsServiceError(
            'TRANSACTION_REQUIRED',
            'Payment voids require an active database transaction.',
            500
        );
    }
    const normalizedReason = normalizeVoidReason(reason, {
        allowMissing: allowMissingReason,
    });
    const mutation = await paymentsQueries.voidPayment(
        companyId,
        id,
        userId,
        normalizedReason,
        invoiceId,
        client
    );
    if (!mutation) {
        throw new PaymentsServiceError('NOT_FOUND', `Payment ${id} not found`, 404);
    }
    if (!mutation.linked_invoice_owned) {
        throw new PaymentsServiceError('NOT_FOUND', 'Linked invoice not found', 404);
    }

    const candidate = {
        transaction_type: mutation.candidate_transaction_type,
        status: mutation.candidate_status,
        external_source: mutation.candidate_external_source,
        invoice_id: mutation.candidate_invoice_id,
        voided_at: mutation.candidate_voided_at,
    };
    if (!isManualOrigin(candidate)) {
        throw new PaymentsServiceError(
            'EXTERNAL_PAYMENT_NOT_VOIDABLE',
            'Only payments with external_source=manual can be voided.',
            409
        );
    }
    if (candidate.transaction_type !== 'payment') {
        throw new PaymentsServiceError(
            'INVALID_STATUS',
            `Cannot void a '${candidate.status}' ${candidate.transaction_type}.`,
            409
        );
    }
    if (
        candidate.status !== 'completed'
        && candidate.status !== 'voided'
    ) {
        throw new PaymentsServiceError(
            'INVALID_STATUS',
            `Cannot void a '${candidate.status}' payment.`,
            409
        );
    }
    if (mutation.did_void && !mutation.invoice_updated) {
        throw new PaymentsServiceError(
            'VOID_FAILED',
            'Payment was not applied to the tenant-scoped invoice.',
            500
        );
    }

    const currentPayment = await paymentsQueries.getTransactionById(companyId, id, client);
    if (!currentPayment) {
        throw new PaymentsServiceError('NOT_FOUND', `Payment ${id} not found`, 404);
    }
    if (!mutation.did_void) {
        if (currentPayment.status !== 'voided' && !currentPayment.voided_at) {
            throw new PaymentsServiceError('VOID_FAILED', 'Could not void payment.', 500);
        }
        const currentInvoice = currentPayment.invoice_id
            ? await invoicesQueries.getInvoiceById(
                companyId,
                currentPayment.invoice_id,
                client
            )
            : null;
        return {
            payment: currentPayment,
            invoice: currentInvoice,
            idempotent: true,
        };
    }

    const currentInvoice = currentPayment.invoice_id
        ? await invoicesQueries.getInvoiceById(
            companyId,
            currentPayment.invoice_id,
            client
        )
        : null;
    if (currentPayment.invoice_id && !currentInvoice) {
        throw new PaymentsServiceError(
            'VOID_FAILED',
            'Payment was not applied to the tenant-scoped invoice.',
            500
        );
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
                amount: Number(currentPayment.amount),
                currency: currentPayment.currency,
            },
        }, { client });
    }

    await emitPaymentEvent(
        companyId,
        'payment.voided',
        currentPayment,
        activityActor,
        client,
        `payment.voided:${currentPayment.id}`
    );

    return {
        payment: currentPayment,
        invoice: currentInvoice,
        idempotent: false,
    };
}

// Compatibility wrappers: both delegate to the canonical service/query above.
async function voidTransaction(
    companyId,
    userId,
    id,
    client = null,
    activityActor = null
) {
    const result = await voidPayment(
        companyId,
        userId,
        id,
        { allowMissingReason: true },
        client,
        activityActor
    );
    return result.payment;
}

async function voidInvoicePayment(
    companyId,
    userId,
    invoiceId,
    paymentId,
    client = null,
    activityActor = null,
    reason = null
) {
    return voidPayment(
        companyId,
        userId,
        paymentId,
        {
            reason,
            invoiceId,
            allowMissingReason: true,
        },
        client,
        activityActor
    );
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
const RECEIPT_IDEMPOTENCY_KEY_SHAPE = /^[\x21-\x7E]+$/;

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

function normalizeReceiptIdempotencyKey(value) {
    if (value === undefined || value === null || value === '') {
        return `receipt-${randomUUID()}`;
    }
    const key = typeof value === 'string' ? value.trim() : '';
    if (
        key.length < 8
        || key.length > 128
        || !RECEIPT_IDEMPOTENCY_KEY_SHAPE.test(key)
    ) {
        throw new PaymentsServiceError(
            'INVALID_IDEMPOTENCY_KEY',
            'Idempotency-Key must contain 8 to 128 visible ASCII characters',
            400
        );
    }
    return key;
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
 * Return the custom receipt model for one owned transaction. No provider URL is
 * resolved or exposed.
 */
async function getTransactionReceiptView(companyId, transactionId) {
    const context = await paymentsQueries.getTransactionReceiptContext(companyId, transactionId);
    assertReceiptTransaction(context, transactionId);

    return {
        receipt_type: 'custom',
        receipt: receiptViewModel(context),
    };
}

async function assertReceiptMailbox(companyId) {
    const emailMailboxService = require('./emailMailboxService');
    const mailbox = await emailMailboxService.getMailboxStatus(companyId);
    if (!mailbox || mailbox.status !== 'connected') {
        throw new PaymentsServiceError(
            'MAILBOX_NOT_CONNECTED',
            'Connect Google Email to send.',
            409
        );
    }
}

function receiptNumber() {
    const date = new Date().toISOString().slice(0, 10).replaceAll('-', '');
    return `REC-${date}-${randomUUID().slice(0, 8)}`;
}

function invoiceFileName(invoiceNumber) {
    const { shortDocNumber } = require('../utils/docNumber');
    const safe = String(shortDocNumber(invoiceNumber) || 'invoice').replace(/[^A-Za-z0-9._-]/g, '-');
    return `Invoice-${safe}.pdf`;
}

async function buildReceiptDelivery(companyId, context) {
    const documentTemplatesService = require('./documentTemplatesService');
    const descriptor = await documentTemplatesService.resolveTemplate(companyId, 'invoice');
    const brand = descriptor?.brand || {};
    const files = [];
    let logoContentId = null;

    if (brand.logo_url) {
        const { fetchPdfLogo } = require('./documentTemplates/pdfLogo');
        const logo = await fetchPdfLogo(brand.logo_url);
        if (logo) {
            logoContentId = 'albusto-company-logo';
            files.push({
                originalname: `company-logo.${logo.format === 'jpg' ? 'jpg' : 'png'}`,
                mimetype: logo.format === 'jpg' ? 'image/jpeg' : 'image/png',
                buffer: logo.data,
                contentId: logoContentId,
            });
        }
    }

    // The receipt carries the invoice PDF whenever one exists: the payment's own
    // invoice, or — for an ad-hoc job payment — the job's current invoice.
    let invoice = null;
    const invoiceIdForPdf = context.receipt_invoice_id || context.invoice_id || context.job_invoice_id;
    if (invoiceIdForPdf) {
        const invoicesService = require('./invoicesService');
        try {
            const generated = await invoicesService.generatePdf(companyId, invoiceIdForPdf);
            invoice = generated.invoice;
            files.push({
                originalname: invoiceFileName(invoice.invoice_number),
                mimetype: 'application/pdf',
                buffer: generated.buffer,
            });
        } catch (err) {
            // A receipt must still reach the customer if the invoice PDF fails to render.
            console.error('[PaymentReceipt] invoice PDF skipped:', err.message);
        }
    }

    const { buildPaymentReceiptEmail } = require('./paymentReceiptTemplate');
    const template = buildPaymentReceiptEmail({
        context,
        invoice,
        brand,
        logoContentId,
    });
    const { buildEmailBody } = require('./documentEmailBody');
    return {
        subject: template.subject,
        body: buildEmailBody(template.html, null, { preformatted: true }),
        textBody: template.text,
        files,
        fromName: brand.name || null,
    };
}

function mapMailboxError(err) {
    const message = err?.message || '';
    if (err?.statusCode === 409 || /mailbox is not connected|requires reconnection/i.test(message)) {
        return new PaymentsServiceError(
            'MAILBOX_NOT_CONNECTED',
            'Connect Google Email to send.',
            409
        );
    }
    return err;
}

/**
 * Deliver one owned transaction's custom receipt through the company Gmail
 * mailbox. The successful history marker is written only after Gmail returns.
 */
async function emailTransactionReceipt(
    companyId,
    transactionId,
    rawEmail,
    actor = null,
    client = null,
    activityActor = null,
    rawIdempotencyKey = null
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
    const idempotencyKey = normalizeReceiptIdempotencyKey(rawIdempotencyKey);
    await assertReceiptMailbox(companyId);

    const claim = await paymentsQueries.claimReceiptDelivery(
        companyId,
        transactionId,
        {
            receiptNumber: receiptNumber(),
            idempotencyKey,
            email,
        },
        client
    );
    if (!claim.receipt) {
        throw new PaymentsServiceError('NOT_FOUND', `Transaction ${transactionId} not found`, 404);
    }
    if (!claim.claimed) {
        if (!claim.receipt.sent_at) {
            throw new PaymentsServiceError(
                'RECEIPT_SEND_IN_PROGRESS',
                'A receipt send with this idempotency key is already in progress',
                409
            );
        }
        return {
            sent: true,
            delivery: 'email',
            contact_email_saved: false,
            idempotent: true,
            receipt_history_entry: {
                to: claim.receipt.sent_to_email,
                sent_at: claim.receipt.sent_at,
                channel: claim.receipt.sent_via,
            },
        };
    }

    let gmailAccepted = false;
    let contactEmailSaved = false;
    let completedReceipt = null;
    try {
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

        const renderContext = await enrichStripeCardContext(context);
        const delivery = await buildReceiptDelivery(companyId, renderContext);
        const emailService = require('./emailService');
        const sentMessage = await emailService.sendEmail(companyId, {
            to: email,
            ...delivery,
            userId: actor?.id || null,
            userEmail: actor?.email || null,
        });
        gmailAccepted = true;
        completedReceipt = await paymentsQueries.completeReceiptDelivery(
            companyId,
            claim.receipt.id,
            sentMessage?.provider_message_id || null,
            client
        );
        if (!completedReceipt) {
            throw new PaymentsServiceError(
                'RECEIPT_HISTORY_FAILED',
                'Receipt was sent but its history could not be recorded',
                500
            );
        }
    } catch (err) {
        if (!gmailAccepted) {
            await paymentsQueries.releaseReceiptDelivery(companyId, claim.receipt.id, client);
        }
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
        throw mapMailboxError(err);
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
        delivery: 'email',
        contact_email_saved: contactEmailSaved,
        idempotent: false,
        receipt_history_entry: {
            to: completedReceipt.sent_to_email,
            sent_at: completedReceipt.sent_at,
            channel: completedReceipt.sent_via,
        },
    };
}

/**
 * Compatibility adapter for the old channel-based endpoint. Receipt delivery is
 * email-only and delegates to the same custom sender.
 */
async function sendReceipt(
    companyId,
    userId,
    transactionId,
    { channel, recipient, idempotencyKey } = {},
    client = null,
    activityActor = null
) {
    if (channel !== 'email') {
        throw new PaymentsServiceError(
            'VALIDATION',
            'Custom payment receipts can be sent by email only',
            400
        );
    }
    return emailTransactionReceipt(
        companyId,
        transactionId,
        recipient,
        { id: userId },
        client,
        activityActor,
        idempotencyKey
    );
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
    getTransactionDetail,
    createTransaction,
    recordManualPayment,
    refundTransaction,
    voidPayment,
    voidTransaction,
    voidInvoicePayment,
    getReceipt,
    getTransactionReceiptView,
    emailTransactionReceipt,
    sendReceipt,
    getTransactionsForInvoice,
    getSummary,
};
