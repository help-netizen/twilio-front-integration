/**
 * Zenbooker Jobs API
 *
 * Full CRUD + status-transition routes for Zenbooker jobs.
 * Mounted at /api/zenbooker/jobs (auth applied at mount point in server.js).
 *
 * Endpoints:
 *   GET    /                — List jobs (query params proxied to Zenbooker)
 *   GET    /:id             — Retrieve a single job
 *   POST   /:id/cancel      — Cancel a job
 *   POST   /:id/reschedule  — Reschedule a job
 *   POST   /:id/assign      — Assign / unassign providers
 *   POST   /:id/notes       — Add a note
 *   POST   /:id/enroute     — Mark as en-route
 *   POST   /:id/start       — Mark as in-progress
 *   POST   /:id/complete    — Mark as complete
 */

const express = require('express');
const router = express.Router();
const zenbookerClient = require('../../services/zenbookerClient');

// ─── GET / — List jobs ────────────────────────────────────────────────────────

router.get('/', async (req, res) => {
    try {
        const data = await zenbookerClient.getJobs(req.query);
        res.json({ ok: true, data });
    } catch (err) {
        console.error('[ZbJobs] list error:', err.response?.data || err.message);
        const status = err.response?.status || 500;
        res.status(status).json({
            ok: false,
            error: err.response?.data?.error?.message || err.message,
        });
    }
});

// ─── GET /:id — Retrieve a single job ─────────────────────────────────────────

router.get('/:id', async (req, res) => {
    try {
        const data = await zenbookerClient.getJob(req.params.id);
        res.json({ ok: true, data });
    } catch (err) {
        console.error(`[ZbJobs] get ${req.params.id} error:`, err.response?.data || err.message);
        const status = err.response?.status || 500;
        res.status(status).json({
            ok: false,
            error: err.response?.data?.error?.message || err.message,
        });
    }
});

// ─── POST /:id/cancel — Cancel a job ──────────────────────────────────────────

router.post('/:id/cancel', async (req, res) => {
    try {
        const data = await zenbookerClient.cancelJob(req.params.id);
        res.json({ ok: true, data });
    } catch (err) {
        console.error(`[ZbJobs] cancel ${req.params.id} error:`, err.response?.data || err.message);
        const status = err.response?.status || 500;
        res.status(status).json({
            ok: false,
            error: err.response?.data?.error?.message || err.message,
        });
    }
});

// ─── POST /:id/reschedule — Reschedule a job ──────────────────────────────────

router.post('/:id/reschedule', async (req, res) => {
    try {
        const { start_date, arrival_window_minutes } = req.body;
        if (!start_date) {
            return res.status(400).json({ ok: false, error: 'start_date is required (ISO 8601)' });
        }
        const payload = { start_date };
        if (arrival_window_minutes !== undefined) {
            payload.arrival_window_minutes = Number(arrival_window_minutes);
        }
        const data = await zenbookerClient.rescheduleJob(req.params.id, payload);
        res.json({ ok: true, data });
    } catch (err) {
        console.error(`[ZbJobs] reschedule ${req.params.id} error:`, err.response?.data || err.message);
        const status = err.response?.status || 500;
        res.status(status).json({
            ok: false,
            error: err.response?.data?.error?.message || err.message,
        });
    }
});

// ─── POST /:id/assign — Assign / unassign providers ──────────────────────────

router.post('/:id/assign', async (req, res) => {
    try {
        const { assign, unassign, notify } = req.body;
        if ((!Array.isArray(assign) || assign.length === 0) &&
            (!Array.isArray(unassign) || unassign.length === 0)) {
            return res.status(400).json({
                ok: false,
                error: 'At least one non-empty array for assign or unassign is required',
            });
        }
        const payload = {};
        if (Array.isArray(assign) && assign.length > 0) payload.assign = assign;
        if (Array.isArray(unassign) && unassign.length > 0) payload.unassign = unassign;
        if (notify !== undefined) payload.notify = Boolean(notify);

        const data = await zenbookerClient.assignProviders(req.params.id, payload);
        res.json({ ok: true, data });
    } catch (err) {
        console.error(`[ZbJobs] assign ${req.params.id} error:`, err.response?.data || err.message);
        const status = err.response?.status || 500;
        res.status(status).json({
            ok: false,
            error: err.response?.data?.error?.message || err.message,
        });
    }
});

// ─── POST /:id/notes — Add a note to a job ───────────────────────────────────

router.post('/:id/notes', async (req, res) => {
    try {
        const { text, files, image } = req.body;
        if (!text && (!Array.isArray(files) || files.length === 0) && (!Array.isArray(image) || image.length === 0)) {
            return res.status(400).json({ ok: false, error: 'text, files, or image is required' });
        }
        const payload = {};
        if (text) payload.text = text;
        if (Array.isArray(files) && files.length > 0) payload.files = files;
        if (Array.isArray(image) && image.length > 0) payload.image = image;

        const data = await zenbookerClient.addJobNote(req.params.id, payload);
        res.json({ ok: true, data });
    } catch (err) {
        console.error(`[ZbJobs] add-note ${req.params.id} error:`, err.response?.data || err.message);
        const status = err.response?.status || 500;
        res.status(status).json({
            ok: false,
            error: err.response?.data?.error?.message || err.message,
        });
    }
});

// ─── POST /:id/enroute — Mark as en-route ────────────────────────────────────

router.post('/:id/enroute', async (req, res) => {
    try {
        const payload = {};
        if (req.body.date_time_enroute) payload.date_time_enroute = req.body.date_time_enroute;
        if (req.body.eta_minutes !== undefined) payload.eta_minutes = Number(req.body.eta_minutes);

        const data = await zenbookerClient.markJobEnroute(req.params.id, payload);
        res.json({ ok: true, data });
    } catch (err) {
        console.error(`[ZbJobs] enroute ${req.params.id} error:`, err.response?.data || err.message);
        const status = err.response?.status || 500;
        res.status(status).json({
            ok: false,
            error: err.response?.data?.error?.message || err.message,
        });
    }
});

// ─── POST /:id/start — Mark as in-progress ───────────────────────────────────

router.post('/:id/start', async (req, res) => {
    try {
        const payload = {};
        if (req.body.date_time_started) payload.date_time_started = req.body.date_time_started;

        const data = await zenbookerClient.markJobInProgress(req.params.id, payload);
        res.json({ ok: true, data });
    } catch (err) {
        console.error(`[ZbJobs] start ${req.params.id} error:`, err.response?.data || err.message);
        const status = err.response?.status || 500;
        res.status(status).json({
            ok: false,
            error: err.response?.data?.error?.message || err.message,
        });
    }
});

// ─── POST /:id/complete — Mark as complete ───────────────────────────────────

router.post('/:id/complete', async (req, res) => {
    try {
        const payload = {};
        if (req.body.date_time_completed) payload.date_time_completed = req.body.date_time_completed;

        const data = await zenbookerClient.markJobComplete(req.params.id, payload);
        res.json({ ok: true, data });
    } catch (err) {
        console.error(`[ZbJobs] complete ${req.params.id} error:`, err.response?.data || err.message);
        const status = err.response?.status || 500;
        res.status(status).json({
            ok: false,
            error: err.response?.data?.error?.message || err.message,
        });
    }
});

module.exports = router;
