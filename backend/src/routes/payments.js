/**
 * PF004 Payments API (canonical payment ledger)
 * Sprint 5: real implementations
 *
 * Separate from legacy /api/zenbooker/payments which remains for sync.
 */
const express = require('express');
const router = express.Router();
const paymentsService = require('../services/paymentsService');

// =============================================================================
// Payment transactions
// =============================================================================

// GET /api/payments — List payment transactions
router.get('/', async (req, res) => {
    try {
        const companyId = req.companyId;
        const {
            status,
            transaction_type,
            payment_method,
            contact_id,
            invoice_id,
            estimate_id,
            job_id,
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
router.post('/', async (req, res) => {
    try {
        const companyId = req.companyId;
        const userId = req.user?.sub || req.userId;
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
router.get('/summary', async (req, res) => {
    try {
        const companyId = req.companyId;
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
router.post('/manual', async (req, res) => {
    try {
        const companyId = req.companyId;
        const userId = req.user?.sub || req.userId;
        const data = req.body;

        const result = await paymentsService.recordManualPayment(companyId, userId, data);
        res.status(201).json({ ok: true, data: result });
    } catch (err) {
        console.error('[Payments] POST /manual error:', err.message);
        const status = err.httpStatus || 500;
        res.status(status).json({ ok: false, error: { code: err.code || 'INTERNAL', message: err.message } });
    }
});

// GET /api/payments/:id — Get payment transaction by ID
router.get('/:id', async (req, res) => {
    try {
        const companyId = req.companyId;
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
router.post('/:id/refund', async (req, res) => {
    try {
        const companyId = req.companyId;
        const userId = req.user?.sub || req.userId;
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

// POST /api/payments/:id/void — Void payment
router.post('/:id/void', async (req, res) => {
    try {
        const companyId = req.companyId;
        const userId = req.user?.sub || req.userId;
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
router.get('/:id/receipt', async (req, res) => {
    try {
        const companyId = req.companyId;
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
router.post('/:id/receipt/send', async (req, res) => {
    try {
        const companyId = req.companyId;
        const userId = req.user?.sub || req.userId;
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
