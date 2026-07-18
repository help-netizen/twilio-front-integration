/**
 * PF004 Payments API (canonical payment ledger)
 * Sprint 5: real implementations
 *
 * Separate from legacy /api/zenbooker/payments which remains for sync.
 */
const express = require('express');
const router = express.Router();
const paymentsService = require('../services/paymentsService');
const { requirePermission } = require('../middleware/authorization');

// =============================================================================
// Payment transactions
// =============================================================================

// GET /api/payments — List payment transactions
router.get('/', requirePermission('payments.view'), async (req, res) => {
    try {
        const companyId = req.companyFilter?.company_id;
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

// POST /api/payments — Create payment transaction
router.post('/', requirePermission('payments.collect_online'), async (req, res) => {
    try {
        const companyId = req.companyFilter?.company_id;
        const userId = req.user?.crmUser?.id || req.user?.sub || req.userId;
        const data = req.body;

        const result = await paymentsService.createTransaction(companyId, userId, data);
        res.status(201).json({ ok: true, data: result });
    } catch (err) {
        console.error('[Payments] POST / error:', err.message);
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

// POST /api/payments/manual — Record manual/offline payment (BEFORE /:id routes)
router.post('/manual', requirePermission('payments.collect_offline'), async (req, res) => {
    try {
        const companyId = req.companyFilter?.company_id;
        const userId = req.user?.crmUser?.id || req.user?.sub || req.userId;
        const data = req.body;

        const result = await paymentsService.recordManualPayment(companyId, userId, data);
        res.status(201).json({ ok: true, data: result });
    } catch (err) {
        console.error('[Payments] POST /manual error:', err.message);
        const status = err.httpStatus || 500;
        res.status(status).json({ ok: false, error: { code: err.code || 'INTERNAL', message: err.message } });
    }
});

// GET /api/payments/manual-card-sessions/:sessionId/result — reconcile keyed card.
// Literal route stays before /:id; success intentionally has exactly four keys.
router.get('/manual-card-sessions/:sessionId/result', requirePermission('payments.collect_keyed'), async (req, res) => {
    try {
        const stripePaymentsService = require('../services/stripePaymentsService');
        const companyId = req.companyFilter?.company_id;
        const result = await stripePaymentsService.getManualCardSessionResult(companyId, req.params.sessionId);
        res.json(result);
    } catch (err) {
        const status = err.httpStatus || 500;
        res.status(status).json({ ok: false, error: { code: err.code || 'INTERNAL', message: err.message } });
    }
});

// POST /api/payments/manual-card-sessions/:sessionId/receipt — ask Stripe to
// send its native connected-account receipt; never write the email to logs.
router.post('/manual-card-sessions/:sessionId/receipt', requirePermission('payments.collect_keyed'), async (req, res) => {
    try {
        const stripePaymentsService = require('../services/stripePaymentsService');
        const companyId = req.companyFilter?.company_id;
        const result = await stripePaymentsService.sendManualCardReceipt(
            companyId,
            req.params.sessionId,
            req.body?.email
        );
        res.json(result);
    } catch (err) {
        const status = err.httpStatus || 500;
        res.status(status).json({ ok: false, error: { code: err.code || 'INTERNAL', message: err.message } });
    }
});

// GET /api/payments/:id — Get payment transaction by ID
router.get('/:id', requirePermission('payments.view'), async (req, res) => {
    try {
        const companyId = req.companyFilter?.company_id;
        const { id } = req.params;

        const result = await paymentsService.getTransaction(companyId, id);
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
        const userId = req.user?.crmUser?.id || req.user?.sub || req.userId;
        const { id } = req.params;
        const { amount, reason } = req.body;

        const result = await paymentsService.refundTransaction(companyId, userId, id, { amount, reason });
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
        const result = await stripePaymentsService.refundStripePayment(companyId, { id: req.user?.sub || req.userId }, req.params.id, { amount, reason });
        res.status(201).json({ ok: true, data: result });
    } catch (err) {
        if (err.name === 'StripePaymentsError') {
            return res.status(err.httpStatus || 400).json({ ok: false, error: { code: err.code, message: err.message } });
        }
        console.error('[Payments] POST /:id/stripe-refund error:', err.message);
        res.status(err.httpStatus || 500).json({ ok: false, error: { code: err.code || 'INTERNAL', message: err.message } });
    }
});

// POST /api/payments/:id/void — Void payment
router.post('/:id/void', requirePermission('payments.refund'), async (req, res) => {
    try {
        const companyId = req.companyFilter?.company_id;
        const userId = req.user?.crmUser?.id || req.user?.sub || req.userId;
        const { id } = req.params;

        const result = await paymentsService.voidTransaction(companyId, userId, id);
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
        const userId = req.user?.crmUser?.id || req.user?.sub || req.userId;
        const { id } = req.params;
        const { channel, recipient } = req.body;

        const result = await paymentsService.sendReceipt(companyId, userId, id, { channel, recipient });
        res.status(201).json({ ok: true, data: result });
    } catch (err) {
        console.error('[Payments] POST /:id/receipt/send error:', err.message);
        const status = err.httpStatus || 500;
        res.status(status).json({ ok: false, error: { code: err.code || 'INTERNAL', message: err.message } });
    }
});

module.exports = router;
