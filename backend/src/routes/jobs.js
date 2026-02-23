/**
 * Local Jobs Routes
 *
 * /api/jobs — CRUD + FSM actions for local Blanc jobs table
 */

const express = require('express');
const router = express.Router();
const jobsService = require('../services/jobsService');

// ─── List Jobs ───────────────────────────────────────────────────────────────

router.get('/', async (req, res) => {
    try {
        const { blanc_status, canceled, search, offset, limit, contact_id, sort_by, sort_order, only_open, start_date, end_date, service_name, provider } = req.query;
        const result = await jobsService.listJobs({
            blancStatus: blanc_status || undefined,
            zbCanceled: canceled,
            search: search || undefined,
            offset: parseInt(offset, 10) || 0,
            limit: parseInt(limit, 10) || 50,
            companyId: req.companyId || undefined,
            contactId: contact_id || undefined,
            sortBy: sort_by || undefined,
            sortOrder: sort_order || undefined,
            onlyOpen: only_open === 'true' || undefined,
            startDate: start_date || undefined,
            endDate: end_date || undefined,
            serviceName: service_name || undefined,
            provider: provider || undefined,
        });
        res.json({ ok: true, data: result });
    } catch (err) {
        console.error('[Jobs API] List error:', err.message);
        res.status(500).json({ ok: false, error: err.message });
    }
});

// ─── Get Job by ID ───────────────────────────────────────────────────────────

router.get('/:id', async (req, res) => {
    try {
        const job = await jobsService.getJobById(req.params.id);
        if (!job) return res.status(404).json({ ok: false, error: 'Job not found' });
        res.json({ ok: true, data: job });
    } catch (err) {
        console.error('[Jobs API] Get error:', err.message);
        res.status(500).json({ ok: false, error: err.message });
    }
});

// ─── Update Blanc Status (manual FSM transition) ────────────────────────────

router.patch('/:id/status', async (req, res) => {
    try {
        const { blanc_status } = req.body;
        if (!blanc_status) return res.status(400).json({ ok: false, error: 'blanc_status required' });
        const result = await jobsService.updateBlancStatus(parseInt(req.params.id, 10), blanc_status);
        res.json({ ok: true, data: result });
    } catch (err) {
        console.error('[Jobs API] Status update error:', err.message);
        const status = err.message.includes('not allowed') || err.message.includes('Invalid') ? 400 : 500;
        res.status(status).json({ ok: false, error: err.message });
    }
});

// ─── Add Note ────────────────────────────────────────────────────────────────

router.post('/:id/notes', async (req, res) => {
    try {
        const { text } = req.body;
        if (!text?.trim()) return res.status(400).json({ ok: false, error: 'text required' });
        const result = await jobsService.addNote(parseInt(req.params.id, 10), text.trim());
        res.json({ ok: true, data: result });
    } catch (err) {
        console.error('[Jobs API] Add note error:', err.message);
        res.status(500).json({ ok: false, error: err.message });
    }
});

// ─── Cancel Job ──────────────────────────────────────────────────────────────

router.post('/:id/cancel', async (req, res) => {
    try {
        const result = await jobsService.cancelJob(parseInt(req.params.id, 10));
        res.json({ ok: true, data: result });
    } catch (err) {
        console.error('[Jobs API] Cancel error:', err.message);
        res.status(err.statusCode || 500).json({ ok: false, error: err.message });
    }
});

// ─── Mark En-route ───────────────────────────────────────────────────────────

router.post('/:id/enroute', async (req, res) => {
    try {
        const result = await jobsService.markEnroute(parseInt(req.params.id, 10));
        res.json({ ok: true, data: result });
    } catch (err) {
        console.error('[Jobs API] En-route error:', err.message);
        res.status(err.statusCode || 500).json({ ok: false, error: err.message });
    }
});

// ─── Mark In-Progress ────────────────────────────────────────────────────────

router.post('/:id/start', async (req, res) => {
    try {
        const result = await jobsService.markInProgress(parseInt(req.params.id, 10));
        res.json({ ok: true, data: result });
    } catch (err) {
        console.error('[Jobs API] Start error:', err.message);
        res.status(err.statusCode || 500).json({ ok: false, error: err.message });
    }
});

// ─── Mark Complete ───────────────────────────────────────────────────────────

router.post('/:id/complete', async (req, res) => {
    try {
        const result = await jobsService.markComplete(parseInt(req.params.id, 10));
        res.json({ ok: true, data: result });
    } catch (err) {
        console.error('[Jobs API] Complete error:', err.message);
        res.status(err.statusCode || 500).json({ ok: false, error: err.message });
    }
});

module.exports = router;
