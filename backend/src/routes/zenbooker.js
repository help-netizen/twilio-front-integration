/**
 * Zenbooker Scheduling API routes
 * Proxies Zenbooker endpoints for the custom booking flow
 */

const express = require('express');
const router = express.Router();
const { requirePermission } = require('../middleware/authorization');
const technicianRosterService = require('../services/technicianRosterService');

// ZB-DECOUPLE C4b (2026-08-09): GET /service-area-check and GET /timeslots
// removed — the convert wizards run on the native slot-recommendation engine
// (/api/schedule/slot-recommendations) and the local /api/zip-check; conversion
// itself is native (leadsService overrides.schedule). The ONLY route left here
// is /team-members (mode-aware roster; retires with Phase F).

// GET /api/zenbooker/services
// ZB-DECOUPLE C4a (2026-08-09): GET /services and POST /jobs removed — zero
// FE/mobile callers (native job creation goes through /api/jobs).

// GET /api/zenbooker/team-members — Fetch service providers
// ZB-DECOUPLE Phase C1 (spec deferred #1): this route used to call the ZB client
// directly, BYPASSING the technician-directory mode switch — in native mode the
// UI pickers (useProviders / useScheduleData / CompanyUserDialogs) still hit ZB.
// It now serves through the mode-aware roster service: `native` touches ZERO
// Zenbooker; `legacy`/`compare` keep the same ZB fetch. Consumers only read
// {id, name} (audited 2026-08-09), and the service keeps id = the legacy ZB
// external id for native technicians, so assignment flows stay byte-compatible.
router.get('/team-members', requirePermission('schedule.dispatch', 'jobs.assign', 'tenant.company.manage'), async (req, res) => {
    try {
        // Scope to the caller's company (no cross-tenant roster leak; the
        // service validates the UUID and fails closed to legacy behavior).
        const members = await technicianRosterService.listActive(req.companyFilter?.company_id);
        res.json({ ok: true, data: members });
    } catch (err) {
        console.error('[Zenbooker] team-members error:', err.message);
        // TechnicianRosterError carries httpStatus (502 for a ZB outage in legacy mode).
        res.status(err.httpStatus || 500).json({
            ok: false,
            error: err.message,
        });
    }
});

module.exports = router;
