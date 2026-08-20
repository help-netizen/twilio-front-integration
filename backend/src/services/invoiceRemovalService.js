'use strict';

const crypto = require('crypto');
const invoiceRemovalQueries = require('../db/invoiceRemovalQueries');
const invoicesQueries = require('../db/invoicesQueries');
const jobFinanceQueries = require('../db/jobFinanceQueries');
const { applyInvoiceAllocations } = require('../db/documentPaymentQueries');
const { logFinancialActivity } = require('./financialActivityService');

const TERMINAL_STATUSES = new Set(['void', 'voided', 'refunded']);
const PAYMENT_ACTIONS = new Set(['leave_unapplied', 'apply']);

class InvoiceRemovalError extends Error {
    constructor(code, message, httpStatus = 500) {
        super(message);
        this.name = 'InvoiceRemovalError';
        this.code = code;
        this.httpStatus = httpStatus;
    }
}

function metadataObject(value) {
    if (!value || typeof value === 'object') return value || {};
    try { return JSON.parse(value); } catch { return {}; }
}

function cents(value) {
    const number = Number(value);
    return Number.isFinite(number) ? Math.round(number * 100) : 0;
}

function tipCents(metadata, amountInCents) {
    return Math.min(
        Math.max(cents(metadataObject(metadata).tip), 0),
        Math.max(amountInCents, 0)
    );
}

function transactionDocumentCents(transaction) {
    if (transaction.voided_at) return 0;
    if (
        transaction.transaction_type === 'payment'
        && ['completed', 'refunded'].includes(transaction.status)
    ) {
        const amount = Math.max(cents(transaction.amount), 0);
        return Math.max(amount - tipCents(transaction.metadata, amount), 0);
    }
    if (transaction.transaction_type === 'refund' && transaction.status === 'completed') {
        const refund = Math.abs(cents(transaction.amount));
        const originalAmount = Math.abs(cents(transaction.original_amount));
        if (originalAmount <= 0) return -refund;
        const nonTip = Math.max(
            originalAmount - tipCents(transaction.original_metadata, originalAmount),
            0
        );
        return -Math.round(refund * (nonTip / originalAmount));
    }
    return 0;
}

function summarizeTransactions(transactions, invoiceCurrency) {
    const effects = transactions.map(transaction => ({
        transaction,
        documentCents: transactionDocumentCents(transaction),
    }));
    const effective = effects.filter(item => item.documentCents !== 0);
    const currencies = new Set(effective.map(item => (
        String(item.transaction.currency || invoiceCurrency || 'USD').toUpperCase()
    )));
    if (currencies.size > 1 || (currencies.size === 1
        && !currencies.has(String(invoiceCurrency || 'USD').toUpperCase()))) {
        throw new InvoiceRemovalError(
            'PAYMENT_CURRENCY_MISMATCH',
            'Applied payments do not use the invoice currency.',
            409
        );
    }
    const detachedCents = Math.max(
        effects.reduce((sum, item) => sum + item.documentCents, 0),
        0
    );
    const paymentCount = effects.filter(item => (
        item.transaction.transaction_type === 'payment'
        && ['completed', 'refunded'].includes(item.transaction.status)
        && !item.transaction.voided_at
        && item.documentCents > 0
    )).length;
    return {
        detachedCents,
        detachedAmount: detachedCents / 100,
        paymentCount,
        transactionCount: transactions.length,
        currency: String(invoiceCurrency || 'USD').toUpperCase(),
    };
}

function pristineDraft(blockers) {
    return blockers.status === 'draft'
        && !blockers.was_converted
        && !blockers.was_sent_or_public
        && !blockers.has_payment_activity
        && !blockers.has_stripe_session
        && !blockers.has_revision
        && !blockers.has_non_creation_event
        && !blockers.has_task
        && !blockers.has_ai_generation;
}

function stableTimestamp(value) {
    if (!value) return null;
    return value instanceof Date ? value.toISOString() : String(value);
}

function previewToken(source, blockers, transactions, sessions) {
    const state = {
        invoice: {
            id: String(source.id),
            status: source.status,
            job_id: source.job_id == null ? null : String(source.job_id),
            total: String(source.total),
            currency: source.currency,
            updated_at: stableTimestamp(source.updated_at),
        },
        blockers: Object.keys(blockers).sort().reduce((result, key) => {
            result[key] = blockers[key];
            return result;
        }, {}),
        transactions: transactions.map(transaction => ({
            id: String(transaction.id),
            invoice_id: transaction.invoice_id == null ? null : String(transaction.invoice_id),
            origin_invoice_id: transaction.origin_invoice_id == null
                ? null
                : String(transaction.origin_invoice_id),
            job_id: transaction.job_id == null ? null : String(transaction.job_id),
            type: transaction.transaction_type,
            status: transaction.status,
            amount: String(transaction.amount),
            currency: transaction.currency,
            voided_at: stableTimestamp(transaction.voided_at),
            updated_at: stableTimestamp(transaction.updated_at),
        })),
        sessions: sessions.map(session => ({
            id: String(session.id),
            invoice_id: session.invoice_id == null ? null : String(session.invoice_id),
            job_id: session.job_id == null ? null : String(session.job_id),
            status: session.status,
            amount: String(session.amount),
            updated_at: stableTimestamp(session.updated_at),
        })),
    };
    return crypto.createHash('sha256').update(JSON.stringify(state)).digest('hex');
}

function invoiceAuditSnapshot(invoice) {
    return {
        id: invoice.id,
        company_id: invoice.company_id,
        invoice_number: invoice.invoice_number,
        status: invoice.status,
        job_id: invoice.job_id,
        contact_id: invoice.contact_id,
        lead_id: invoice.lead_id,
        estimate_id: invoice.estimate_id,
        subtotal: invoice.subtotal,
        tax_amount: invoice.tax_amount,
        discount_amount: invoice.discount_amount,
        total: invoice.total,
        amount_paid: invoice.amount_paid,
        balance_due: invoice.balance_due,
        currency: invoice.currency,
        sent_at: invoice.sent_at,
        paid_at: invoice.paid_at,
        voided_at: invoice.voided_at,
        created_at: invoice.created_at,
        updated_at: invoice.updated_at,
    };
}

function paymentAuditSnapshot(transactions) {
    return transactions.map(transaction => ({
        id: transaction.id,
        invoice_id: transaction.invoice_id,
        origin_invoice_id: transaction.origin_invoice_id,
        job_id: transaction.job_id,
        transaction_type: transaction.transaction_type,
        payment_method: transaction.payment_method,
        status: transaction.status,
        amount: transaction.amount,
        currency: transaction.currency,
        external_id: transaction.external_id,
        external_source: transaction.external_source,
        voided_at: transaction.voided_at,
        processed_at: transaction.processed_at,
        created_at: transaction.created_at,
    }));
}

function assertRemovalIntegrity(source, blockers, transactions, sessions) {
    if (blockers.has_cross_tenant_reference) {
        throw new InvoiceRemovalError(
            'TENANT_INTEGRITY_BLOCKED',
            'Invoice removal is blocked by a cross-company reference.',
            409
        );
    }
    if ((transactions.length > 0 || sessions.length > 0) && source.job_id == null) {
        throw new InvoiceRemovalError(
            'JOB_REQUIRED',
            'Invoice payment history must belong to a job before the invoice can be removed.',
            409
        );
    }
    const mismatched = transactions.some(transaction => (
        transaction.job_id != null && String(transaction.job_id) !== String(source.job_id)
    )) || sessions.some(session => (
        session.job_id != null && String(session.job_id) !== String(source.job_id)
    ));
    if (mismatched) {
        throw new InvoiceRemovalError(
            'PAYMENT_JOB_MISMATCH',
            'Invoice payment history points at a different job.',
            409
        );
    }
}

async function candidateFor(companyId, source, summary, client = null) {
    if (summary.detachedCents <= 0 || source.job_id == null) return null;
    const rows = await invoiceRemovalQueries.getCandidateInvoices(companyId, source, client);
    const allocated = await applyInvoiceAllocations(companyId, rows, client);
    const eligible = allocated.filter(invoice => cents(invoice.balance_due) > 0);
    if (eligible.length === 0) return null;

    let matchReason = 'fallback';
    let candidate = null;
    if (summary.paymentCount === 1) {
        candidate = eligible.find(invoice => cents(invoice.total) === summary.detachedCents) || null;
        if (candidate) matchReason = 'total';
    }
    if (!candidate) {
        candidate = eligible.find(invoice => cents(invoice.balance_due) === summary.detachedCents) || null;
        if (candidate) matchReason = 'balance_due';
    }
    if (!candidate) candidate = eligible[0];

    return {
        invoice_id: candidate.id,
        invoice_number: candidate.invoice_number,
        total: Number(candidate.total || 0),
        balance_due: Number(candidate.balance_due || 0),
        currency: String(candidate.currency || summary.currency).toUpperCase(),
        match_reason: matchReason,
    };
}

async function loadPreview(companyId, sourceInvoiceId, client = null, { lock = false } = {}) {
    const source = await invoiceRemovalQueries.getSourceInvoice(
        companyId,
        sourceInvoiceId,
        client,
        { lock }
    );
    if (!source) {
        throw new InvoiceRemovalError('NOT_FOUND', `Invoice ${sourceInvoiceId} not found`, 404);
    }
    if (TERMINAL_STATUSES.has(source.status)) {
        throw new InvoiceRemovalError(
            'INVALID_STATUS',
            `Cannot remove invoice with status '${source.status}'.`,
            409
        );
    }
    const [blockers, transactions, sessions] = await Promise.all([
        invoiceRemovalQueries.getRemovalBlockers(companyId, sourceInvoiceId, client),
        invoiceRemovalQueries.getAppliedTransactions(companyId, sourceInvoiceId, client, { lock }),
        invoiceRemovalQueries.getStripeSessions(companyId, sourceInvoiceId, client, { lock }),
    ]);
    assertRemovalIntegrity(source, blockers, transactions, sessions);
    const summary = summarizeTransactions(transactions, source.currency);
    const candidate = await candidateFor(companyId, source, summary, client);
    const disposition = pristineDraft(blockers) ? 'delete' : 'void';
    return {
        source,
        blockers,
        transactions,
        sessions,
        summary,
        candidate,
        disposition,
        token: previewToken(source, blockers, transactions, sessions),
    };
}

function publicPreview(preview) {
    return {
        disposition: preview.disposition === 'delete' ? 'deleted' : 'voided',
        payments_total: preview.summary.detachedAmount.toFixed(2),
        payments_count: preview.summary.paymentCount,
        candidate: preview.candidate ? {
            id: preview.candidate.invoice_id,
            invoice_number: preview.candidate.invoice_number,
            balance_due: preview.candidate.balance_due.toFixed(2),
        } : null,
        preview_version: preview.token,
    };
}

async function previewInvoiceRemoval(companyId, sourceInvoiceId, client = null) {
    return publicPreview(await loadPreview(companyId, sourceInvoiceId, client));
}

function normalizePerformInput(input = {}) {
    const paymentAction = input.payment_action;
    if (!PAYMENT_ACTIONS.has(paymentAction)) {
        throw new InvoiceRemovalError(
            'VALIDATION',
            'payment_action must be leave_unapplied or apply.',
            400
        );
    }
    if (typeof input.preview_version !== 'string' || !/^[a-f0-9]{64}$/.test(input.preview_version)) {
        throw new InvoiceRemovalError('VALIDATION', 'A valid preview_version is required.', 400);
    }
    if (
        typeof input.request_id !== 'string'
        || input.request_id.length < 1
        || input.request_id.length > 100
    ) {
        throw new InvoiceRemovalError('VALIDATION', 'A valid request_id is required.', 400);
    }
    const targetInvoiceId = input.target_invoice_id == null
        ? null
        : String(input.target_invoice_id);
    if (paymentAction === 'apply' && !/^\d+$/.test(targetInvoiceId || '')) {
        throw new InvoiceRemovalError('VALIDATION', 'target_invoice_id is required.', 400);
    }
    if (paymentAction === 'leave_unapplied' && targetInvoiceId !== null) {
        throw new InvoiceRemovalError(
            'VALIDATION',
            'target_invoice_id is only valid when payment_action is apply.',
            400
        );
    }
    return {
        paymentAction,
        previewVersion: input.preview_version,
        requestId: input.request_id,
        targetInvoiceId,
    };
}

function completedResponse(existing, requested) {
    const existingTarget = existing.target_invoice_id == null
        ? null
        : String(existing.target_invoice_id);
    if (
        existing.payment_action !== requested.paymentAction
        || existingTarget !== requested.targetInvoiceId
        || existing.preview_version !== requested.previewVersion
    ) {
        throw new InvoiceRemovalError(
            'REMOVAL_ALREADY_COMPLETED',
            'Invoice removal already completed with a different choice.',
            409
        );
    }
    const response = metadataObject(existing.response);
    return { ...response, idempotent: true };
}

async function removeInvoice(
    companyId,
    sourceInvoiceId,
    userId,
    input,
    client = null,
    activityActor = null
) {
    if (!client?.query) {
        throw new Error('removeInvoice requires an active transaction');
    }
    const requested = normalizePerformInput(input);
    let completed = await invoiceRemovalQueries.getRemovalByRequestId(
        companyId,
        requested.requestId,
        client
    );
    if (completed && String(completed.source_invoice_id) !== String(sourceInvoiceId)) {
        throw new InvoiceRemovalError(
            'IDEMPOTENCY_KEY_REUSED',
            'request_id was already used for another invoice removal.',
            409
        );
    }
    if (completed) return completedResponse(completed, requested);
    completed = await invoiceRemovalQueries.getCompletedRemoval(
        companyId,
        sourceInvoiceId,
        client
    );
    if (completed) return completedResponse(completed, requested);

    let preview;
    try {
        preview = await loadPreview(companyId, sourceInvoiceId, client, { lock: true });
    } catch (error) {
        // A concurrent perform may commit while this transaction is waiting on
        // the invoice lock. Re-check the durable idempotency row for both hard
        // delete (NOT_FOUND) and void (INVALID_STATUS) outcomes.
        completed = await invoiceRemovalQueries.getCompletedRemoval(
            companyId,
            sourceInvoiceId,
            client
        );
        if (completed) return completedResponse(completed, requested);
        throw error;
    }
    if (preview.token !== requested.previewVersion) {
        throw new InvoiceRemovalError(
            'PREVIEW_STALE',
            'Invoice or payment state changed. Preview the removal again.',
            409
        );
    }

    let target = null;
    if (requested.paymentAction === 'apply') {
        target = await invoiceRemovalQueries.lockCandidateInvoice(
            companyId,
            requested.targetInvoiceId,
            client
        );
        if (!target) {
            throw new InvoiceRemovalError(
                'NOT_FOUND',
                `Invoice ${requested.targetInvoiceId} not found`,
                404
            );
        }
        const currentCandidate = await candidateFor(
            companyId,
            preview.source,
            preview.summary,
            client
        );
        if (
            !currentCandidate
            || String(currentCandidate.invoice_id) !== requested.targetInvoiceId
            || TERMINAL_STATUSES.has(target.status)
            || String(target.job_id) !== String(preview.source.job_id)
            || String(target.currency).toUpperCase() !== preview.summary.currency
        ) {
            throw new InvoiceRemovalError(
                'TARGET_NOT_OFFERED',
                'The selected invoice is no longer the removal candidate.',
                409
            );
        }
    }

    const removal = await invoiceRemovalQueries.createRemoval(companyId, {
        source_invoice_id: preview.source.id,
        source_invoice_number: preview.source.invoice_number,
        source_job_id: preview.source.job_id,
        disposition: preview.disposition,
        payment_action: requested.paymentAction,
        target_invoice_id: target?.id || null,
        target_invoice_number: target?.invoice_number || null,
        detached_amount: preview.summary.detachedAmount,
        detached_payment_count: preview.summary.paymentCount,
        detached_transaction_count: preview.summary.transactionCount,
        currency: preview.summary.currency,
        preview_version: preview.token,
        request_id: requested.requestId,
        actor_id: userId || null,
        invoice_snapshot: invoiceAuditSnapshot(preview.source),
        payment_snapshot: paymentAuditSnapshot(preview.transactions),
    }, client);

    if (preview.transactions.length > 0) {
        const reassigned = await invoiceRemovalQueries.reassignPayments(
            companyId,
            preview.source.id,
            preview.source.job_id,
            target?.id || null,
            client
        );
        if (reassigned.length !== preview.transactions.length) {
            throw new InvoiceRemovalError(
                'PAYMENT_STATE_CHANGED',
                'Applied payments changed during invoice removal.',
                409
            );
        }
    }
    if (preview.sessions.length > 0) {
        const detachedSessions = await invoiceRemovalQueries.detachStripeSessions(
            companyId,
            preview.source,
            client
        );
        if (detachedSessions.length !== preview.sessions.length) {
            throw new InvoiceRemovalError(
                'PAYMENT_STATE_CHANGED',
                'Stripe payment sessions changed during invoice removal.',
                409
            );
        }
    }

    let removedInvoice = preview.source;
    if (preview.disposition === 'delete') {
        const deleted = await invoicesQueries.deleteInvoice(preview.source.id, companyId, client);
        if (!deleted) {
            throw new InvoiceRemovalError(
                'INVOICE_STATE_CHANGED',
                'Invoice history changed during removal.',
                409
            );
        }
    } else {
        removedInvoice = await invoiceRemovalQueries.voidInvoiceForRemoval(
            companyId,
            preview.source.id,
            client
        );
        if (!removedInvoice) {
            throw new InvoiceRemovalError(
                'INVOICE_STATE_CHANGED',
                'Invoice status changed during removal.',
                409
            );
        }
        await invoicesQueries.createEvent(
            companyId,
            preview.source.id,
            'voided',
            'user',
            userId,
            {
                removal_id: removal.id,
                payment_action: requested.paymentAction,
                target_invoice_id: target?.id || null,
            },
            client
        );
    }

    if (activityActor) {
        await logFinancialActivity({
            companyId,
            entityType: 'invoice',
            action: preview.disposition === 'delete' ? 'invoice.deleted' : 'invoice.voided',
            entity: removedInvoice,
            actor: activityActor,
            summary: {
                removal_id: removal.id,
                disposition: preview.disposition,
                payment_action: requested.paymentAction,
                target_invoice_id: target?.id || null,
                detached_amount: preview.summary.detachedAmount,
                currency: preview.summary.currency,
            },
        }, { client });
    }

    const jobFinance = preview.source.job_id == null
        ? null
        : await jobFinanceQueries.getJobFinance(
            companyId,
            preview.source.job_id,
            client
        );
    const response = {
        removal_id: removal.id,
        invoice_id: preview.source.id,
        invoice_number: preview.source.invoice_number,
        disposition: preview.disposition,
        payment_action: requested.paymentAction,
        target_invoice: target ? {
            invoice_id: target.id,
            invoice_number: target.invoice_number,
        } : null,
        detached_amount: preview.summary.detachedAmount,
        detached_payment_count: preview.summary.paymentCount,
        detached_transaction_count: preview.summary.transactionCount,
        currency: preview.summary.currency,
        job_finance: jobFinance ? {
            estimated: jobFinance.estimated,
            invoiced: jobFinance.invoiced,
            paid: jobFinance.paid,
            due: jobFinance.due,
            tips: jobFinance.tips,
            unapplied_credit: jobFinance.unapplied_credit,
        } : null,
        idempotent: false,
    };
    await invoiceRemovalQueries.saveRemovalResponse(companyId, removal.id, response, client);
    return response;
}

module.exports = {
    InvoiceRemovalError,
    previewInvoiceRemoval,
    removeInvoice,
    summarizeTransactions,
    transactionDocumentCents,
};
