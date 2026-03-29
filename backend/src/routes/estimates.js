/**
 * PF002 Estimates API
 * Sprint 3: real implementations
 */
const express = require('express');
const router = express.Router();
const estimatesService = require('../services/estimatesService');

// =============================================================================
// Estimate CRUD
// =============================================================================

// GET /api/estimates — List estimates with filters
router.get('/', async (req, res) => {
    try {
        const companyId = req.companyId;
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
router.post('/', async (req, res) => {
    try {
        const companyId = req.companyId;
        const userId = req.user?.sub || req.userId;
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
router.get('/:id', async (req, res) => {
    try {
        const companyId = req.companyId;
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
router.put('/:id', async (req, res) => {
    try {
        const companyId = req.companyId;
        const userId = req.user?.sub || req.userId;
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

// DELETE /api/estimates/:id — Delete/archive estimate
router.delete('/:id', async (req, res) => {
    try {
        const companyId = req.companyId;
        const { id } = req.params;

        const result = await estimatesService.deleteEstimate(companyId, id);
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
router.post('/:id/send', async (req, res) => {
    try {
        const companyId = req.companyId;
        const userId = req.user?.sub || req.userId;
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
router.post('/:id/approve', async (req, res) => {
    try {
        const companyId = req.companyId;
        const { id } = req.params;
        const { actor_type, actor_id } = req.body || {};
        const actorType = actor_type || 'user';
        const actorId = actor_id || req.user?.sub || req.userId;

        const result = await estimatesService.approveEstimate(companyId, id, actorType, actorId);
        res.json({ ok: true, data: result });
    } catch (err) {
        console.error('[Estimates] POST /:id/approve error:', err.message);
        const status = err.httpStatus || 500;
        res.status(status).json({ ok: false, error: { code: err.code || 'INTERNAL', message: err.message } });
    }
});

// POST /api/estimates/:id/decline — Mark estimate declined
router.post('/:id/decline', async (req, res) => {
    try {
        const companyId = req.companyId;
        const { id } = req.params;
        const { actor_type, actor_id } = req.body || {};
        const actorType = actor_type || 'user';
        const actorId = actor_id || req.user?.sub || req.userId;

        const result = await estimatesService.declineEstimate(companyId, id, actorType, actorId);
        res.json({ ok: true, data: result });
    } catch (err) {
        console.error('[Estimates] POST /:id/decline error:', err.message);
        const status = err.httpStatus || 500;
        res.status(status).json({ ok: false, error: { code: err.code || 'INTERNAL', message: err.message } });
    }
});

// POST /api/estimates/:id/convert — Convert estimate to invoice (stub — Sprint 4)
router.post('/:id/convert', (req, res) => {
    res.status(501).json({ ok: false, error: { code: 'NOT_IMPLEMENTED', message: 'Convert to invoice is planned for Sprint 4' } });
});

// POST /api/estimates/:id/link-job — Link estimate to job
router.post('/:id/link-job', async (req, res) => {
    try {
        const companyId = req.companyId;
        const { id } = req.params;
        const { job_id } = req.body;

        if (!job_id) {
            return res.status(400).json({ ok: false, error: { code: 'MISSING_FIELD', message: 'job_id is required' } });
        }

        const result = await estimatesService.linkJob(companyId, id, job_id);
        res.json({ ok: true, data: result });
    } catch (err) {
        console.error('[Estimates] POST /:id/link-job error:', err.message);
        const status = err.httpStatus || 500;
        res.status(status).json({ ok: false, error: { code: err.code || 'INTERNAL', message: err.message } });
    }
});

// POST /api/estimates/:id/copy-to-invoice — Copy items to new invoice (stub — Sprint 4)
router.post('/:id/copy-to-invoice', (req, res) => {
    res.status(501).json({ ok: false, error: { code: 'NOT_IMPLEMENTED', message: 'Copy to invoice is planned for Sprint 4' } });
});

// =============================================================================
// Estimate history
// =============================================================================

// GET /api/estimates/:id/revisions — List estimate revisions
router.get('/:id/revisions', async (req, res) => {
    try {
        const companyId = req.companyId;
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
router.get('/:id/events', async (req, res) => {
    try {
        const companyId = req.companyId;
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
router.get('/:id/payments', (req, res) => {
    res.status(501).json({ ok: false, error: { code: 'NOT_IMPLEMENTED', message: 'Payments are planned for Sprint 4' } });
});

// =============================================================================
// Line items
// =============================================================================

// POST /api/estimates/:id/items — Add line item
router.post('/:id/items', async (req, res) => {
    try {
        const companyId = req.companyId;
        const userId = req.user?.sub || req.userId;
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
router.put('/:id/items/:itemId', async (req, res) => {
    try {
        const companyId = req.companyId;
        const userId = req.user?.sub || req.userId;
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
router.delete('/:id/items/:itemId', async (req, res) => {
    try {
        const companyId = req.companyId;
        const userId = req.user?.sub || req.userId;
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
// Attachments & PDF (stubs — not in MVP scope)
// =============================================================================

router.get('/:id/attachments', (req, res) => {
    res.status(501).json({ ok: false, error: { code: 'NOT_IMPLEMENTED', message: 'Attachments are planned for a future sprint' } });
});

router.post('/:id/attachments', (req, res) => {
    res.status(501).json({ ok: false, error: { code: 'NOT_IMPLEMENTED', message: 'Attachments are planned for a future sprint' } });
});

router.get('/:id/pdf', (req, res) => {
    res.status(501).json({ ok: false, error: { code: 'NOT_IMPLEMENTED', message: 'PDF generation is planned for a future sprint' } });
});

module.exports = router;
