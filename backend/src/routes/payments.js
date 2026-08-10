/**
 * PF004 Payments API (canonical payment ledger)
 * Sprint 5: real implementations
 *
 * Separate from legacy /api/zenbooker/payments, which serves frozen imported data.
 */
const express = require('express');
const router = express.Router();
const paymentsService = require('../services/paymentsService');
const jobsService = require('../services/jobsService');
const { requirePermission } = require('../middleware/authorization');
const { getProviderScope } = require('../middleware/providerScope');
const { userActor } = require('../services/financialActivityService');
const { withTransaction } = require('../services/transactionService');

// ROLE-PROVIDER-NO-PAYMENTS-001 — decouple the standalone payments ledger from the
// job-level payment view. The full ledger (any/unfiltered transactions) needs
// payments.view; a caller with only financial_data.view (a Provider) may read
// payments ONLY for a job assigned to them — the job-scoped reads the job finance
// panel makes (GET /?job_id, GET /:id). Reuses the canonical provider record scope:
// getJobById under an assigned_only scope returns null for a job that isn't theirs.
function hasLedgerAccess(req) {
    return !!req.user?._devMode || (req.authz?.permissions || []).includes('payments.view');
}

async function jobScopeError(req, jobId) {
    if (hasLedgerAccess(req)) return null; // office: full ledger, no job scoping
    if (jobId == null || jobId === '') {
        return { status: 403, code: 'PAYMENTS_JOB_SCOPE_REQUIRED',
            message: 'Payments are limited to your assigned jobs — open one from the job.' };
    }
    const companyId = req.companyFilter?.company_id;
    const job = await jobsService.getJobById(jobId, companyId, getProviderScope(req));
    if (!job) {
        return { status: 403, code: 'ACCESS_DENIED',
            message: 'You can only view payments on jobs assigned to you.' };
    }
    return null;
}

function sendScopeError(res, err) {
    return res.status(err.status).json({ ok: false, error: { code: err.code, message: err.message } });
}

function manualCardAccess(req) {
    const providerScope = getProviderScope(req);
    return {
        actorId: req.user?.crmUser?.id || null,
        providerLimited: !req.user?._devMode && providerScope.assignedOnly,
        providerScope,
    };
}

// =============================================================================
// Payment transactions
// =============================================================================

// GET /api/payments — List payment transactions
router.get('/', requirePermission('payments.view', 'financial_data.view'), async (req, res) => {
    try {
        const companyId = req.companyFilter?.company_id;
        // Non-ledger callers (Provider) may only list a job they're assigned to.
        const scopeErr = await jobScopeError(req, req.query.job_id);
        if (scopeErr) return sendScopeError(res, scopeErr);
        const {
            status,
            transaction_type,
            payment_method,
            contact_id,
            invoice_id,
            estimate_id,
            job_id,
            source,
            search,
            start_date,
            end_date,
            limit,
            offset,
        } = req.query;

        const filters = {};
        if (status)           filters.status = status;
        if (transaction_type) filters.transactionType = transaction_type;
        if (payment_method)   filters.paymentMethod = payment_method;
        if (contact_id)       filters.contactId = contact_id;
        if (invoice_id)       filters.invoiceId = invoice_id;
        if (estimate_id)      filters.estimateId = estimate_id;
        if (job_id)           filters.jobId = job_id;
        if (source)           filters.externalSource = source;
        if (search)           filters.search = search;
        if (start_date)       filters.startDate = start_date;
        if (end_date)         filters.endDate = end_date;
        if (limit)            filters.limit = parseInt(limit, 10);
        if (offset)           filters.offset = parseInt(offset, 10);

        const result = await paymentsService.listTransactions(companyId, filters);
        res.json({ ok: true, data: result });
    } catch (err) {
        console.error('[Payments] GET / error:', err.message);
        const status = err.httpStatus || 500;
        res.status(status).json({ ok: false, error: { code: err.code || 'INTERNAL', message: err.message } });
    }
});

// GET /api/payments/summary — Aggregate summary (BEFORE /:id to avoid conflict)
router.get('/summary', requirePermission('payments.view'), async (req, res) => {
    try {
        const companyId = req.companyFilter?.company_id;
        const { start_date, end_date } = req.query;

        const filters = {};
        if (start_date) filters.startDate = start_date;
        if (end_date)   filters.endDate = end_date;

        const result = await paymentsService.getSummary(companyId, filters);
        res.json({ ok: true, data: result });
    } catch (err) {
        console.error('[Payments] GET /summary error:', err.message);
        const status = err.httpStatus || 500;
        res.status(status).json({ ok: false, error: { code: err.code || 'INTERNAL', message: err.message } });
    }
});

// GET /api/payments/stripe-readiness — Stripe collect-readiness for the Pay-by-Card
// affordance (PROVIDER-CARD-COLLECT-001). The canonical /api/stripe-payments/status is
// gated on tenant.integrations.manage (admin), so a Provider who CAN collect (keyed/
// online/terminal) couldn't read it and the card button never appeared. This mirrors the
// same read for any collector. Read-only; the actual charge stays on its collect gate.
router.get('/stripe-readiness',
    requirePermission('payments.collect_online', 'payments.collect_keyed', 'payments.collect_terminal', 'payments.collect_offline', 'payments.view'),
    async (req, res) => {
        try {
            const readiness = await require('../services/stripePaymentsService').getStatus(req.companyFilter?.company_id);
            res.json({ ok: true, data: readiness });
        } catch (err) {
            console.error('[Payments] GET /stripe-readiness error:', err.message);
            res.status(err.httpStatus || 500).json({ ok: false, error: { code: err.code || 'INTERNAL', message: err.message } });
        }
    });

// GET /api/payments/manual-card-sessions/:sessionId/result — reconcile keyed card.
// Literal route stays before /:id; success intentionally has exactly four keys.
router.get('/manual-card-sessions/:sessionId/result', requirePermission('payments.collect_keyed'), async (req, res) => {
    try {
        const stripePaymentsService = require('../services/stripePaymentsService');
        const companyId = req.companyFilter?.company_id;
        const result = await stripePaymentsService.getManualCardSessionResult(
            companyId,
            req.params.sessionId,
            manualCardAccess(req)
        );
        res.json(result);
    } catch (err) {
        const status = err.httpStatus || 500;
        res.status(status).json({ ok: false, error: { code: err.code || 'INTERNAL', message: err.message } });
    }
});

// POST /api/payments/manual-card-sessions/:sessionId/confirm — confirm the
// existing company-owned keyed-card PaymentIntent with a popup-created pm id.
router.post('/manual-card-sessions/:sessionId/confirm', requirePermission('payments.collect_keyed'), async (req, res) => {
    try {
        const stripePaymentsService = require('../services/stripePaymentsService');
        const companyId = req.companyFilter?.company_id;
        const result = await stripePaymentsService.confirmManualCardSession(
            companyId,
            req.params.sessionId,
            req.body?.payment_method_id,
            manualCardAccess(req)
        );
        res.json(result);
    } catch (err) {
        const status = err.httpStatus || 500;
        res.status(status).json({ ok: false, error: { code: err.code || 'INTERNAL', message: err.message } });
    }
});

// POST /api/payments/manual-card-sessions/:sessionId/finalize — after popup
// authentication, retrieve and project the same PaymentIntent into the ledger.
router.post('/manual-card-sessions/:sessionId/finalize', requirePermission('payments.collect_keyed'), async (req, res) => {
    try {
        const stripePaymentsService = require('../services/stripePaymentsService');
        const companyId = req.companyFilter?.company_id;
        const result = await stripePaymentsService.finalizeManualCardSession(
            companyId,
            req.params.sessionId,
            manualCardAccess(req)
        );
        res.json(result);
    } catch (err) {
        const status = err.httpStatus || 500;
        res.status(status).json({ ok: false, error: { code: err.code || 'INTERNAL', message: err.message } });
    }
});

// POST /api/payments/manual-card-sessions/:sessionId/receipt — compatibility
// adapter to the canonical Albusto receipt sender.
router.post('/manual-card-sessions/:sessionId/receipt', requirePermission('payments.collect_keyed'), async (req, res) => {
    try {
        const stripePaymentsService = require('../services/stripePaymentsService');
        const { actorFromRequest } = require('../services/documentSendNoteService');
        const companyId = req.companyFilter?.company_id;
        const result = await stripePaymentsService.sendManualCardReceipt(
            companyId,
            req.params.sessionId,
            req.body?.email,
            actorFromRequest(req),
            null,
            userActor(req.user?.crmUser?.id || null),
            req.get?.('Idempotency-Key'),
            manualCardAccess(req)
        );
        res.json(result);
    } catch (err) {
        const status = err.httpStatus || 500;
        res.status(status).json({ ok: false, error: { code: err.code || 'INTERNAL', message: err.message } });
    }
});

// GET /api/payments/:id — Get payment transaction by ID
router.get('/:id', requirePermission('payments.view', 'financial_data.view'), async (req, res) => {
    try {
        const companyId = req.companyFilter?.company_id;
        const { id } = req.params;

        // Non-ledger callers (Provider): the transaction must belong to a job
        // assigned to them. Fail closed (403) for ledger-only / job-less payments.
        if (!hasLedgerAccess(req)) {
            const tx = await paymentsService.getTransaction(companyId, id);
            const scopeErr = await jobScopeError(req, tx?.job_id ?? null);
            if (scopeErr) return sendScopeError(res, scopeErr);
        }

        const result = await paymentsService.getTransactionDetail(companyId, id);
        res.json({ ok: true, data: result });
    } catch (err) {
        console.error('[Payments] GET /:id error:', err.message);
        const status = err.httpStatus || 500;
        res.status(status).json({ ok: false, error: { code: err.code || 'INTERNAL', message: err.message } });
    }
});

// =============================================================================
// Payment actions
// =============================================================================

// POST /api/payments/:id/refund — Initiate refund
router.post('/:id/refund', requirePermission('payments.refund'), async (req, res) => {
    try {
        const companyId = req.companyFilter?.company_id;
        const userId = req.user?.crmUser?.id || null;
        const { id } = req.params;
        const { amount, reason } = req.body;

        const result = await withTransaction(client => paymentsService.refundTransaction(
            companyId,
            userId,
            id,
            { amount, reason },
            client,
            userActor(userId)
        ));
        res.status(201).json({ ok: true, data: result });
    } catch (err) {
        console.error('[Payments] POST /:id/refund error:', err.message);
        const status = err.httpStatus || 500;
        res.status(status).json({ ok: false, error: { code: err.code || 'INTERNAL', message: err.message } });
    }
});

// POST /api/payments/:id/stripe-refund — Refund a Stripe payment via Stripe, then ledger.
router.post('/:id/stripe-refund', requirePermission('payments.refund'), async (req, res) => {
    try {
        const stripePaymentsService = require('../services/stripePaymentsService');
        const companyId = req.companyFilter?.company_id;
        const { amount, reason } = req.body || {};
        const result = await stripePaymentsService.refundStripePayment(
            companyId,
            { id: req.user?.crmUser?.id || null },
            req.params.id,
            { amount, reason }
        );
        res.status(201).json({ ok: true, data: result });
    } catch (err) {
        if (err.name === 'StripePaymentsError') {
            return res.status(err.httpStatus || 400).json({ ok: false, error: { code: err.code, message: err.message } });
        }
        console.error('[Payments] POST /:id/stripe-refund error:', err.message);
        res.status(err.httpStatus || 500).json({ ok: false, error: { code: err.code || 'INTERNAL', message: err.message } });
    }
});

// POST /api/payments/:id/void — Void a manual/offline payment
router.post('/:id/void', requirePermission('payments.collect_offline'), async (req, res) => {
    try {
        const companyId = req.companyFilter?.company_id;
        const userId = req.user?.crmUser?.id || null;
        const { id } = req.params;
        const { reason } = req.body || {};

        const result = await withTransaction(client => paymentsService.voidPayment(
            companyId,
            userId,
            id,
            { reason, allowMissingReason: true },
            client,
            userActor(userId)
        ));
        res.json({ ok: true, data: result });
    } catch (err) {
        console.error('[Payments] POST /:id/void error:', err.message);
        const status = err.httpStatus || 500;
        res.status(status).json({ ok: false, error: { code: err.code || 'INTERNAL', message: err.message } });
    }
});

// =============================================================================
// Receipts
// =============================================================================

// GET /api/payments/:id/receipt/view — Resolve the custom receipt model.
router.get('/:id/receipt/view', requirePermission('payments.view'), async (req, res) => {
    try {
        const companyId = req.companyFilter?.company_id;
        const result = await paymentsService.getTransactionReceiptView(companyId, req.params.id);
        res.json({ ok: true, data: result });
    } catch (err) {
        console.error('[Payments] GET /:id/receipt/view error:', err.message);
        const status = err.httpStatus || 500;
        res.status(status).json({ ok: false, error: { code: err.code || 'INTERNAL', message: err.message } });
    }
});

// POST /api/payments/:id/receipt/email — Deliver this payment's receipt.
router.post(
    '/:id/receipt/email',
    requirePermission(
        'payments.collect_online',
        'payments.collect_offline',
        'payments.collect_keyed',
        'payments.collect_terminal'
    ),
    async (req, res) => {
        try {
            const { actorFromRequest } = require('../services/documentSendNoteService');
            const companyId = req.companyFilter?.company_id;
            const actor = {
                ...actorFromRequest(req),
                email: req.user?.email || null,
            };
            const result = await paymentsService.emailTransactionReceipt(
                companyId,
                req.params.id,
                req.body?.email,
                actor,
                null,
                userActor(req.user?.crmUser?.id || null),
                req.get?.('Idempotency-Key')
            );
            res.json({ ok: true, data: result });
        } catch (err) {
            console.error('[Payments] POST /:id/receipt/email error:', err.message);
            const status = err.httpStatus || 500;
            res.status(status).json({ ok: false, error: { code: err.code || 'INTERNAL', message: err.message } });
        }
    }
);

// GET /api/payments/:id/receipt — Get receipt
router.get('/:id/receipt', requirePermission('payments.view'), async (req, res) => {
    try {
        const companyId = req.companyFilter?.company_id;
        const { id } = req.params;

        const result = await paymentsService.getReceipt(companyId, id);
        res.json({ ok: true, data: result });
    } catch (err) {
        console.error('[Payments] GET /:id/receipt error:', err.message);
        const status = err.httpStatus || 500;
        res.status(status).json({ ok: false, error: { code: err.code || 'INTERNAL', message: err.message } });
    }
});

// POST /api/payments/:id/receipt/send — Send receipt to client
router.post('/:id/receipt/send', requirePermission('payments.collect_online', 'payments.collect_offline'), async (req, res) => {
    try {
        const companyId = req.companyFilter?.company_id;
        const userId = req.user?.crmUser?.id || null;
        const { id } = req.params;
        const { channel, recipient } = req.body;

        const result = await paymentsService.sendReceipt(
            companyId,
            userId,
            id,
            {
                channel,
                recipient,
                idempotencyKey: req.get?.('Idempotency-Key'),
            },
            null,
            userActor(userId)
        );
        res.status(201).json({ ok: true, data: result });
    } catch (err) {
        console.error('[Payments] POST /:id/receipt/send error:', err.message);
        const status = err.httpStatus || 500;
        res.status(status).json({ ok: false, error: { code: err.code || 'INTERNAL', message: err.message } });
    }
});

module.exports = router;
