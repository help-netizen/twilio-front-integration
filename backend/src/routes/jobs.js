/**
 * Local Jobs Routes
 *
 * /api/jobs — CRUD + FSM actions for local Blanc jobs table
 */

const express = require('express');
const multer = require('multer');
const router = express.Router();
const jobsService = require('../services/jobsService');
const zenbookerClient = require('../services/zenbookerClient');
const noteAttachmentsService = require('../services/noteAttachmentsService');
const eventService = require('../services/eventService');
const { requirePermission } = require('../middleware/authorization');
const { getProviderScope } = require('../middleware/providerScope');

const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: noteAttachmentsService.MAX_FILE_SIZE },
});

// ─── Sync Jobs from Zenbooker ────────────────────────────────────────────────

router.post('/sync', requirePermission('jobs.edit'), async (req, res) => {
    try {
        const companyId = req.companyFilter?.company_id || null;
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

router.get('/', requirePermission('jobs.view'), async (req, res) => {
    try {
        const { blanc_status, canceled, search, offset, limit, contact_id, sort_by, sort_order, only_open, start_date, end_date, service_name, provider, tag_ids, tag_match } = req.query;
        const result = await jobsService.listJobs({
            blancStatus: blanc_status || undefined,
            zbCanceled: canceled,
            search: search || undefined,
            offset: parseInt(offset, 10) || 0,
            limit: parseInt(limit, 10) || 50,
            companyId: req.companyFilter?.company_id || undefined,
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
            providerScope: getProviderScope(req),
        });
        res.json({ ok: true, data: result });
    } catch (err) {
        console.error('[Jobs API] List error:', err.message);
        res.status(500).json({ ok: false, error: err.message });
    }
});

// ─── Get Job by ID ───────────────────────────────────────────────────────────

router.get('/:id', requirePermission('jobs.view'), async (req, res) => {
    try {
        const companyId = req.companyFilter?.company_id || null;
        const job = await jobsService.getJobById(req.params.id, companyId, getProviderScope(req));
        if (!job) return res.status(404).json({ ok: false, error: 'Job not found' });
        res.json({ ok: true, data: job });
    } catch (err) {
        console.error('[Jobs API] Get error:', err.message);
        res.status(500).json({ ok: false, error: err.message });
    }
});

// ─── Update Job Coordinates ──────────────────────────────────────────────────

router.patch('/:id/coords', requirePermission('jobs.edit'), async (req, res) => {
    try {
        const companyId = req.companyFilter?.company_id || null;
        const existing = await jobsService.getJobById(req.params.id, companyId, getProviderScope(req));
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

router.patch('/:id/tags', requirePermission('jobs.edit'), async (req, res) => {
    try {
        const companyId = req.companyFilter?.company_id || null;
        const existing = await jobsService.getJobById(req.params.id, companyId, getProviderScope(req));
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

router.patch('/:id/status', requirePermission('jobs.edit'), async (req, res) => {
    try {
        const companyId = req.companyFilter?.company_id || null;
        const existing = await jobsService.getJobById(req.params.id, companyId, getProviderScope(req));
        if (!existing) return res.status(404).json({ ok: false, error: 'Job not found' });
        const { blanc_status } = req.body;
        if (!blanc_status) return res.status(400).json({ ok: false, error: 'blanc_status required' });
        // Closing transitions require a closing permission (PF007-HARDENING-001)
        if (['Job is Done', 'Canceled'].includes(blanc_status) && !req.user?._devMode) {
            const perms = req.authz?.permissions || [];
            if (!perms.includes('jobs.close') && !perms.includes('jobs.done_pending_approval')) {
                return res.status(403).json({ ok: false, error: 'Insufficient permissions to close jobs' });
            }
        }
        const result = await jobsService.updateBlancStatus(parseInt(req.params.id, 10), blanc_status, companyId);
        eventService.logEvent(companyId, 'job', req.params.id, 'status_changed',
            { from: existing.blanc_status, to: blanc_status, actor_name: eventService.actorName(req) }, 'user', req.user?.sub);
        // ADR-001: publish to the event bus so automation rules can react
        require('../services/eventBus').emit(companyId, 'job.status_changed', {
            id: req.params.id, from: existing.blanc_status, to: blanc_status,
            contact_id: existing.contact_id, customer_name: existing.customer_name,
            customer_phone: existing.customer_phone, service_name: existing.service_name,
        }, { actorType: 'user', actorId: req.user?.sub, aggregateType: 'job', aggregateId: req.params.id })
            .catch(e => console.error('[eventBus] job.status_changed emit failed:', e.message));
        res.json({ ok: true, data: result });
    } catch (err) {
        console.error('[Jobs API] Status update error:', err.message);
        const status = err.message.includes('not allowed') || err.message.includes('Invalid') ? 400 : 500;
        res.status(status).json({ ok: false, error: err.message });
    }
});

// ─── Get History ─────────────────────────────────────────────────────────────

router.get('/:id/history', requirePermission('jobs.view'), async (req, res) => {
    try {
        const companyId = req.companyFilter?.company_id || null;
        const jobId = parseInt(req.params.id, 10);
        const job = await jobsService.getJobById(jobId, companyId, getProviderScope(req));
        if (!job) return res.status(404).json({ ok: false, error: 'Job not found' });

        const history = await eventService.getEntityHistory(companyId, 'job', jobId, job.notes || []);
        res.json({ ok: true, data: history });
    } catch (err) {
        console.error('[Jobs API] History error:', err.message);
        res.status(500).json({ ok: false, error: err.message });
    }
});

// ─── Get Notes ───────────────────────────────────────────────────────────────

// Zenbooker ids look like "<unix-ms>x<hash>" — the prefix is the creation timestamp in ms.
const ZB_ID_RE = /^(\d{13,})x[\w-]+$/;

function guessContentTypeFromUrl(url) {
    const clean = String(url).split('?')[0].split('#')[0];
    const ext = clean.includes('.') ? clean.slice(clean.lastIndexOf('.') + 1).toLowerCase() : '';
    const map = {
        jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif',
        webp: 'image/webp', heic: 'image/heic', bmp: 'image/bmp', svg: 'image/svg+xml',
        pdf: 'application/pdf', mp4: 'video/mp4', mov: 'video/quicktime',
        doc: 'application/msword',
        docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    };
    return map[ext] || null;
}

function zbUrlToAttachment(id, url, isImage) {
    let fileName = '';
    try { fileName = decodeURIComponent(String(url).split('?')[0].split('/').pop() || ''); } catch { fileName = ''; }
    if (!fileName) fileName = isImage ? 'image' : 'file';
    const contentType = guessContentTypeFromUrl(url) || (isImage ? 'image/jpeg' : 'application/octet-stream');
    return { id, fileName, contentType, fileSize: 0, url, source: 'zenbooker' };
}

function normalizeJobNote(n, index, localAttachments = []) {
    const zbMatch = typeof n.id === 'string' ? n.id.match(ZB_ID_RE) : null;

    // created: prefer existing; else derive from Zenbooker id; else null (frontend handles absent date)
    let created = n.created || null;
    if (!created && zbMatch) {
        const ms = Number(zbMatch[1]);
        if (Number.isFinite(ms) && ms > 1e12) created = new Date(ms).toISOString();
    }

    // attachments: prefer already-normalized; else map ZB images/files to our shape; else local uploads
    let attachments = [];
    if (Array.isArray(n.attachments) && n.attachments.length > 0) {
        attachments = n.attachments;
    } else if ((Array.isArray(n.images) && n.images.length) || (Array.isArray(n.files) && n.files.length)) {
        const noteKey = n.id || `note-${index}`;
        (n.images || []).forEach((url, i) => attachments.push(zbUrlToAttachment(`${noteKey}-img-${i}`, url, true)));
        (n.files || []).forEach((url, i) => attachments.push(zbUrlToAttachment(`${noteKey}-file-${i}`, url, false)));
    } else if (localAttachments.length) {
        attachments = localAttachments;
    }

    // author: preserve explicit; else label ZB-sourced notes as "Zenbooker"
    let author = n.author || null;
    if (!author && zbMatch) author = 'Zenbooker';

    return {
        id: n.id || null,
        text: n.text || null,
        attachments,
        created,
        author,
        source: zbMatch ? 'zenbooker' : (n.source || null),
    };
}

router.get('/:id/notes', requirePermission('jobs.view'), async (req, res) => {
    try {
        const companyId = req.companyFilter?.company_id || null;
        const jobId = parseInt(req.params.id, 10);
        const job = await jobsService.getJobById(jobId, companyId, getProviderScope(req));
        if (!job) return res.status(404).json({ ok: false, error: 'Job not found' });

        const notes = job.notes || [];
        // Enrich with attachment presigned URLs (for locally-uploaded files)
        const attachments = await noteAttachmentsService.getAttachmentsForEntity(companyId, 'job', jobId);
        const attachmentsByNote = {};
        for (const a of attachments) {
            if (!attachmentsByNote[a.noteIndex]) attachmentsByNote[a.noteIndex] = [];
            attachmentsByNote[a.noteIndex].push(a);
        }

        // Fallback date for notes with no id-derived timestamp: use job.updated_at
        // (closest signal we have to when Zenbooker delivered the note).
        const fallbackCreated = job.updated_at || new Date().toISOString();
        const enriched = notes.map((n, i) => {
            const normalized = normalizeJobNote(n, i, attachmentsByNote[i] || []);
            if (!normalized.created) normalized.created = fallbackCreated;
            return normalized;
        });

        res.json({ ok: true, data: enriched });
    } catch (err) {
        console.error('[Jobs API] Get notes error:', err.message);
        res.status(500).json({ ok: false, error: err.message });
    }
});

// ─── Add Note ────────────────────────────────────────────────────────────────

router.post('/:id/notes', requirePermission('jobs.edit'), upload.array('attachments', noteAttachmentsService.MAX_FILES_PER_NOTE), async (req, res) => {
    try {
        const companyId = req.companyFilter?.company_id || null;
        const userId = req.user?.sub || null;
        const jobId = parseInt(req.params.id, 10);
        const existing = await jobsService.getJobById(jobId, companyId, getProviderScope(req));
        if (!existing) return res.status(404).json({ ok: false, error: 'Job not found' });

        const text = (req.body.text || '').trim();
        const files = req.files || [];
        if (!text && files.length === 0) return res.status(400).json({ ok: false, error: 'text or attachments required' });

        // Save note with attachment metadata
        const noteIndex = (existing.notes || []).length;
        let attachments = [];
        if (files.length > 0) {
            attachments = await noteAttachmentsService.createAttachments(
                companyId, 'job', jobId, noteIndex, files, userId
            );
        }

        const author = req.user?.name?.split(' ')[0] || req.user?.email || null;
        const result = await jobsService.addNote(jobId, text, attachments, author);
        res.json({ ok: true, data: result });
    } catch (err) {
        console.error('[Jobs API] Add note error:', err.message);
        const status = err.status || 500;
        res.status(status).json({ ok: false, error: err.message });
    }
});

// ─── Cancel Job ──────────────────────────────────────────────────────────────

router.post('/:id/cancel', requirePermission('jobs.close'), async (req, res) => {
    try {
        const companyId = req.companyFilter?.company_id || null;
        const existing = await jobsService.getJobById(req.params.id, companyId, getProviderScope(req));
        if (!existing) return res.status(404).json({ ok: false, error: 'Job not found' });
        const result = await jobsService.cancelJob(parseInt(req.params.id, 10));
        eventService.logEvent(companyId, 'job', req.params.id, 'canceled',
            { actor_name: eventService.actorName(req) }, 'user', req.user?.sub);
        res.json({ ok: true, data: result });
    } catch (err) {
        console.error('[Jobs API] Cancel error:', err.message);
        res.status(err.statusCode || 500).json({ ok: false, error: err.message });
    }
});

// ─── Mark En-route ───────────────────────────────────────────────────────────

router.post('/:id/enroute', requirePermission('jobs.edit'), async (req, res) => {
    try {
        const companyId = req.companyFilter?.company_id || null;
        const existing = await jobsService.getJobById(req.params.id, companyId, getProviderScope(req));
        if (!existing) return res.status(404).json({ ok: false, error: 'Job not found' });
        const result = await jobsService.markEnroute(parseInt(req.params.id, 10));
        res.json({ ok: true, data: result });
    } catch (err) {
        console.error('[Jobs API] En-route error:', err.message);
        res.status(err.statusCode || 500).json({ ok: false, error: err.message });
    }
});

// ─── Mark In-Progress ────────────────────────────────────────────────────────

router.post('/:id/start', requirePermission('jobs.edit'), async (req, res) => {
    try {
        const companyId = req.companyFilter?.company_id || null;
        const existing = await jobsService.getJobById(req.params.id, companyId, getProviderScope(req));
        if (!existing) return res.status(404).json({ ok: false, error: 'Job not found' });
        const result = await jobsService.markInProgress(parseInt(req.params.id, 10));
        res.json({ ok: true, data: result });
    } catch (err) {
        console.error('[Jobs API] Start error:', err.message);
        res.status(err.statusCode || 500).json({ ok: false, error: err.message });
    }
});

// ─── Mark Complete ───────────────────────────────────────────────────────────

router.post('/:id/complete', requirePermission('jobs.close', 'jobs.done_pending_approval'), async (req, res) => {
    try {
        const companyId = req.companyFilter?.company_id || null;
        const existing = await jobsService.getJobById(req.params.id, companyId, getProviderScope(req));
        if (!existing) return res.status(404).json({ ok: false, error: 'Job not found' });
        const result = await jobsService.markComplete(parseInt(req.params.id, 10));
        res.json({ ok: true, data: result });
    } catch (err) {
        console.error('[Jobs API] Complete error:', err.message);
        res.status(err.statusCode || 500).json({ ok: false, error: err.message });
    }
});
// ─── Reschedule ──────────────────────────────────────────────────────────────

router.post('/:id/reschedule', requirePermission('jobs.edit'), async (req, res) => {
    const jobId = parseInt(req.params.id, 10);
    const companyId = req.companyFilter?.company_id || null;
    const existing = await jobsService.getJobById(jobId, companyId, getProviderScope(req));
    if (!existing) return res.status(404).json({ ok: false, error: 'Job not found' });
    const { start_date, arrival_window_minutes = 120, tech_id } = req.body;

    // Changing the assigned technician is a dispatch action (PF007)
    if (tech_id && !req.user?._devMode && !(req.authz?.permissions || []).includes('jobs.assign')) {
        return res.status(403).json({ ok: false, error: 'Insufficient permissions to reassign jobs' });
    }

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
                            const mirror = await jobsService.resolveAssignedProviderUserIds(companyId, freshJob.assigned_providers);
                            await db.query(
                                `UPDATE jobs SET assigned_techs = $1::jsonb, assigned_provider_user_ids = $2::jsonb, updated_at = NOW() WHERE id = $3`,
                                [JSON.stringify(freshJob.assigned_providers), mirror, jobId]
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

// =============================================================================
// F018 Stripe Payments — collect from job context (manual card / Tap to Pay)
// =============================================================================
const stripePaymentsService = require('../services/stripePaymentsService');

function jobStripeError(err, res) {
    if (err instanceof stripePaymentsService.StripePaymentsError) {
        return res.status(err.httpStatus || 400).json({ ok: false, error: { code: err.code, message: err.message } });
    }
    console.error('[Jobs API] stripe error:', err.message);
    return res.status(err.httpStatus || 500).json({ ok: false, error: { code: err.code || 'INTERNAL', message: err.message } });
}

router.post('/:id/stripe-manual-card-session', requirePermission('payments.collect_keyed'), async (req, res) => {
    try {
        const companyId = req.companyFilter?.company_id;
        const data = await stripePaymentsService.createManualCardSession(companyId, { id: req.user?.sub }, { jobId: req.params.id, amount: req.body?.amount });
        res.json({ ok: true, data });
    } catch (err) { jobStripeError(err, res); }
});

router.post('/:id/tap-to-pay/payment-intent', requirePermission('payments.collect_terminal'), async (req, res) => {
    try {
        const companyId = req.companyFilter?.company_id;
        const data = await stripePaymentsService.createTapToPayIntent(companyId, { id: req.user?.sub }, { jobId: req.params.id, amount: req.body?.amount });
        res.json({ ok: true, data });
    } catch (err) { jobStripeError(err, res); }
});

module.exports = router;
