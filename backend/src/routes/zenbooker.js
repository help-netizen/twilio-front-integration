/**
 * Compatibility route for clients still using the historical Zenbooker path.
 * The data source is the native technician directory.
 */

const express = require('express');
const router = express.Router();
const { requirePermission } = require('../middleware/authorization');
const technicianRosterService = require('../services/technicianRosterService');

// ZB-DECOUPLE C4b (2026-08-09): GET /service-area-check and GET /timeslots
// removed — the convert wizards run on the native slot-recommendation engine
// (/api/schedule/slot-recommendations) and the local /api/zip-check; conversion
// itself is native (leadsService overrides.schedule). The ONLY route left here
// is the native /team-members compatibility alias.

// GET /api/zenbooker/services
// ZB-DECOUPLE C4a (2026-08-09): GET /services and POST /jobs removed — zero
// FE/mobile callers (native job creation goes through /api/jobs).

// GET /api/zenbooker/team-members — Fetch native service providers. Consumers
// only read {id, name} (audited 2026-08-09), and the service keeps id = the
// historical external id when present so assignment flows stay byte-compatible.
router.get('/team-members', requirePermission('schedule.dispatch', 'jobs.assign', 'tenant.company.manage'), async (req, res) => {
    try {
        // Scope to the caller's company; the service validates the UUID.
        const members = await technicianRosterService.listActive(req.companyFilter?.company_id);
        res.json({ ok: true, data: members });
    } catch (err) {
        console.error('[Zenbooker] team-members error:', err.message);
        // TechnicianRosterError carries httpStatus for validation/not-found errors.
        res.status(err.httpStatus || 500).json({
            ok: false,
            error: err.message,
        });
    }
});

module.exports = router;
