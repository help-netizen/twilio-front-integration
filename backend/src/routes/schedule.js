/**
 * PF001 Schedule / Dispatcher API
 * Sprint 2: real implementations
 */
const express = require('express');
const router = express.Router();
const scheduleService = require('../services/scheduleService');
const slotEngineService = require('../services/slotEngineService');
const marketplaceService = require('../services/marketplaceService');
const timeOffService = require('../services/timeOffService');
const technicianAvailabilityService = require('../services/technicianAvailabilityService');
const technicianServiceAreaService = require('../services/technicianServiceAreaService');
const { requirePermission } = require('../middleware/authorization');
const { getProviderScope } = require('../middleware/providerScope');

// =============================================================================
// Schedule items (unified read model over jobs + leads + tasks)
// =============================================================================

// GET /api/schedule — List schedule items with filters
router.get('/', requirePermission('schedule.view'), async (req, res) => {
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

        const result = await scheduleService.getScheduleItems(companyId, filters, getProviderScope(req));
        res.json({ ok: true, data: result });
    } catch (err) {
        console.error('[Schedule] GET / error:', err.message);
        const status = err.httpStatus || 500;
        res.status(status).json({ ok: false, error: { code: err.code || 'INTERNAL', message: err.message } });
    }
});

// GET /api/schedule/items/:entityType/:entityId — Single schedule item detail
router.get('/items/:entityType/:entityId', requirePermission('schedule.view'), async (req, res) => {
    try {
        const companyId = req.companyFilter?.company_id;
        const { entityType, entityId } = req.params;

        const result = await scheduleService.getScheduleItemDetail(companyId, entityType, entityId, getProviderScope(req));
        res.json({ ok: true, data: result });
    } catch (err) {
        console.error('[Schedule] GET /items detail error:', err.message);
        const status = err.httpStatus || 500;
        res.status(status).json({ ok: false, error: { code: err.code || 'INTERNAL', message: err.message } });
    }
});

// PATCH /api/schedule/items/:entityType/:entityId/reschedule — Reschedule item
router.patch('/items/:entityType/:entityId/reschedule', requirePermission('schedule.dispatch'), async (req, res) => {
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
router.patch('/items/:entityType/:entityId/reassign', requirePermission('schedule.dispatch'), async (req, res) => {
    try {
        const companyId = req.companyFilter?.company_id;
        const { entityType, entityId } = req.params;
        const { assignees, assignee_id, assignee_name } = req.body;

        // Prefer the multi-provider `assignees` array; fall back to the legacy
        // single {assignee_id, assignee_name} (Schedule drag). null/[] = unassign.
        let list;
        if (Array.isArray(assignees)) {
            list = assignees;
        } else if (assignee_id !== undefined) {
            list = assignee_id ? [{ id: assignee_id, name: assignee_name ?? null }] : [];
        } else {
            return res.status(400).json({ ok: false, error: { code: 'MISSING_FIELD', message: 'assignees (array) or assignee_id (use null to unassign) is required' } });
        }

        const result = await scheduleService.reassignItem(companyId, entityType, entityId, list);
        res.json({ ok: true, data: result });
    } catch (err) {
        console.error('[Schedule] PATCH reassign error:', err.message);
        const status = err.httpStatus || 500;
        res.status(status).json({ ok: false, error: { code: err.code || 'INTERNAL', message: err.message } });
    }
});

// POST /api/schedule/items/from-slot — Create entity from schedule slot
router.post('/items/from-slot', requirePermission('schedule.dispatch'), async (req, res) => {
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

// GET /api/schedule/route-segments — SCHED-ROUTE-001 FR-009 stored route segments
// (no Google calls). Provider scope applied: assigned_only sees only own segments.
router.get('/route-segments', requirePermission('schedule.view'), async (req, res) => {
    try {
        const companyId = req.companyFilter?.company_id;
        const { from, to, technician_id } = req.query;
        const result = await scheduleService.getRouteSegments(
            companyId, { from, to, technicianId: technician_id }, getProviderScope(req));
        res.json({ ok: true, data: result });
    } catch (err) {
        console.error('[Schedule] GET route-segments error:', err.message);
        res.status(err.httpStatus || 500).json({ ok: false, error: { code: err.code || 'INTERNAL', message: err.message } });
    }
});

// =============================================================================
// Dispatch settings
// =============================================================================

// GET /api/schedule/settings — Get dispatch settings
router.get('/settings', requirePermission('schedule.dispatch'), async (req, res) => {
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
router.patch('/settings', requirePermission('schedule.dispatch'), async (req, res) => {
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

// =============================================================================
// Slot recommendations — proxy to the standalone slot engine (SLOT-ENGINE-001 P2)
// =============================================================================

// POST /api/schedule/slot-recommendations — recommend arrival time-frame + technician.
// Gated on the Smart Slot Engine marketplace app being connected. When not connected,
// returns { enabled:false } without calling the engine. Engine faults degrade safely.
router.post('/slot-recommendations', requirePermission('schedule.dispatch'), async (req, res) => {
    const companyId = req.companyFilter?.company_id;
    try {
        const enabled = await marketplaceService.isAppConnected(
            companyId,
            marketplaceService.SMART_SLOT_ENGINE_APP_KEY
        );
        if (!enabled) {
            return res.json({ ok: true, data: { enabled: false, recommendations: [] } });
        }
        const result = await slotEngineService.getRecommendations(companyId, req.body || {});
        return res.json({ ok: true, data: { enabled: true, ...result } });
    } catch (err) {
        return res.status(err.httpStatus || 500).json({
            ok: false,
            error: { code: err.code || 'INTERNAL', message: err.message },
        });
    }
});

// =============================================================================
// Technician time off — TECH-DAYOFF-001
// =============================================================================

// POST /api/schedule/technician-service-area-matches — Albusto active-mode
// eligibility for the manual picker. It never uses Zenbooker territories and
// never blocks manual selection.
router.post('/technician-service-area-matches', requirePermission('schedule.view'), async (req, res) => {
    try {
        const companyId = req.companyFilter?.company_id;
        const data = await technicianServiceAreaService.getTechnicianMatches(companyId, {
            query: req.body?.address || req.body?.query || '',
            lat: req.body?.lat,
            lng: req.body?.lng,
        });
        res.json({ ok: true, data });
    } catch (err) {
        console.error('[Schedule] POST /technician-service-area-matches error:', err.message);
        res.status(err.httpStatus || 500).json({
            ok: false,
            error: { code: err.code || 'INTERNAL', message: err.message },
        });
    }
});

// GET /api/schedule/unavailability?from&to[&technician_id] — the one read seam
// combining explicit time off with derived recurring-schedule gaps. Synthetic
// blocks are read-only and never enter technician_time_off.
router.get('/unavailability', requirePermission('schedule.view'), async (req, res) => {
    try {
        const companyId = req.companyFilter?.company_id;
        const { from, to, technician_id } = req.query;
        const items = await technicianAvailabilityService.listUnavailability(
            companyId,
            { from, to, technicianId: technician_id },
            getProviderScope(req)
        );
        res.json({ ok: true, data: { unavailability: items } });
    } catch (err) {
        console.error('[Schedule] GET /unavailability error:', err.message);
        const status = err.httpStatus || 500;
        res.status(status).json({ ok: false, error: { code: err.code || 'INTERNAL', message: err.message } });
    }
});

// GET /api/schedule/time-off?from&to[&technician_id] — records overlapping
// [from, to). Provider (assigned_only) scope: forced onto the caller's own
// bridged ZB id; no bridge mapping → empty list (deny-by-default).
router.get('/time-off', requirePermission('schedule.view'), async (req, res) => {
    try {
        const companyId = req.companyFilter?.company_id;
        const { from, to, technician_id } = req.query;
        const items = await timeOffService.listTimeOff(
            companyId,
            { from, to, technicianId: technician_id },
            getProviderScope(req)
        );
        res.json({ ok: true, data: { time_off: items } });
    } catch (err) {
        console.error('[Schedule] GET /time-off error:', err.message);
        const status = err.httpStatus || 500;
        res.status(status).json({ ok: false, error: { code: err.code || 'INTERNAL', message: err.message } });
    }
});

// POST /api/schedule/time-off — create day-off: target 'technician' → 1 row,
// target 'company' → materialized K rows (one atomic multi-row INSERT).
router.post('/time-off', requirePermission('schedule.dispatch'), async (req, res) => {
    try {
        const companyId = req.companyFilter?.company_id;
        const createdBy = req.user?.crmUser?.id || null; // crm_users.id, NOT the Keycloak sub
        const created = await timeOffService.createTimeOff(companyId, req.body || {}, createdBy);
        res.status(201).json({ ok: true, data: { created } });
    } catch (err) {
        console.error('[Schedule] POST /time-off error:', err.message);
        const status = err.httpStatus || 500;
        res.status(status).json({ ok: false, error: { code: err.code || 'INTERNAL', message: err.message } });
    }
});

// DELETE /api/schedule/time-off/:id — always per-row (batch_id is audit-only);
// missing id and a foreign tenant's id are the same 404.
router.delete('/time-off/:id', requirePermission('schedule.dispatch'), async (req, res) => {
    try {
        const companyId = req.companyFilter?.company_id;
        const result = await timeOffService.deleteTimeOff(companyId, req.params.id);
        res.json({ ok: true, data: result });
    } catch (err) {
        console.error('[Schedule] DELETE /time-off error:', err.message);
        const status = err.httpStatus || 500;
        res.status(status).json({ ok: false, error: { code: err.code || 'INTERNAL', message: err.message } });
    }
});

module.exports = router;
