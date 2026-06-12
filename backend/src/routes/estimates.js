/**
 * PF002 Estimates API
 * Sprint 3: real implementations
 */
const express = require('express');
const router = express.Router();
const estimatesService = require('../services/estimatesService');
const { requirePermission } = require('../middleware/authorization');

// Tenant context comes ONLY from requireCompanyAccess (PF007-HARDENING-001)
function getCompanyId(req) {
    return req.companyFilter?.company_id;
}

function getUserId(req) {
    const userId = req.user?.sub || req.user?.id || req.userId || null;
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(userId || '')
        ? userId
        : null;
}

// =============================================================================
// Estimate CRUD
// =============================================================================

// GET /api/estimates — List estimates with filters
router.get('/', requirePermission('estimates.view'), async (req, res) => {
    try {
        const companyId = getCompanyId(req);
        const {
            status,
            contact_id,
            lead_id,
            job_id,
            search,
            start_date,
            end_date,
            limit,
            offset,
        } = req.query;

        const filters = {};
        if (status)     filters.status = status;
        if (contact_id) filters.contactId = contact_id;
        if (lead_id)    filters.leadId = lead_id;
        if (job_id)     filters.jobId = job_id;
        if (search)     filters.search = search;
        if (start_date) filters.startDate = start_date;
        if (end_date)   filters.endDate = end_date;
        if (req.query.include_archived === 'true') filters.includeArchived = true;
        if (limit)      filters.limit = parseInt(limit, 10);
        if (offset)     filters.offset = parseInt(offset, 10);

        const result = await estimatesService.listEstimates(companyId, filters);
        res.json({ ok: true, data: result });
    } catch (err) {
        console.error('[Estimates] GET / error:', err.message);
        const status = err.httpStatus || 500;
        res.status(status).json({ ok: false, error: { code: err.code || 'INTERNAL', message: err.message } });
    }
});

// POST /api/estimates — Create estimate
router.post('/', requirePermission('estimates.create'), async (req, res) => {
    try {
        const companyId = getCompanyId(req);
        const userId = getUserId(req);
        const data = req.body;

        const result = await estimatesService.createEstimate(companyId, userId, data);
        res.status(201).json({ ok: true, data: result });
    } catch (err) {
        console.error('[Estimates] POST / error:', err.message);
        const status = err.httpStatus || 500;
        res.status(status).json({ ok: false, error: { code: err.code || 'INTERNAL', message: err.message } });
    }
});

// GET /api/estimates/:id — Get estimate by ID
router.get('/:id', requirePermission('estimates.view'), async (req, res) => {
    try {
        const companyId = getCompanyId(req);
        const { id } = req.params;

        const result = await estimatesService.getEstimate(companyId, id);
        res.json({ ok: true, data: result });
    } catch (err) {
        console.error('[Estimates] GET /:id error:', err.message);
        const status = err.httpStatus || 500;
        res.status(status).json({ ok: false, error: { code: err.code || 'INTERNAL', message: err.message } });
    }
});

// PUT /api/estimates/:id — Update estimate
router.put('/:id', requirePermission('estimates.create'), async (req, res) => {
    try {
        const companyId = getCompanyId(req);
        const userId = getUserId(req);
        const { id } = req.params;
        const data = req.body;

        const result = await estimatesService.updateEstimate(companyId, userId, id, data);
        res.json({ ok: true, data: result });
    } catch (err) {
        console.error('[Estimates] PUT /:id error:', err.message);
        const status = err.httpStatus || 500;
        res.status(status).json({ ok: false, error: { code: err.code || 'INTERNAL', message: err.message } });
    }
});

// POST /api/estimates/:id/archive — Archive estimate
router.post('/:id/archive', requirePermission('estimates.create'), async (req, res) => {
    try {
        const companyId = getCompanyId(req);
        const userId = getUserId(req);
        const { id } = req.params;

        const result = await estimatesService.archiveEstimate(companyId, userId, id);
        res.json({ ok: true, data: result });
    } catch (err) {
        console.error('[Estimates] POST /:id/archive error:', err.message);
        const status = err.httpStatus || 500;
        res.status(status).json({ ok: false, error: { code: err.code || 'INTERNAL', message: err.message } });
    }
});

// POST /api/estimates/:id/restore — Restore archived estimate to draft
router.post('/:id/restore', requirePermission('estimates.create'), async (req, res) => {
    try {
        const companyId = getCompanyId(req);
        const userId = getUserId(req);
        const { id } = req.params;

        const result = await estimatesService.restoreEstimate(companyId, userId, id);
        res.json({ ok: true, data: result });
    } catch (err) {
        console.error('[Estimates] POST /:id/restore error:', err.message);
        const status = err.httpStatus || 500;
        res.status(status).json({ ok: false, error: { code: err.code || 'INTERNAL', message: err.message } });
    }
});

// DELETE kept as a compatibility alias for old callers; it archives, never hard-deletes.
router.delete('/:id', requirePermission('estimates.create'), async (req, res) => {
    try {
        const companyId = getCompanyId(req);
        const userId = getUserId(req);
        const { id } = req.params;

        const result = await estimatesService.archiveEstimate(companyId, userId, id);
        res.json({ ok: true, data: result });
    } catch (err) {
        console.error('[Estimates] DELETE /:id error:', err.message);
        const status = err.httpStatus || 500;
        res.status(status).json({ ok: false, error: { code: err.code || 'INTERNAL', message: err.message } });
    }
});

// =============================================================================
// Estimate actions
// =============================================================================

// POST /api/estimates/:id/send — Send estimate to client
router.post('/:id/send', requirePermission('estimates.send'), async (req, res) => {
    try {
        const companyId = getCompanyId(req);
        const userId = getUserId(req);
        const { id } = req.params;
        const { channel, recipient, message } = req.body;

        const result = await estimatesService.sendEstimate(companyId, userId, id, { channel, recipient, message });
        res.json({ ok: true, data: result });
    } catch (err) {
        console.error('[Estimates] POST /:id/send error:', err.message);
        const status = err.httpStatus || 500;
        res.status(status).json({ ok: false, error: { code: err.code || 'INTERNAL', message: err.message } });
    }
});

// POST /api/estimates/:id/approve — Mark estimate approved
router.post('/:id/approve', requirePermission('estimates.send'), async (req, res) => {
    try {
        const companyId = getCompanyId(req);
        const { id } = req.params;
        const { actor_type, actor_id, signature_name, signature_consent } = req.body || {};
        const actorType = actor_type || 'user';
        const actorId = actor_id || getUserId(req);

        const result = await estimatesService.approveEstimate(companyId, id, actorType, actorId, {
            signature_name,
            signature_consent,
        });
        res.json({ ok: true, data: result });
    } catch (err) {
        console.error('[Estimates] POST /:id/approve error:', err.message);
        const status = err.httpStatus || 500;
        res.status(status).json({ ok: false, error: { code: err.code || 'INTERNAL', message: err.message } });
    }
});

// POST /api/estimates/:id/decline — Mark estimate declined
router.post('/:id/decline', requirePermission('estimates.send'), async (req, res) => {
    try {
        const companyId = getCompanyId(req);
        const { id } = req.params;
        const { actor_type, actor_id, reason } = req.body || {};
        const actorType = actor_type || 'user';
        const actorId = actor_id || getUserId(req);

        const result = await estimatesService.declineEstimate(companyId, id, actorType, actorId, { reason });
        res.json({ ok: true, data: result });
    } catch (err) {
        console.error('[Estimates] POST /:id/decline error:', err.message);
        const status = err.httpStatus || 500;
        res.status(status).json({ ok: false, error: { code: err.code || 'INTERNAL', message: err.message } });
    }
});

// POST /api/estimates/:id/convert — Convert approved estimate to invoice
router.post('/:id/convert', requirePermission('invoices.create'), async (req, res) => {
    try {
        const companyId = getCompanyId(req);
        const userId = getUserId(req);
        const { id } = req.params;

        const result = await estimatesService.convertToInvoice(companyId, userId, id);
        res.status(201).json({ ok: true, data: result });
    } catch (err) {
        console.error('[Estimates] POST /:id/convert error:', err.message);
        const status = err.httpStatus || 500;
        res.status(status).json({ ok: false, error: { code: err.code || 'INTERNAL', message: err.message } });
    }
});

// POST /api/estimates/:id/link-job — Link estimate to job
router.post('/:id/link-job', requirePermission('estimates.create'), async (req, res) => {
    try {
        const companyId = getCompanyId(req);
        const userId = getUserId(req);
        const { id } = req.params;
        const { job_id } = req.body;

        if (!job_id) {
            return res.status(400).json({ ok: false, error: { code: 'MISSING_FIELD', message: 'job_id is required' } });
        }

        const result = await estimatesService.linkJob(companyId, userId, id, job_id);
        res.json({ ok: true, data: result });
    } catch (err) {
        console.error('[Estimates] POST /:id/link-job error:', err.message);
        const status = err.httpStatus || 500;
        res.status(status).json({ ok: false, error: { code: err.code || 'INTERNAL', message: err.message } });
    }
});

// POST /api/estimates/:id/copy-to-invoice — Copy items to new invoice (stub — Sprint 4)
router.post('/:id/copy-to-invoice', requirePermission('invoices.create'), (req, res) => {
    res.status(501).json({ ok: false, error: { code: 'NOT_IMPLEMENTED', message: 'Copy to invoice is planned for Sprint 4' } });
});

// =============================================================================
// Estimate history
// =============================================================================

// GET /api/estimates/:id/revisions — List estimate revisions
router.get('/:id/revisions', requirePermission('estimates.view'), async (req, res) => {
    try {
        const companyId = getCompanyId(req);
        const { id } = req.params;

        const result = await estimatesService.getRevisions(companyId, id);
        res.json({ ok: true, data: result });
    } catch (err) {
        console.error('[Estimates] GET /:id/revisions error:', err.message);
        const status = err.httpStatus || 500;
        res.status(status).json({ ok: false, error: { code: err.code || 'INTERNAL', message: err.message } });
    }
});

// GET /api/estimates/:id/events — List estimate events
router.get('/:id/events', requirePermission('estimates.view'), async (req, res) => {
    try {
        const companyId = getCompanyId(req);
        const { id } = req.params;

        const result = await estimatesService.getEvents(companyId, id);
        res.json({ ok: true, data: result });
    } catch (err) {
        console.error('[Estimates] GET /:id/events error:', err.message);
        const status = err.httpStatus || 500;
        res.status(status).json({ ok: false, error: { code: err.code || 'INTERNAL', message: err.message } });
    }
});

// GET /api/estimates/:id/payments — List payments linked to estimate (stub — Sprint 4)
router.get('/:id/payments', requirePermission('payments.view'), (req, res) => {
    res.status(501).json({ ok: false, error: { code: 'NOT_IMPLEMENTED', message: 'Payments are planned for Sprint 4' } });
});

// =============================================================================
// Line items
// =============================================================================

// POST /api/estimates/:id/items — Add line item
router.post('/:id/items', requirePermission('estimates.create'), async (req, res) => {
    try {
        const companyId = getCompanyId(req);
        const userId = getUserId(req);
        const { id } = req.params;
        const item = req.body;

        const result = await estimatesService.addItem(companyId, id, userId, item);
        res.status(201).json({ ok: true, data: result });
    } catch (err) {
        console.error('[Estimates] POST /:id/items error:', err.message);
        const status = err.httpStatus || 500;
        res.status(status).json({ ok: false, error: { code: err.code || 'INTERNAL', message: err.message } });
    }
});

// PUT /api/estimates/:id/items/:itemId — Update line item
router.put('/:id/items/:itemId', requirePermission('estimates.create'), async (req, res) => {
    try {
        const companyId = getCompanyId(req);
        const userId = getUserId(req);
        const { id, itemId } = req.params;
        const data = req.body;

        const result = await estimatesService.updateItem(companyId, id, userId, itemId, data);
        res.json({ ok: true, data: result });
    } catch (err) {
        console.error('[Estimates] PUT /:id/items/:itemId error:', err.message);
        const status = err.httpStatus || 500;
        res.status(status).json({ ok: false, error: { code: err.code || 'INTERNAL', message: err.message } });
    }
});

// DELETE /api/estimates/:id/items/:itemId — Remove line item
router.delete('/:id/items/:itemId', requirePermission('estimates.create'), async (req, res) => {
    try {
        const companyId = getCompanyId(req);
        const userId = getUserId(req);
        const { id, itemId } = req.params;

        const result = await estimatesService.removeItem(companyId, id, userId, itemId);
        res.json({ ok: true, data: result });
    } catch (err) {
        console.error('[Estimates] DELETE /:id/items/:itemId error:', err.message);
        const status = err.httpStatus || 500;
        res.status(status).json({ ok: false, error: { code: err.code || 'INTERNAL', message: err.message } });
    }
});

// =============================================================================
// Attachments & PDF
// =============================================================================

router.get('/:id/attachments', requirePermission('estimates.view'), (req, res) => {
    res.status(501).json({ ok: false, error: { code: 'NOT_IMPLEMENTED', message: 'Attachments are planned for a future sprint' } });
});

router.post('/:id/attachments', requirePermission('estimates.create'), (req, res) => {
    res.status(501).json({ ok: false, error: { code: 'NOT_IMPLEMENTED', message: 'Attachments are planned for a future sprint' } });
});

router.get('/:id/pdf', requirePermission('estimates.view'), async (req, res) => {
    try {
        const companyId = getCompanyId(req);
        const { id } = req.params;
        const { estimate, buffer } = await estimatesService.generatePdf(companyId, id);
        const safeNumber = String(estimate.estimate_number || `estimate-${id}`).replace(/[^a-z0-9_-]+/gi, '_');

        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Length', buffer.length);
        res.setHeader('Content-Disposition', `inline; filename="${safeNumber}.pdf"`);
        res.send(buffer);
    } catch (err) {
        console.error('[Estimates] GET /:id/pdf error:', err.message);
        const status = err.httpStatus || 500;
        res.status(status).json({ ok: false, error: { code: err.code || 'INTERNAL', message: err.message } });
    }
});

module.exports = router;
