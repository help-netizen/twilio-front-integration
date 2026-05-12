/**
 * PF003 Invoices API
 * Sprint 4: real implementations
 */
const express = require('express');
const router = express.Router();
const invoicesService = require('../services/invoicesService');

// Resolve the active company scope from any of the supported middleware shapes.
function getCompanyId(req) {
    return req.companyFilter?.company_id || req.user?.company_id || req.companyId;
}

// Return a valid UUID userId or null (dev-mode injects "dev-user" which would break UUID columns).
function getUserId(req) {
    const userId = req.user?.sub || req.user?.id || req.userId || null;
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(userId || '')
        ? userId
        : null;
}

// =============================================================================
// Invoice CRUD
// =============================================================================

// GET /api/invoices — List invoices with filters
router.get('/', async (req, res) => {
    try {
        const companyId = getCompanyId(req);
        const {
            status,
            contact_id,
            lead_id,
            job_id,
            estimate_id,
            search,
            start_date,
            end_date,
            limit,
            offset,
        } = req.query;

        const filters = {};
        if (status)      filters.status = status;
        if (contact_id)  filters.contactId = contact_id;
        if (lead_id)     filters.leadId = lead_id;
        if (job_id)      filters.jobId = job_id;
        if (estimate_id) filters.estimateId = estimate_id;
        if (search)      filters.search = search;
        if (start_date)  filters.startDate = start_date;
        if (end_date)    filters.endDate = end_date;
        if (limit)       filters.limit = parseInt(limit, 10);
        if (offset)      filters.offset = parseInt(offset, 10);

        const result = await invoicesService.listInvoices(companyId, filters);
        res.json({ ok: true, data: result });
    } catch (err) {
        console.error('[Invoices] GET / error:', err.message);
        const status = err.httpStatus || 500;
        res.status(status).json({ ok: false, error: { code: err.code || 'INTERNAL', message: err.message } });
    }
});

// POST /api/invoices — Create invoice
router.post('/', async (req, res) => {
    try {
        const companyId = getCompanyId(req);
        const userId = getUserId(req);
        const data = req.body;

        const result = await invoicesService.createInvoice(companyId, userId, data);
        res.status(201).json({ ok: true, data: result });
    } catch (err) {
        console.error('[Invoices] POST / error:', err.message);
        const status = err.httpStatus || 500;
        res.status(status).json({ ok: false, error: { code: err.code || 'INTERNAL', message: err.message } });
    }
});

// GET /api/invoices/:id — Get invoice by ID
router.get('/:id', async (req, res) => {
    try {
        const companyId = getCompanyId(req);
        const { id } = req.params;

        const result = await invoicesService.getInvoice(companyId, id);
        res.json({ ok: true, data: result });
    } catch (err) {
        console.error('[Invoices] GET /:id error:', err.message);
        const status = err.httpStatus || 500;
        res.status(status).json({ ok: false, error: { code: err.code || 'INTERNAL', message: err.message } });
    }
});

// PUT /api/invoices/:id — Update invoice
router.put('/:id', async (req, res) => {
    try {
        const companyId = getCompanyId(req);
        const userId = getUserId(req);
        const { id } = req.params;
        const data = req.body;

        const result = await invoicesService.updateInvoice(companyId, userId, id, data);
        res.json({ ok: true, data: result });
    } catch (err) {
        console.error('[Invoices] PUT /:id error:', err.message);
        const status = err.httpStatus || 500;
        res.status(status).json({ ok: false, error: { code: err.code || 'INTERNAL', message: err.message } });
    }
});

// DELETE /api/invoices/:id — Delete/void invoice
router.delete('/:id', async (req, res) => {
    try {
        const companyId = getCompanyId(req);
        const { id } = req.params;

        const result = await invoicesService.deleteInvoice(companyId, id);
        res.json({ ok: true, data: result });
    } catch (err) {
        console.error('[Invoices] DELETE /:id error:', err.message);
        const status = err.httpStatus || 500;
        res.status(status).json({ ok: false, error: { code: err.code || 'INTERNAL', message: err.message } });
    }
});

// =============================================================================
// Invoice actions
// =============================================================================

// POST /api/invoices/:id/send — Send invoice to client
router.post('/:id/send', async (req, res) => {
    try {
        const companyId = getCompanyId(req);
        const userId = getUserId(req);
        const { id } = req.params;
        const { channel, recipient, message } = req.body;

        const result = await invoicesService.sendInvoice(companyId, userId, id, { channel, recipient, message });
        res.json({ ok: true, data: result });
    } catch (err) {
        console.error('[Invoices] POST /:id/send error:', err.message);
        const status = err.httpStatus || 500;
        res.status(status).json({ ok: false, error: { code: err.code || 'INTERNAL', message: err.message } });
    }
});

// POST /api/invoices/:id/void — Void invoice
router.post('/:id/void', async (req, res) => {
    try {
        const companyId = getCompanyId(req);
        const userId = getUserId(req);
        const { id } = req.params;

        const result = await invoicesService.voidInvoice(companyId, id, userId);
        res.json({ ok: true, data: result });
    } catch (err) {
        console.error('[Invoices] POST /:id/void error:', err.message);
        const status = err.httpStatus || 500;
        res.status(status).json({ ok: false, error: { code: err.code || 'INTERNAL', message: err.message } });
    }
});

// POST /api/invoices/:id/record-payment — Record payment against invoice
router.post('/:id/record-payment', async (req, res) => {
    try {
        const companyId = getCompanyId(req);
        const userId = getUserId(req);
        const { id } = req.params;
        const { amount, payment_method, reference } = req.body;

        const result = await invoicesService.recordPayment(companyId, userId, id, { amount, payment_method, reference });
        res.json({ ok: true, data: result });
    } catch (err) {
        console.error('[Invoices] POST /:id/record-payment error:', err.message);
        const status = err.httpStatus || 500;
        res.status(status).json({ ok: false, error: { code: err.code || 'INTERNAL', message: err.message } });
    }
});

// POST /api/invoices/:id/sync-items — Sync line items from estimate
router.post('/:id/sync-items', async (req, res) => {
    try {
        const companyId = getCompanyId(req);
        const userId = getUserId(req);
        const { id } = req.params;
        let { estimate_id } = req.body || {};

        // If no estimate_id supplied, fall back to the invoice's linked estimate.
        if (!estimate_id) {
            const existing = await invoicesService.getInvoice(companyId, id);
            estimate_id = existing.estimate_id;
        }

        if (!estimate_id) {
            return res.status(400).json({ ok: false, error: { code: 'MISSING_FIELD', message: 'estimate_id is required (invoice not linked to any estimate)' } });
        }

        const result = await invoicesService.syncItemsFromEstimate(companyId, userId, id, estimate_id);
        res.json({ ok: true, data: result });
    } catch (err) {
        console.error('[Invoices] POST /:id/sync-items error:', err.message);
        const status = err.httpStatus || 500;
        res.status(status).json({ ok: false, error: { code: err.code || 'INTERNAL', message: err.message } });
    }
});

// =============================================================================
// Invoice history
// =============================================================================

// GET /api/invoices/:id/revisions — List invoice revisions
router.get('/:id/revisions', async (req, res) => {
    try {
        const companyId = getCompanyId(req);
        const { id } = req.params;

        const result = await invoicesService.getRevisions(companyId, id);
        res.json({ ok: true, data: result });
    } catch (err) {
        console.error('[Invoices] GET /:id/revisions error:', err.message);
        const status = err.httpStatus || 500;
        res.status(status).json({ ok: false, error: { code: err.code || 'INTERNAL', message: err.message } });
    }
});

// GET /api/invoices/:id/events — List invoice events
router.get('/:id/events', async (req, res) => {
    try {
        const companyId = getCompanyId(req);
        const { id } = req.params;

        const result = await invoicesService.getEvents(companyId, id);
        res.json({ ok: true, data: result });
    } catch (err) {
        console.error('[Invoices] GET /:id/events error:', err.message);
        const status = err.httpStatus || 500;
        res.status(status).json({ ok: false, error: { code: err.code || 'INTERNAL', message: err.message } });
    }
});

// GET /api/invoices/:id/payments — List payments for invoice
router.get('/:id/payments', async (req, res) => {
    try {
        const companyId = getCompanyId(req);
        const { id } = req.params;

        const result = await invoicesService.getPayments(companyId, id);
        res.json({ ok: true, data: result });
    } catch (err) {
        console.error('[Invoices] GET /:id/payments error:', err.message);
        const status = err.httpStatus || 500;
        res.status(status).json({ ok: false, error: { code: err.code || 'INTERNAL', message: err.message } });
    }
});

// =============================================================================
// Line items
// =============================================================================

// POST /api/invoices/:id/items — Add line item
router.post('/:id/items', async (req, res) => {
    try {
        const companyId = getCompanyId(req);
        const userId = getUserId(req);
        const { id } = req.params;
        const item = req.body;

        const result = await invoicesService.addItem(companyId, id, userId, item);
        res.status(201).json({ ok: true, data: result });
    } catch (err) {
        console.error('[Invoices] POST /:id/items error:', err.message);
        const status = err.httpStatus || 500;
        res.status(status).json({ ok: false, error: { code: err.code || 'INTERNAL', message: err.message } });
    }
});

// PUT /api/invoices/:id/items/:itemId — Update line item
router.put('/:id/items/:itemId', async (req, res) => {
    try {
        const companyId = getCompanyId(req);
        const userId = getUserId(req);
        const { id, itemId } = req.params;
        const data = req.body;

        const result = await invoicesService.updateItem(companyId, id, userId, itemId, data);
        res.json({ ok: true, data: result });
    } catch (err) {
        console.error('[Invoices] PUT /:id/items/:itemId error:', err.message);
        const status = err.httpStatus || 500;
        res.status(status).json({ ok: false, error: { code: err.code || 'INTERNAL', message: err.message } });
    }
});

// DELETE /api/invoices/:id/items/:itemId — Remove line item
router.delete('/:id/items/:itemId', async (req, res) => {
    try {
        const companyId = getCompanyId(req);
        const userId = getUserId(req);
        const { id, itemId } = req.params;

        const result = await invoicesService.removeItem(companyId, id, userId, itemId);
        res.json({ ok: true, data: result });
    } catch (err) {
        console.error('[Invoices] DELETE /:id/items/:itemId error:', err.message);
        const status = err.httpStatus || 500;
        res.status(status).json({ ok: false, error: { code: err.code || 'INTERNAL', message: err.message } });
    }
});

// =============================================================================
// Attachments & PDF (stubs — not in MVP scope)
// =============================================================================

router.get('/:id/attachments', (req, res) => {
    res.status(501).json({ ok: false, error: { code: 'NOT_IMPLEMENTED', message: 'Attachments are planned for a future sprint' } });
});

router.post('/:id/attachments', (req, res) => {
    res.status(501).json({ ok: false, error: { code: 'NOT_IMPLEMENTED', message: 'Attachments are planned for a future sprint' } });
});

// POST /api/invoices/:id/public-link — Idempotently mint (or fetch) a tokenized public PDF URL.
router.post('/:id/public-link', async (req, res) => {
    try {
        const companyId = getCompanyId(req);
        const { id } = req.params;
        const result = await invoicesService.ensurePublicLink(companyId, id);
        res.json({ ok: true, data: result });
    } catch (err) {
        console.error('[Invoices] POST /:id/public-link error:', err.message);
        const status = err.httpStatus || 500;
        res.status(status).json({ ok: false, error: { code: err.code || 'INTERNAL', message: err.message } });
    }
});

// GET /api/invoices/:id/pdf — Render the invoice as a PDF buffer (F015 templates).
router.get('/:id/pdf', async (req, res) => {
    try {
        const companyId = getCompanyId(req);
        const { id } = req.params;
        const { invoice, buffer } = await invoicesService.generatePdf(companyId, id);
        const safeNumber = String(invoice.invoice_number || `invoice-${id}`).replace(/[^a-z0-9_-]+/gi, '_');

        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Length', buffer.length);
        res.setHeader('Content-Disposition', `inline; filename="${safeNumber}.pdf"`);
        res.send(buffer);
    } catch (err) {
        console.error('[Invoices] GET /:id/pdf error:', err.message);
        const status = err.httpStatus || 500;
        res.status(status).json({ ok: false, error: { code: err.code || 'INTERNAL', message: err.message } });
    }
});

module.exports = router;
