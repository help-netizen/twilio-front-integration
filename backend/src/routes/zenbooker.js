/**
 * Zenbooker Scheduling API routes
 * Proxies Zenbooker endpoints for the custom booking flow
 */

const express = require('express');
const router = express.Router();
const zenbookerClient = require('../services/zenbookerClient');

// GET /api/zenbooker/service-area-check?postal_code=02101
router.get('/service-area-check', async (req, res) => {
    try {
        const { postal_code } = req.query;
        if (!postal_code) {
            return res.status(400).json({ ok: false, error: 'postal_code is required' });
        }

        // Try the scheduling endpoint first
        try {
            const data = await zenbookerClient.checkServiceArea(postal_code);
            return res.json({ ok: true, data });
        } catch (primaryErr) {
            console.warn('[Zenbooker] service_area_check failed, trying territory fallback:', primaryErr.response?.data?.error?.message || primaryErr.message);
        }

        // Fallback: use our territory postal-code matching
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
router.get('/services', async (req, res) => {
    try {
        const data = await zenbookerClient.getServices();
        res.json({ ok: true, data });
    } catch (err) {
        console.error('[Zenbooker] services error:', err.response?.data || err.message);
        const status = err.response?.status || 500;
        res.status(status).json({
            ok: false,
            error: err.response?.data?.error?.message || err.message,
        });
    }
});

// POST /api/zenbooker/jobs  — create job with direct payload
router.post('/jobs', async (req, res) => {
    try {
        const data = await zenbookerClient.createJob(req.body);
        res.status(201).json({ ok: true, data });
    } catch (err) {
        console.error('[Zenbooker] create-job error:', err.response?.data || err.message);
        const status = err.response?.status || 500;
        res.status(status).json({
            ok: false,
            error: err.response?.data?.error?.message || err.message,
        });
    }
});

// GET /api/zenbooker/team-members — Fetch service providers
router.get('/team-members', async (req, res) => {
    try {
        const members = await zenbookerClient.getTeamMembers({
            service_provider: true,
            deactivated: false,
        });
        res.json({ ok: true, data: members });
    } catch (err) {
        console.error('[Zenbooker] team-members error:', err.response?.data || err.message);
        const status = err.response?.status || 500;
        res.status(status).json({
            ok: false,
            error: err.response?.data?.error?.message || err.message,
        });
    }
});

module.exports = router;
