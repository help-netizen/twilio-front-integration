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
        const data = await zenbookerClient.checkServiceArea(postal_code);
        res.json({ ok: true, data });
    } catch (err) {
        console.error('[Zenbooker] service-area-check error:', err.response?.data || err.message);
        const status = err.response?.status || 500;
        res.status(status).json({
            ok: false,
            error: err.response?.data?.error?.message || err.message,
        });
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

module.exports = router;
