/**
 * Zenbooker Scheduling API routes
 * Proxies Zenbooker endpoints for the custom booking flow
 */

const express = require('express');
const router = express.Router();
const { requirePermission } = require('../middleware/authorization');
const zenbookerClient = require('../services/zenbookerClient');
const technicianRosterService = require('../services/technicianRosterService');

// GET /api/zenbooker/service-area-check?postal_code=02101  OR  ?address=Boston+MA
router.get('/service-area-check', async (req, res) => {
    try {
        const { postal_code, address } = req.query;
        if (!postal_code && !address) {
            return res.status(400).json({ ok: false, error: 'postal_code or address is required' });
        }

        // Build params for Zenbooker API (supports postal_code or address)
        const zbParams = {};
        if (postal_code) zbParams.postal_code = postal_code;
        else if (address) zbParams.address = address;

        // Try the scheduling endpoint first
        try {
            const data = await zenbookerClient.checkServiceArea(zbParams);
            return res.json({ ok: true, data });
        } catch (primaryErr) {
            console.warn('[Zenbooker] service_area_check failed, trying territory fallback:', primaryErr.response?.data?.error?.message || primaryErr.message);
        }

        // Fallback: use our territory postal-code matching (only works with postal_code)
        if (!postal_code) {
            return res.json({ ok: true, data: { in_service_area: false, service_territory: null, customer_location: null } });
        }
        try {
            const territoryId = await zenbookerClient.findTerritoryByPostalCode(postal_code);
            const territories = await zenbookerClient.getTerritories();
            const territory = territories.find(t => t.id === territoryId);
            return res.json({
                ok: true,
                data: {
                    in_service_area: true,
                    service_territory: {
                        id: territoryId,
                        name: territory?.name || 'Service Territory',
                        timezone: 'America/New_York',
                    },
                    customer_location: null,
                    _fallback: true,
                },
            });
        } catch (fallbackErr) {
            // Both failed
            return res.json({
                ok: true,
                data: { in_service_area: false, service_territory: null, customer_location: null },
            });
        }
    } catch (err) {
        console.error('[Zenbooker] service-area-check error:', err.message);
        res.status(500).json({ ok: false, error: err.message });
    }
});

// GET /api/zenbooker/timeslots?territory=...&date=...&duration=...
router.get('/timeslots', async (req, res) => {
    try {
        const { territory, date, duration, days, lat, lng } = req.query;
        if (!territory || !date || !duration) {
            return res.status(400).json({ ok: false, error: 'territory, date, duration are required' });
        }
        const params = { territory, date, duration: Number(duration) };
        if (days) params.days = Number(days);
        if (lat) params.lat = Number(lat);
        if (lng) params.lng = Number(lng);

        console.log('[Zenbooker] timeslots request params:', JSON.stringify(params));
        const data = await zenbookerClient.getTimeslots(params);
        res.json({ ok: true, data });
    } catch (err) {
        console.error('[Zenbooker] timeslots error:', err.response?.data || err.message);
        const status = err.response?.status || 500;
        res.status(status).json({
            ok: false,
            error: err.response?.data?.error?.message || err.message,
        });
    }
});

// GET /api/zenbooker/services
// ZB-DECOUPLE C4a (2026-08-09): GET /services and POST /jobs removed — zero
// FE/mobile callers (native job creation goes through /api/jobs; the server-side
// ZB job push lives in leadsService/zb_job_sync until Phase E retires it).

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
