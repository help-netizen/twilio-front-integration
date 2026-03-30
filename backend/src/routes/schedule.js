/**
 * PF001 Schedule / Dispatcher API
 * Sprint 2: real implementations
 */
const express = require('express');
const router = express.Router();
const scheduleService = require('../services/scheduleService');

// =============================================================================
// Schedule items (unified read model over jobs + leads + tasks)
// =============================================================================

// GET /api/schedule — List schedule items with filters
router.get('/', async (req, res) => {
    try {
        const companyId = req.companyFilter?.company_id;
        const {
            start_date,
            end_date,
            entity_types,
            statuses,
            assignee_id,
            unassigned_only,
            search,
            limit,
            offset,
        } = req.query;

        const filters = {};
        if (start_date)      filters.startDate = start_date;
        if (end_date)        filters.endDate = end_date;
        if (entity_types)    filters.entityTypes = entity_types.split(',').map(s => s.trim());
        if (statuses)        filters.statuses = statuses.split(',').map(s => s.trim());
        if (assignee_id)     filters.assigneeId = assignee_id;
        if (unassigned_only === 'true') filters.unassignedOnly = true;
        if (search)          filters.search = search;
        if (limit)           filters.limit = parseInt(limit, 10);
        if (offset)          filters.offset = parseInt(offset, 10);

        const result = await scheduleService.getScheduleItems(companyId, filters);
        res.json({ ok: true, data: result });
    } catch (err) {
        console.error('[Schedule] GET / error:', err.message);
        const status = err.httpStatus || 500;
        res.status(status).json({ ok: false, error: { code: err.code || 'INTERNAL', message: err.message } });
    }
});

// GET /api/schedule/items/:entityType/:entityId — Single schedule item detail
router.get('/items/:entityType/:entityId', async (req, res) => {
    try {
        const companyId = req.companyFilter?.company_id;
        const { entityType, entityId } = req.params;

        const result = await scheduleService.getScheduleItemDetail(companyId, entityType, entityId);
        res.json({ ok: true, data: result });
    } catch (err) {
        console.error('[Schedule] GET /items detail error:', err.message);
        const status = err.httpStatus || 500;
        res.status(status).json({ ok: false, error: { code: err.code || 'INTERNAL', message: err.message } });
    }
});

// PATCH /api/schedule/items/:entityType/:entityId/reschedule — Reschedule item
router.patch('/items/:entityType/:entityId/reschedule', async (req, res) => {
    try {
        const companyId = req.companyFilter?.company_id;
        const { entityType, entityId } = req.params;
        const { start_at, end_at } = req.body;

        if (!start_at) {
            return res.status(400).json({ ok: false, error: { code: 'MISSING_FIELD', message: 'start_at is required' } });
        }

        const result = await scheduleService.rescheduleItem(companyId, entityType, entityId, start_at, end_at || null);
        res.json({ ok: true, data: result });
    } catch (err) {
        console.error('[Schedule] PATCH reschedule error:', err.message);
        const status = err.httpStatus || 500;
        res.status(status).json({ ok: false, error: { code: err.code || 'INTERNAL', message: err.message } });
    }
});

// PATCH /api/schedule/items/:entityType/:entityId/reassign — Reassign item
router.patch('/items/:entityType/:entityId/reassign', async (req, res) => {
    try {
        const companyId = req.companyFilter?.company_id;
        const { entityType, entityId } = req.params;
        const { assignee_id } = req.body;

        if (!assignee_id) {
            return res.status(400).json({ ok: false, error: { code: 'MISSING_FIELD', message: 'assignee_id is required' } });
        }

        const result = await scheduleService.reassignItem(companyId, entityType, entityId, assignee_id);
        res.json({ ok: true, data: result });
    } catch (err) {
        console.error('[Schedule] PATCH reassign error:', err.message);
        const status = err.httpStatus || 500;
        res.status(status).json({ ok: false, error: { code: err.code || 'INTERNAL', message: err.message } });
    }
});

// POST /api/schedule/items/from-slot — Create entity from schedule slot
router.post('/items/from-slot', async (req, res) => {
    try {
        const companyId = req.companyFilter?.company_id;
        const { entity_type, ...slotData } = req.body;

        if (!entity_type) {
            return res.status(400).json({ ok: false, error: { code: 'MISSING_FIELD', message: 'entity_type is required' } });
        }

        const result = await scheduleService.createFromSlot(companyId, entity_type, slotData);
        res.status(201).json({ ok: true, data: result });
    } catch (err) {
        console.error('[Schedule] POST from-slot error:', err.message);
        const status = err.httpStatus || 500;
        res.status(status).json({ ok: false, error: { code: err.code || 'INTERNAL', message: err.message } });
    }
});

// =============================================================================
// Dispatch settings
// =============================================================================

// GET /api/schedule/settings — Get dispatch settings
router.get('/settings', async (req, res) => {
    try {
        const companyId = req.companyFilter?.company_id;
        const settings = await scheduleService.getDispatchSettings(companyId);
        res.json({ ok: true, data: settings });
    } catch (err) {
        console.error('[Schedule] GET /settings error:', err.message);
        const status = err.httpStatus || 500;
        res.status(status).json({ ok: false, error: { code: err.code || 'INTERNAL', message: err.message } });
    }
});

// PATCH /api/schedule/settings — Update dispatch settings
router.patch('/settings', async (req, res) => {
    try {
        const companyId = req.companyFilter?.company_id;
        const updates = req.body;

        if (!updates || Object.keys(updates).length === 0) {
            return res.status(400).json({ ok: false, error: { code: 'MISSING_FIELD', message: 'No settings provided' } });
        }

        const settings = await scheduleService.updateDispatchSettings(companyId, updates);
        res.json({ ok: true, data: settings });
    } catch (err) {
        console.error('[Schedule] PATCH /settings error:', err.message);
        const status = err.httpStatus || 500;
        res.status(status).json({ ok: false, error: { code: err.code || 'INTERNAL', message: err.message } });
    }
});

// =============================================================================
// Provider availability (stub — to be implemented in Sprint 3)
// =============================================================================

router.get('/availability', (req, res) => {
    res.status(501).json({ ok: false, error: { code: 'NOT_IMPLEMENTED', message: 'Provider availability is planned for Sprint 3' } });
});

module.exports = router;
