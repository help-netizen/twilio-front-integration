/**
 * Local Jobs Routes
 *
 * /api/jobs — CRUD + FSM actions for local Albusto jobs table
 */

const express = require('express');
const multer = require('multer');
const { randomUUID } = require('node:crypto');
const router = express.Router();
const jobsService = require('../services/jobsService');
const zenbookerClient = require('../services/zenbookerClient');
const noteAttachmentsService = require('../services/noteAttachmentsService');
const notesMutationService = require('../services/notesMutationService');
const eventService = require('../services/eventService');
const conversationsService = require('../services/conversationsService');
const routeDistanceService = require('../services/routeDistanceService');
const googlePlacesService = require('../services/googlePlacesService');
const emailService = require('../services/emailService');
const rateMeService = require('../services/rateMeService');
const companyQueries = require('../db/companyQueries');
const rateMeQueries = require('../db/rateMeQueries');
const { toE164 } = require('../utils/phoneUtils');
const { resolveCompanyProxyE164 } = require('../services/messagingHelper');
const { requirePermission } = require('../middleware/authorization');
const { getProviderScope } = require('../middleware/providerScope');

const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: noteAttachmentsService.MAX_FILE_SIZE },
});

const CANCEL_REASON_MAX_LENGTH = 1000;

// ─── Note-mutation helpers (shared by PATCH/DELETE note routes) ───────────────

// Server-side admin check (NOTES-001). Never trust client input.
function isAdminActor(req) {
    return req.user?._devMode
        || req.authz?.membership?.role_key === 'tenant_admin'
        || (req.user?.roles || []).includes('company_admin');
}

function buildNoteActor(req) {
    return {
        sub: req.user?.sub || null,
        // Real crm_users.id (matches the POST-note path's `crmUser.id || sub`), used
        // both for note_attachments.uploaded_by AND to authorise the note author when
        // created_by was stamped with the crm_users.id (NOTE-AUTHOR-FIX-001).
        crmUserId: req.user?.crmUser?.id || req.user?.sub || null,
        name: req.user?.name || null,
        isAdmin: isAdminActor(req),
    };
}

// Tolerant parse of remove_attachment_ids: JSON array, scalar, or missing.
function parseRemoveAttachmentIds(raw) {
    if (raw == null || raw === '') return [];
    if (Array.isArray(raw)) return raw;
    if (typeof raw === 'string') {
        try {
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed)) return parsed;
            if (parsed == null) return [];
            return [parsed];
        } catch {
            return [raw];
        }
    }
    return [raw];
}

function normalizeCancelReason(input) {
    const reason = typeof input === 'string' ? input.trim() : '';
    if (!reason) return { error: 'cancel reason is required' };
    if (reason.length > CANCEL_REASON_MAX_LENGTH) {
        return { error: `cancel reason must be ${CANCEL_REASON_MAX_LENGTH} characters or less` };
    }
    return { reason };
}

// ─── Sync Jobs from Zenbooker ────────────────────────────────────────────────

router.post('/sync', requirePermission('jobs.edit'), async (req, res) => {
    try {
        const companyId = req.companyFilter?.company_id || null;
        // Use per-tenant Zenbooker API key (falls back to global env var)
        const zbClient = await zenbookerClient.getClientForCompany(companyId);
        if (!zbClient) {
            // Company hasn't connected its own Zenbooker (and isn't the default
            // account owner) — nothing to sync, and we must not read another
            // tenant's Zenbooker. Return a clean no-op instead of leaking/crashing.
            return res.json({ ok: true, synced: 0, created: 0, message: 'Zenbooker is not connected for this company' });
        }
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

// ─── Create Job (directly, no lead) ──────────────────────────────────────────

router.post('/', requirePermission('jobs.create'), async (req, res) => {
    try {
        const companyId = req.companyFilter?.company_id;
        if (!companyId) return res.status(403).json({ ok: false, error: 'Tenant context required' });
        const result = await jobsService.createDirectJob(companyId, req.body || {});
        res.json({ ok: true, data: result });
    } catch (err) {
        console.error('[Jobs API] Create error:', err.message);
        res.status(err.httpStatus || 500).json({ ok: false, error: err.message });
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
        // SCHED-ROUTE-001 FR-002: also refresh geocoding_status + recalc routes.
        await jobsService.updateJobLocation(companyId, req.params.id, { lat, lng });
        res.json({ ok: true });
    } catch (err) {
        console.error('[Jobs API] Coords update error:', err.message);
        res.status(500).json({ ok: false, error: err.message });
    }
});

// PATCH /:id/location — SCHED-ROUTE-001 FR-002: edit service address (+ optional
// coords from AddressAutocomplete). Triggers geocode + route recalc + ZB sync.
router.patch('/:id/location', requirePermission('jobs.edit'), async (req, res) => {
    try {
        const companyId = req.companyFilter?.company_id || null;
        const existing = await jobsService.getJobById(req.params.id, companyId, getProviderScope(req));
        if (!existing) return res.status(404).json({ ok: false, error: 'Job not found' });
        const { address, lat, lng, normalized_address, place_id } = req.body;
        if (!address && lat == null) {
            return res.status(400).json({ ok: false, error: 'address or coordinates required' });
        }
        const job = await jobsService.updateJobLocation(companyId, req.params.id, {
            address, lat, lng, normalized_address, place_id,
        });
        res.json({ ok: true, data: job });
    } catch (err) {
        console.error('[Jobs API] Location update error:', err.message);
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

// ─── Update Albusto Status (manual FSM transition) ────────────────────────────

router.patch('/:id/status', requirePermission('jobs.edit', 'jobs.done_pending_approval'), async (req, res) => {
    try {
        const companyId = req.companyFilter?.company_id || null;
        const existing = await jobsService.getJobById(req.params.id, companyId, getProviderScope(req));
        if (!existing) return res.status(404).json({ ok: false, error: 'Job not found' });
        const { blanc_status } = req.body;
        if (!blanc_status) return res.status(400).json({ ok: false, error: 'blanc_status required' });
        let cancelReason = null;
        if (blanc_status === 'Canceled') {
            const parsedReason = normalizeCancelReason(req.body.cancel_reason || req.body.reason);
            if (parsedReason.error) return res.status(400).json({ ok: false, error: parsedReason.error });
            cancelReason = parsedReason.reason;
        }
        // Closing transitions need a closing permission (PF007-HARDENING-001).
        // Cancel is a dispatch decision → jobs.close only. Marking "Done" may be done
        // by a field provider (pending approval) → jobs.close OR jobs.done_pending_approval.
        if (!req.user?._devMode) {
            const perms = req.authz?.permissions || [];
            if (blanc_status === 'Canceled' && !perms.includes('jobs.close')) {
                return res.status(403).json({ ok: false, error: 'Insufficient permissions to cancel jobs' });
            }
            if (blanc_status === 'Job is Done'
                && !perms.includes('jobs.close') && !perms.includes('jobs.done_pending_approval')) {
                return res.status(403).json({ ok: false, error: 'Insufficient permissions to complete jobs' });
            }
        }
        const result = await jobsService.updateBlancStatus(parseInt(req.params.id, 10), blanc_status, companyId);
        eventService.logEvent(companyId, 'job', req.params.id, 'status_changed',
            { from: existing.blanc_status, to: blanc_status, actor_name: eventService.actorName(req), reason: cancelReason }, 'user', req.user?.sub);
        // ADR-001: publish to the event bus so automation rules can react
        require('../services/eventBus').emit(companyId, 'job.status_changed', {
            id: req.params.id, from: existing.blanc_status, to: blanc_status,
            contact_id: existing.contact_id, customer_name: existing.customer_name,
            customer_phone: existing.customer_phone, service_name: existing.service_name,
            reason: cancelReason,
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

function normalizeJobNote(n, index, localAttachments = [], actor = null) {
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
        created_by: n.created_by || null,
        author,
        source: zbMatch ? 'zenbooker' : (n.source || null),
        zb_note_id: n.zb_note_id || null,
        // Server-authoritative edit/delete permission for THIS actor (NOTE-AUTHOR-FIX-001).
        // The client shows the ⋮ menu from this rather than guessing the author id.
        can_edit: actor
            ? notesMutationService.canMutateNote(n, { isAdmin: actor.isAdmin, actorSub: actor.sub, actorCrmUserId: actor.crmUserId })
            : undefined,
    };
}

// Build the GET-shaped, soft-delete-excluded notes list for a job.
async function enrichJobNotes(companyId, jobId, notes, fallbackCreated, actor = null) {
    // Join by note_id; fall back to note_index for legacy rows whose note_id is null.
    const attachments = await noteAttachmentsService.getAttachmentsForEntity(companyId, 'job', jobId);
    const byNoteId = {};
    const byNoteIndex = {};
    for (const a of attachments) {
        if (a.noteId) (byNoteId[a.noteId] ||= []).push(a);
        else (byNoteIndex[a.noteIndex] ||= []).push(a);
    }
    return (notes || [])
        .map((n, i) => ({ n, i }))
        .filter(({ n }) => !n.deleted_at)
        .map(({ n, i }) => {
            const local = (n.id && byNoteId[n.id]) || byNoteIndex[i] || [];
            const normalized = normalizeJobNote(n, i, local, actor);
            if (!normalized.created) normalized.created = fallbackCreated;
            return normalized;
        });
}

router.get('/:id/notes', requirePermission('jobs.view'), async (req, res) => {
    try {
        const companyId = req.companyFilter?.company_id || null;
        const jobId = parseInt(req.params.id, 10);
        const job = await jobsService.getJobById(jobId, companyId, getProviderScope(req));
        if (!job) return res.status(404).json({ ok: false, error: 'Job not found' });

        // Fallback date for notes with no id-derived timestamp: use job.updated_at
        // (closest signal we have to when Zenbooker delivered the note).
        const fallbackCreated = job.updated_at || new Date().toISOString();
        const enriched = await enrichJobNotes(companyId, jobId, job.notes || [], fallbackCreated, buildNoteActor(req));

        res.json({ ok: true, data: enriched });
    } catch (err) {
        console.error('[Jobs API] Get notes error:', err.message);
        res.status(500).json({ ok: false, error: err.message });
    }
});

// ─── Add Note ────────────────────────────────────────────────────────────────

router.post('/:id/notes', requirePermission('jobs.edit', 'jobs.done_pending_approval'), upload.array('attachments', noteAttachmentsService.MAX_FILES_PER_NOTE), async (req, res) => {
    try {
        const companyId = req.companyFilter?.company_id || null;
        const userId = req.user?.crmUser?.id || req.user?.sub || null;
        const jobId = parseInt(req.params.id, 10);
        const existing = await jobsService.getJobById(jobId, companyId, getProviderScope(req));
        if (!existing) return res.status(404).json({ ok: false, error: 'Job not found' });

        const text = (req.body.text || '').trim();
        const files = req.files || [];
        const attachmentIds = parseRemoveAttachmentIds(req.body.attachment_ids); // tolerant id-array parse
        if (!text && files.length === 0 && attachmentIds.length === 0) return res.status(400).json({ ok: false, error: 'text or attachments required' });

        // Save note with attachment metadata
        const noteId = randomUUID();
        const noteIndex = (existing.notes || []).length;
        let attachments = [];
        if (attachmentIds.length > 0) {
            // NOTE-ATTACH-UPLOAD-001: files were pre-uploaded (staged) — just link them to the note.
            attachments = await noteAttachmentsService.associateStagedAttachments(
                companyId, 'job', jobId, attachmentIds, noteId, noteIndex
            );
        } else if (files.length > 0) {
            attachments = await noteAttachmentsService.createAttachments(
                companyId, 'job', jobId, noteIndex, files, userId, { noteId }
            );
        }

        const author = req.user?.name?.split(' ')[0] || req.user?.email || null;
        const result = await jobsService.addNote(jobId, text, attachments, author, userId, noteId);
        res.json({ ok: true, data: result });
    } catch (err) {
        console.error('[Jobs API] Add note error:', err.message);
        const status = err.status || 500;
        res.status(status).json({ ok: false, error: err.message });
    }
});

// ─── Edit / Delete Note (NOTES-001) ──────────────────────────────────────────

function buildJobNoteAdapter(companyId, jobId, scope) {
    const db = require('../db/connection');
    return {
        entityType: 'job',
        attachmentEntityId: jobId,
        async loadNotes() {
            const job = await jobsService.getJobById(jobId, companyId, scope);
            return job ? (job.notes || []) : null;
        },
        async saveNotes(notes) {
            await db.query(
                'UPDATE jobs SET notes = $1::jsonb, updated_at = NOW() WHERE id = $2 AND company_id = $3',
                [JSON.stringify(notes), jobId, companyId]
            );
        },
    };
}

router.patch('/:id/notes/:noteId', requirePermission('jobs.edit', 'jobs.done_pending_approval'), upload.array('attachments', noteAttachmentsService.MAX_FILES_PER_NOTE), async (req, res) => {
    try {
        const companyId = req.companyFilter?.company_id || null;
        const jobId = parseInt(req.params.id, 10);
        const scope = getProviderScope(req);
        const existing = await jobsService.getJobById(jobId, companyId, scope);
        if (!existing) return res.status(404).json({ ok: false, error: 'Job not found' });

        const adapter = buildJobNoteAdapter(companyId, jobId, scope);
        const { note, oldText, addedNames, removedNames } = await notesMutationService.editNote(
            adapter,
            req.params.noteId,
            {
                text: req.body.text,
                removeAttachmentIds: parseRemoveAttachmentIds(req.body.remove_attachment_ids),
                attachmentIds: parseRemoveAttachmentIds(req.body.attachment_ids),
                files: req.files || [],
                actor: buildNoteActor(req),
                companyId,
            }
        );

        eventService.logEvent(companyId, 'job', jobId, 'note_edited', {
            note_id: note.id, old_text: oldText, new_text: note.text,
            added: addedNames, removed: removedNames, actor_name: eventService.actorName(req),
        }, 'user', req.user?.sub);

        const fallbackCreated = existing.updated_at || new Date().toISOString();
        const enriched = await enrichJobNotes(companyId, jobId, await adapter.loadNotes(), fallbackCreated, buildNoteActor(req));
        res.json({ ok: true, data: { notes: enriched } });
    } catch (err) {
        const status = err.status || 500;
        if (status >= 500) console.error('[Jobs API] Edit note error:', err.message);
        res.status(status).json({ ok: false, error: err.message });
    }
});

router.delete('/:id/notes/:noteId', requirePermission('jobs.edit', 'jobs.done_pending_approval'), async (req, res) => {
    try {
        const companyId = req.companyFilter?.company_id || null;
        const jobId = parseInt(req.params.id, 10);
        const scope = getProviderScope(req);
        const existing = await jobsService.getJobById(jobId, companyId, scope);
        if (!existing) return res.status(404).json({ ok: false, error: 'Job not found' });

        const adapter = buildJobNoteAdapter(companyId, jobId, scope);
        const { note } = await notesMutationService.softDeleteNote(adapter, req.params.noteId, {
            actor: buildNoteActor(req),
            companyId,
        });

        eventService.logEvent(companyId, 'job', jobId, 'note_deleted', {
            note_id: note.id, deleted_text: note.text || '', actor_name: eventService.actorName(req),
        }, 'user', req.user?.sub);

        const fallbackCreated = existing.updated_at || new Date().toISOString();
        const enriched = await enrichJobNotes(companyId, jobId, await adapter.loadNotes(), fallbackCreated, buildNoteActor(req));
        res.json({ ok: true, data: { notes: enriched } });
    } catch (err) {
        const status = err.status || 500;
        if (status >= 500) console.error('[Jobs API] Delete note error:', err.message);
        res.status(status).json({ ok: false, error: err.message });
    }
});

// ─── Cancel Job ──────────────────────────────────────────────────────────────

router.post('/:id/cancel', requirePermission('jobs.close'), async (req, res) => {
    try {
        const companyId = req.companyFilter?.company_id || null;
        const existing = await jobsService.getJobById(req.params.id, companyId, getProviderScope(req));
        if (!existing) return res.status(404).json({ ok: false, error: 'Job not found' });
        const parsedReason = normalizeCancelReason(req.body?.reason || req.body?.cancel_reason);
        if (parsedReason.error) return res.status(400).json({ ok: false, error: parsedReason.error });
        const result = await jobsService.cancelJob(parseInt(req.params.id, 10));
        eventService.logEvent(companyId, 'job', req.params.id, 'canceled',
            { actor_name: eventService.actorName(req), reason: parsedReason.reason }, 'user', req.user?.sub);
        res.json({ ok: true, data: result });
    } catch (err) {
        console.error('[Jobs API] Cancel error:', err.message);
        res.status(err.statusCode || 500).json({ ok: false, error: err.message });
    }
});

// ─── Mark En-route ───────────────────────────────────────────────────────────

router.post('/:id/enroute', requirePermission('jobs.edit', 'jobs.done_pending_approval'), async (req, res) => {
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

router.post('/:id/start', requirePermission('jobs.edit', 'jobs.done_pending_approval'), async (req, res) => {
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

        // SCHED-ROUTE-VIS-001 (FR-1, S-8): capture the tech-day pairs this job
        // occupies BEFORE the reschedule (and before the ZB-assign block below
        // rewrites assigned_provider_user_ids) so the vacated day repairs too.
        let beforeTechDays = [];
        if (companyId) {
            try {
                const routeQueries = require('../db/routeQueries');
                const tz = await routeQueries.getCompanyTimezone(companyId);
                beforeTechDays = await routeQueries.getTechDaysForJob(companyId, jobId, tz);
            } catch { /* non-fatal */ }
        }

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

        // SCHED-ROUTE-VIS-001 (FR-1, S-8): best-effort route recalc after the
        // local UPDATE — fire-and-forget, the HTTP response never waits.
        if (companyId) {
            require('../services/routeSegmentService')
                .recalcForJob(companyId, jobId, { beforeTechDays })
                .catch(e => console.error('[Jobs API] reschedule recalc failed (non-fatal):', e.message));
        }

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
// ONWAY-001 — "On the way" ETA estimate + notify (technician dispatch SMS)
// =============================================================================

// resolveCompanyProxyE164 (outbound sending DID resolution) moved to
// ../services/messagingHelper so SMS dispatch services can reuse it.

// POST /:id/eta/estimate — pure read: device coords → job address travel time.
// Never sends anything, never changes status.
router.post('/:id/eta/estimate', requirePermission('messages.send'), async (req, res) => {
    try {
        const companyId = req.companyFilter?.company_id || null;
        const body = req.body;
        if (!body || typeof body !== 'object' || Array.isArray(body)) {
            return res.status(400).json({ ok: false, error: 'invalid body' });
        }
        const job = await jobsService.getJobById(req.params.id, companyId, getProviderScope(req));
        if (!job) return res.status(404).json({ ok: false, error: 'Job not found' });

        const origin = body.origin || {};
        const oLat = Number(origin.lat);
        const oLng = Number(origin.lng);
        // No usable origin → don't call Google (geolocation-not-sent path).
        if (!Number.isFinite(oLat) || !Number.isFinite(oLng)) {
            return res.json({ ok: true, data: { eta_minutes: null } });
        }

        // Destination: prefer stored coords; else geocode the service address.
        let destLat = job.lat != null ? Number(job.lat) : null;
        let destLng = job.lng != null ? Number(job.lng) : null;
        if ((destLat == null || destLng == null || !Number.isFinite(destLat) || !Number.isFinite(destLng))
            && job.address && String(job.address).trim()) {
            const geo = await googlePlacesService.geocodeAddress(job.address);
            if (geo.status !== 'failed' && geo.lat != null && geo.lng != null) {
                destLat = Number(geo.lat);
                destLng = Number(geo.lng);
            }
        }
        // No usable destination → unavailable (not an error).
        if (!Number.isFinite(destLat) || !Number.isFinite(destLng)) {
            return res.json({ ok: true, data: { eta_minutes: null } });
        }

        const pair = await routeDistanceService.computePair(
            { lat: oLat, lng: oLng }, { lat: destLat, lng: destLng }, 'driving'
        );
        const etaMinutes = (pair.status === 'success' && pair.durationMinutes != null)
            ? Math.round(pair.durationMinutes)
            : null;
        return res.json({ ok: true, data: { eta_minutes: etaMinutes } });
    } catch (err) {
        console.error('[Jobs API] ETA estimate error:', err.message);
        res.status(500).json({ ok: false, error: err.message });
    }
});

// POST /:id/eta/notify — SMS first (primary), then status (best-effort).
router.post('/:id/eta/notify', requirePermission('messages.send'), async (req, res) => {
    try {
        const companyId = req.companyFilter?.company_id || null;
        const jobId = parseInt(req.params.id, 10);

        // Validate eta_minutes: integer 1–600 (defense-in-depth; UI validates too).
        const eta = req.body?.eta_minutes;
        if (typeof eta !== 'number' || !Number.isInteger(eta) || eta < 1 || eta > 600) {
            return res.status(400).json({ ok: false, error: 'invalid_eta' });
        }

        const job = await jobsService.getJobById(jobId, companyId, getProviderScope(req));
        if (!job) return res.status(404).json({ ok: false, error: 'Job not found' });

        // Customer phone (denormalized on the job row). Absent → 422, no side effects.
        const rawPhone = (job.customer_phone || '').trim();
        if (!rawPhone) {
            return res.status(422).json({ ok: false, code: 'NO_PHONE', message: 'No phone number on file for this customer.' });
        }
        const customerE164 = toE164(rawPhone);
        if (!customerE164) {
            return res.status(422).json({ ok: false, code: 'NO_PHONE', message: 'No phone number on file for this customer.' });
        }

        // Sending proxy DID. None → 422, no side effects.
        const proxyE164 = await resolveCompanyProxyE164(companyId);
        if (!proxyE164) {
            return res.status(422).json({ ok: false, code: 'NO_PROXY', message: 'No sending number configured for your company.' });
        }

        // Resolve tech + company name for the SMS template.
        const techName = (job.assigned_techs?.[0]?.name || '').trim();
        let companyName = null;
        try {
            const company = companyId ? await companyQueries.getCompanyById(companyId) : null;
            companyName = (company?.name || '').trim() || null;
        } catch (e) {
            console.warn('[Jobs API] ETA notify: company name lookup failed:', e.message);
        }
        const companyLabel = companyName || 'your service team';

        // OW-R5 template. When the tech name is missing, the word "technician"
        // stays and the name is simply omitted (grammatical single template).
        const leadIn = techName ? `Your technician ${techName} ` : 'Your technician ';
        const body = `Hi! ${leadIn}from ${companyLabel} is on the way and should arrive in about ${eta} minutes.`;

        // Send: wallet gate is INSIDE sendMessage. Any throw → status NOT changed.
        let conversationId;
        try {
            const conv = await conversationsService.getOrCreateConversation(customerE164, proxyE164, companyId);
            conversationId = conv.id;
            await conversationsService.sendMessage(conv.id, { body, author: 'agent' });
        } catch (sendErr) {
            if (sendErr.code === 'WALLET_BLOCKED') {
                return res.status(sendErr.httpStatus || 402).json({
                    ok: false, code: 'WALLET_BLOCKED', message: 'Messaging is paused — top up your balance.',
                });
            }
            console.error('[Jobs API] ETA notify send error:', sendErr.message);
            return res.status(502).json({ ok: false, code: 'SMS_FAILED', message: "Couldn't send the message. Please try again." });
        }

        // SMS sent (primary success). Advance status best-effort — no SMS rollback.
        try {
            await jobsService.updateBlancStatus(jobId, 'On the way', companyId);
        } catch (statusErr) {
            console.warn('[Jobs API] ETA notify: status not advanced:', statusErr.message);
            return res.json({ ok: true, data: { sent: true }, warning: 'status_not_advanced' });
        }

        return res.json({ ok: true, data: { sent: true, status: 'On the way' } });
    } catch (err) {
        console.error('[Jobs API] ETA notify error:', err.message);
        res.status(500).json({ ok: false, error: err.message });
    }
});

// POST /:id/rate-link — mint a fresh rating link, deliver it, then stamp success.
router.post('/:id/rate-link', requirePermission('messages.send'), async (req, res) => {
    try {
        const channel = req.body?.channel;
        if (!['sms', 'email', 'copy'].includes(channel)) {
            return res.status(400).json({
                ok: false,
                code: 'INVALID_CHANNEL',
                message: 'Channel must be one of: sms, email, copy.',
            });
        }

        const companyId = req.companyFilter?.company_id;
        const jobId = parseInt(req.params.id, 10);
        const job = await jobsService.getJobById(jobId, companyId, getProviderScope(req));
        if (!job) {
            return res.status(404).json({ ok: false, code: 'JOB_NOT_FOUND', message: 'Job not found' });
        }

        const technician = job.assigned_techs?.[0];
        const techId = technician?.id == null ? undefined : String(technician.id);
        const techName = typeof technician?.name === 'string' ? technician.name : null;
        const { token, url } = await rateMeService.mintToken(companyId, {
            jobId,
            techId,
            techName,
        });

        if (channel === 'sms') {
            const customerE164 = toE164((job.customer_phone || '').trim());
            if (!customerE164) {
                return res.status(422).json({
                    ok: false,
                    code: 'NO_PHONE',
                    message: 'No phone number on file for this customer.',
                });
            }

            const proxyE164 = await resolveCompanyProxyE164(companyId);
            if (!proxyE164) {
                return res.status(422).json({
                    ok: false,
                    code: 'NO_PROXY',
                    message: 'No sending number configured for your company.',
                });
            }

            try {
                const conv = await conversationsService.getOrCreateConversation(
                    customerE164,
                    proxyE164,
                    companyId
                );
                await conversationsService.sendMessage(conv.id, {
                    body: `How did we do? Please rate your recent service: ${url}`,
                    author: 'agent',
                });
            } catch (sendErr) {
                if (sendErr.code === 'WALLET_BLOCKED') {
                    return res.status(sendErr.httpStatus || 402).json({
                        ok: false,
                        code: 'WALLET_BLOCKED',
                        message: 'Messaging is paused — top up your balance.',
                    });
                }
                console.error('[Jobs API] Rate link SMS error:', sendErr.message);
                return res.status(502).json({
                    ok: false,
                    code: 'SMS_FAILED',
                    message: "Couldn't send the message. Please try again.",
                });
            }
        } else if (channel === 'email') {
            const customerEmail = (job.customer_email || '').trim();
            if (!customerEmail) {
                return res.status(422).json({
                    ok: false,
                    code: 'NO_EMAIL',
                    message: 'No email on file for this customer.',
                });
            }

            try {
                await emailService.sendEmail(companyId, {
                    to: customerEmail,
                    subject: 'How was your service?',
                    body: `We'd love your feedback on your recent service. <a href="${url}">Rate your visit</a>.`,
                    userId: req.user.crmUser.id,
                });
            } catch (sendErr) {
                console.error('[Jobs API] Rate link email error:', sendErr.message);
                return res.status(409).json({
                    ok: false,
                    code: 'MAIL_DISCONNECTED',
                    message: 'Connect a mailbox to send email.',
                });
            }
        }

        const stamped = await rateMeQueries.stampTokenSent(token, companyId, channel);
        const data = { channel, sent_at: stamped.sent_at };
        if (channel === 'copy') data.url = url;
        return res.json({ ok: true, data });
    } catch (err) {
        if (err instanceof rateMeService.RateMeServiceError) {
            return res.status(err.httpStatus || 400).json({
                ok: false,
                code: err.code,
                message: err.message,
            });
        }
        console.error('[Jobs API] Rate link error:', err.message);
        return res.status(500).json({
            ok: false,
            code: 'INTERNAL_ERROR',
            message: 'Unable to send rating link.',
        });
    }
});

// GET /:id/rate-status — attribution aggregate for this company and job.
router.get('/:id/rate-status', requirePermission('jobs.view'), async (req, res) => {
    try {
        const companyId = req.companyFilter?.company_id;
        const jobId = parseInt(req.params.id, 10);
        const data = await rateMeQueries.getJobRateStatus(companyId, jobId);
        return res.json({ ok: true, data });
    } catch (err) {
        console.error('[Jobs API] Rate status error:', err.message);
        return res.status(500).json({
            ok: false,
            code: 'INTERNAL_ERROR',
            message: 'Unable to load rating status.',
        });
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
        const data = await stripePaymentsService.createManualCardSession(companyId, { id: req.user?.crmUser?.id || null }, { jobId: req.params.id, amount: req.body?.amount });
        res.json({ ok: true, data });
    } catch (err) { jobStripeError(err, res); }
});

router.post('/:id/tap-to-pay/payment-intent', requirePermission('payments.collect_terminal'), async (req, res) => {
    try {
        const companyId = req.companyFilter?.company_id;
        const data = await stripePaymentsService.createTapToPayIntent(companyId, { id: req.user?.crmUser?.id || null }, { jobId: req.params.id, amount: req.body?.amount });
        res.json({ ok: true, data });
    } catch (err) { jobStripeError(err, res); }
});

// STRIPE-ADHOC-PAY-001 — invoice-independent job payment links (create/get/send)
router.post('/:id/stripe-payment-link', requirePermission('payments.collect_online'), async (req, res) => {
    try {
        const companyId = req.companyFilter?.company_id;
        const data = await stripePaymentsService.ensureJobPaymentLink(companyId, { id: req.user?.crmUser?.id || null }, req.params.id, { amount: req.body?.amount });
        res.json({ ok: true, data });
    } catch (err) { jobStripeError(err, res); }
});

router.get('/:id/stripe-payment-link', requirePermission('payments.view'), async (req, res) => {
    try {
        const companyId = req.companyFilter?.company_id;
        const data = await stripePaymentsService.getJobPaymentLink(companyId, req.params.id);
        res.json({ ok: true, data });
    } catch (err) { jobStripeError(err, res); }
});

router.post('/:id/send-payment-link', requirePermission('payments.collect_online'), async (req, res) => {
    try {
        const companyId = req.companyFilter?.company_id;
        const data = await stripePaymentsService.sendJobPaymentLink(companyId, { id: req.user?.crmUser?.id || null }, req.params.id, { channel: req.body?.channel, amount: req.body?.amount, message: req.body?.message });
        res.json({ ok: true, data });
    } catch (err) { jobStripeError(err, res); }
});

module.exports = router;
