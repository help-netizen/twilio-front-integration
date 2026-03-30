/**
 * Local Jobs Routes
 *
 * /api/jobs — CRUD + FSM actions for local Blanc jobs table
 */

const express = require('express');
const router = express.Router();
const jobsService = require('../services/jobsService');
const zenbookerClient = require('../services/zenbookerClient');

// ─── Sync Jobs from Zenbooker ────────────────────────────────────────────────

router.post('/sync', async (req, res) => {
    try {
        const companyId = req.companyFilter?.company_id || req.user?.company_id || null;
        // Use per-tenant Zenbooker API key (falls back to global env var)
        const zbClient = await zenbookerClient.getClientForCompany(companyId);
        const makeRequest = (url, params) => zbClient.get(url, { params });

        console.log(`[Jobs Sync] Starting full sync from Zenbooker for company ${companyId}...`);
        let totalSynced = 0;
        let totalCreated = 0;
        let cursor = 0;
        const limit = 100;

        while (true) {
            const zbRes = await makeRequest('/jobs', { limit, cursor, sort_by: 'start_date', sort_order: 'desc' });
            const zbData = zbRes.data;
            const zbJobs = zbData.results || [];
            if (zbJobs.length === 0) break;

            for (const zbJob of zbJobs) {
                try {
                    let fullJob = zbJob;
                    try {
                        const fullRes = await makeRequest(`/jobs/${zbJob.id}`);
                        fullJob = fullRes.data;
                    } catch (fetchErr) {
                        console.warn(`[Jobs Sync] Could not fetch full job ${zbJob.id}, using list data: ${fetchErr.message}`);
                    }
                    const result = await jobsService.syncFromZenbooker(
                        zbJob.id, fullJob, companyId, 'sync_bulk'
                    );
                    totalSynced++;
                    if (result.created) totalCreated++;
                } catch (err) {
                    console.warn(`[Jobs Sync] Failed to sync job ${zbJob.id}:`, err.message);
                }
            }

            console.log(`[Jobs Sync] Batch: ${zbJobs.length} jobs processed (cursor=${cursor})`);
            if (!zbData.has_more) break;
            cursor = zbData.cursor || (cursor + zbJobs.length);
        }

        console.log(`[Jobs Sync] Done: ${totalSynced} synced, ${totalCreated} new`);
        res.json({ ok: true, data: { synced: totalSynced, created: totalCreated } });
    } catch (err) {
        console.error('[Jobs Sync] error:', err.message);
        res.status(500).json({ ok: false, error: err.message });
    }
});

// ─── List Jobs ───────────────────────────────────────────────────────────────

router.get('/', async (req, res) => {
    try {
        const { blanc_status, canceled, search, offset, limit, contact_id, sort_by, sort_order, only_open, start_date, end_date, service_name, provider, tag_ids, tag_match } = req.query;
        const result = await jobsService.listJobs({
            blancStatus: blanc_status || undefined,
            zbCanceled: canceled,
            search: search || undefined,
            offset: parseInt(offset, 10) || 0,
            limit: parseInt(limit, 10) || 50,
            companyId: req.companyFilter?.company_id || req.user?.company_id || undefined,
            contactId: contact_id || undefined,
            sortBy: sort_by || undefined,
            sortOrder: sort_order || undefined,
            onlyOpen: only_open === 'true' || undefined,
            startDate: start_date || undefined,
            endDate: end_date || undefined,
            serviceName: service_name || undefined,
            provider: provider || undefined,
            tagIds: tag_ids || undefined,
            tagMatch: tag_match || undefined,
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
        const companyId = req.companyFilter?.company_id || req.user?.company_id || null;
        const job = await jobsService.getJobById(req.params.id, companyId);
        if (!job) return res.status(404).json({ ok: false, error: 'Job not found' });
        res.json({ ok: true, data: job });
    } catch (err) {
        console.error('[Jobs API] Get error:', err.message);
        res.status(500).json({ ok: false, error: err.message });
    }
});

// ─── Update Job Coordinates ──────────────────────────────────────────────────

router.patch('/:id/coords', async (req, res) => {
    try {
        const companyId = req.companyFilter?.company_id || req.user?.company_id || null;
        const existing = await jobsService.getJobById(req.params.id, companyId);
        if (!existing) return res.status(404).json({ ok: false, error: 'Job not found' });
        const { lat, lng } = req.body;
        if (lat == null || lng == null) return res.status(400).json({ ok: false, error: 'lat and lng required' });
        await jobsService.updateCoords(req.params.id, lat, lng);
        res.json({ ok: true });
    } catch (err) {
        console.error('[Jobs API] Coords update error:', err.message);
        res.status(500).json({ ok: false, error: err.message });
    }
});

// ─── Update Job Tags ─────────────────────────────────────────────────────────

router.patch('/:id/tags', async (req, res) => {
    try {
        const companyId = req.companyFilter?.company_id || req.user?.company_id || null;
        const existing = await jobsService.getJobById(req.params.id, companyId);
        if (!existing) return res.status(404).json({ ok: false, error: 'Job not found' });
        const { tag_ids } = req.body;
        if (!Array.isArray(tag_ids)) return res.status(400).json({ ok: false, error: 'tag_ids array required' });
        const result = await jobsService.updateJobTags(parseInt(req.params.id, 10), tag_ids);
        res.json({ ok: true, data: result });
    } catch (err) {
        console.error('[Jobs API] Update tags error:', err.message);
        res.status(err.statusCode || 500).json({ ok: false, error: err.message });
    }
});

// ─── Update Blanc Status (manual FSM transition) ────────────────────────────

router.patch('/:id/status', async (req, res) => {
    try {
        const companyId = req.companyFilter?.company_id || req.user?.company_id || null;
        const existing = await jobsService.getJobById(req.params.id, companyId);
        if (!existing) return res.status(404).json({ ok: false, error: 'Job not found' });
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
        const companyId = req.companyFilter?.company_id || req.user?.company_id || null;
        const existing = await jobsService.getJobById(req.params.id, companyId);
        if (!existing) return res.status(404).json({ ok: false, error: 'Job not found' });
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
        const companyId = req.companyFilter?.company_id || req.user?.company_id || null;
        const existing = await jobsService.getJobById(req.params.id, companyId);
        if (!existing) return res.status(404).json({ ok: false, error: 'Job not found' });
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
        const companyId = req.companyFilter?.company_id || req.user?.company_id || null;
        const existing = await jobsService.getJobById(req.params.id, companyId);
        if (!existing) return res.status(404).json({ ok: false, error: 'Job not found' });
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
        const companyId = req.companyFilter?.company_id || req.user?.company_id || null;
        const existing = await jobsService.getJobById(req.params.id, companyId);
        if (!existing) return res.status(404).json({ ok: false, error: 'Job not found' });
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
        const companyId = req.companyFilter?.company_id || req.user?.company_id || null;
        const existing = await jobsService.getJobById(req.params.id, companyId);
        if (!existing) return res.status(404).json({ ok: false, error: 'Job not found' });
        const result = await jobsService.markComplete(parseInt(req.params.id, 10));
        res.json({ ok: true, data: result });
    } catch (err) {
        console.error('[Jobs API] Complete error:', err.message);
        res.status(err.statusCode || 500).json({ ok: false, error: err.message });
    }
});
// ─── Reschedule ──────────────────────────────────────────────────────────────

router.post('/:id/reschedule', async (req, res) => {
    const jobId = parseInt(req.params.id, 10);
    const companyId = req.companyFilter?.company_id || req.user?.company_id || null;
    const existing = await jobsService.getJobById(jobId, companyId);
    if (!existing) return res.status(404).json({ ok: false, error: 'Job not found' });
    const { start_date, arrival_window_minutes = 120, tech_id } = req.body;

    if (!start_date) {
        return res.status(400).json({ ok: false, error: 'start_date is required (ISO 8601)' });
    }

    try {
        const db = require('../db/connection');
        const realtimeService = require('../services/realtimeService');

        // 1. Fetch local job to get ZB ID + current techs
        const { rows } = await db.query('SELECT zenbooker_job_id, assigned_techs FROM jobs WHERE id = $1', [jobId]);
        if (!rows.length) return res.status(404).json({ ok: false, error: 'Job not found' });
        const zbJobId = rows[0].zenbooker_job_id;
        const currentTechs = rows[0].assigned_techs || [];

        // 2. Reschedule in Zenbooker (if ZB job exists)
        if (zbJobId) {
            try {
                await zenbookerClient.rescheduleJob(zbJobId, {
                    start_date,
                    arrival_window_minutes: Number(arrival_window_minutes),
                });
                console.log(`[Jobs API] Rescheduled ZB job ${zbJobId} → ${start_date}`);
            } catch (zbErr) {
                console.error(`[Jobs API] ZB reschedule error:`, zbErr.response?.data || zbErr.message);
                return res.status(zbErr.response?.status || 500).json({
                    ok: false,
                    error: zbErr.response?.data?.error?.message || zbErr.message,
                });
            }

            // 3. Reassign technician: unassign old + assign new
            if (tech_id) {
                try {
                    // Unassign all current providers first
                    const oldTechIds = currentTechs
                        .map(t => t.id)
                        .filter(id => id && id !== tech_id);
                    const payload = { assign: [tech_id], notify: false };
                    if (oldTechIds.length > 0) {
                        payload.unassign = oldTechIds;
                    }
                    await zenbookerClient.assignProviders(zbJobId, payload);
                    console.log(`[Jobs API] Reassigned ZB job ${zbJobId}: unassign=[${oldTechIds}] assign=[${tech_id}]`);

                    // Immediately fetch updated job from ZB to get new assigned_providers
                    try {
                        const freshJob = await zenbookerClient.getJob(zbJobId);
                        if (freshJob?.assigned_providers?.length > 0) {
                            await db.query(
                                `UPDATE jobs SET assigned_techs = $1::jsonb, updated_at = NOW() WHERE id = $2`,
                                [JSON.stringify(freshJob.assigned_providers), jobId]
                            );
                            console.log(`[Jobs API] Immediately updated assigned_techs for job ${jobId}`);
                        }
                    } catch (fetchErr) {
                        console.warn(`[Jobs API] Could not immediately sync techs:`, fetchErr.message);
                    }
                } catch (assignErr) {
                    console.warn(`[Jobs API] ZB assign error (non-fatal):`, assignErr.response?.data || assignErr.message);
                }
            }
        }

        // 4. Update local DB immediately with known data
        const endDate = new Date(new Date(start_date).getTime() + Number(arrival_window_minutes) * 60000).toISOString();
        await db.query(
            `UPDATE jobs SET start_date = $1, end_date = $2, zb_rescheduled = true, updated_at = NOW() WHERE id = $3`,
            [start_date, endDate, jobId]
        );

        // 5. Return updated job immediately (frontend gets instant response)
        const updated = await jobsService.getJobById(jobId);
        res.json({ ok: true, data: updated });

        // 6. Background: re-fetch from ZB to sync all fields (techs, status etc.)
        //    Then emit SSE so frontend updates in-place
        if (zbJobId) {
            setImmediate(async () => {
                try {
                    await new Promise(r => setTimeout(r, 3000));
                    const zbJob = await zenbookerClient.getJob(zbJobId);
                    if (zbJob) {
                        await jobsService.syncFromZenbooker(zbJobId, zbJob, null, 'reschedule');
                        const synced = await jobsService.getJobById(jobId);
                        realtimeService.publishJobUpdate(synced);
                        console.log(`[Jobs API] Background ZB sync + SSE for job ${jobId}`);
                    }
                } catch (err) {
                    console.warn('[Jobs API] Background ZB sync error:', err.message);
                }
            });
        } else {
            // No ZB — still emit SSE for immediate UI update
            realtimeService.publishJobUpdate(updated);
        }
    } catch (err) {
        console.error('[Jobs API] Reschedule error:', err.message);
        res.status(err.statusCode || 500).json({ ok: false, error: err.message });
    }
});

module.exports = router;
