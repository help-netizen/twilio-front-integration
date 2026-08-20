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
const noteAttachmentsService = require('../services/noteAttachmentsService');
const unitLabelScanService = require('../services/unitLabelScanService');
const notesMutationService = require('../services/notesMutationService');
const eventService = require('../services/eventService');
const conversationsService = require('../services/conversationsService');
const routeDistanceService = require('../services/routeDistanceService');
const googlePlacesService = require('../services/googlePlacesService');
const emailService = require('../services/emailService');
const rateMeService = require('../services/rateMeService');
const { closePermissionError } = require('../services/jobTransitionPerms');
const companyQueries = require('../db/companyQueries');
const rateMeQueries = require('../db/rateMeQueries');
const db = require('../db/connection');
const { toE164 } = require('../utils/phoneUtils');
const { resolveCompanyProxyE164 } = require('../services/messagingHelper');
const { logJobActivity, userActor } = require('../services/jobActivityService');
const { withTransaction } = require('../services/transactionService');
const { requirePermission } = require('../middleware/authorization');
const { getProviderScope } = require('../middleware/providerScope');
const eventBus = require('../services/eventBus');
const { notifyOnTheWay, validateEtaMinutes } = require('../services/jobOnTheWayService');

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

function jobUserActor(req) {
    return userActor(req.user?.crmUser?.id || null);
}

// ─── Create Job (directly, no lead) ──────────────────────────────────────────

router.post('/', requirePermission('jobs.create'), async (req, res) => {
    try {
        const companyId = req.companyFilter?.company_id;
        if (!companyId) return res.status(403).json({ ok: false, error: 'Tenant context required' });
        const result = await jobsService.createDirectJob(
            companyId,
            req.body || {},
            jobUserActor(req)
        );
        res.json({ ok: true, data: result });
    } catch (err) {
        console.error('[Jobs API] Create error:', err.message);
        res.status(err.httpStatus || 500).json({ ok: false, error: err.message });
    }
});

// ─── List Jobs ───────────────────────────────────────────────────────────────

router.get('/', requirePermission('jobs.view'), async (req, res) => {
    try {
        const companyId = req.companyFilter?.company_id;
        if (!companyId) {
            return res.status(403).json({
                ok: false,
                error: 'Company context is required',
                code: 'TENANT_CONTEXT_REQUIRED',
            });
        }

        const { blanc_status, canceled, search, offset, limit, cursor, contact_id, sort_by, sort_order, only_open, payment_status, start_date, end_date, service_name, job_source, provider, tag_ids, tag_match } = req.query;
        if (offset !== undefined && (!/^\d+$/.test(String(offset)) || !Number.isSafeInteger(Number(offset)))) {
            return res.status(400).json({ ok: false, error: 'offset must be a non-negative integer', code: 'INVALID_QUERY' });
        }
        if (limit !== undefined && (!/^\d+$/.test(String(limit)) || Number(limit) < 1 || Number(limit) > 500)) {
            return res.status(400).json({ ok: false, error: 'limit must be 1-500', code: 'INVALID_QUERY' });
        }
        if (cursor !== undefined && typeof cursor !== 'string') {
            return res.status(400).json({ ok: false, error: 'Invalid cursor', code: 'INVALID_CURSOR' });
        }
        if (sort_order !== undefined && sort_order !== 'asc' && sort_order !== 'desc') {
            return res.status(400).json({ ok: false, error: 'Invalid sort direction', code: 'INVALID_QUERY' });
        }
        if (canceled !== undefined && canceled !== 'true' && canceled !== 'false') {
            return res.status(400).json({ ok: false, error: 'canceled must be true or false', code: 'INVALID_QUERY' });
        }
        if (tag_match !== undefined && tag_match !== 'any' && tag_match !== 'all') {
            return res.status(400).json({ ok: false, error: 'tag_match must be any or all', code: 'INVALID_QUERY' });
        }

        const result = await jobsService.listJobs({
            blancStatus: blanc_status || undefined,
            zbCanceled: canceled,
            search: search || undefined,
            offset: offset === undefined ? undefined : Number(offset),
            limit: limit === undefined ? 50 : Number(limit),
            cursor,
            companyId,
            contactId: contact_id || undefined,
            sortBy: sort_by || 'start_date',
            sortOrder: sort_order || 'desc',
            onlyOpen: only_open === 'true' || undefined,
            paymentStatus: payment_status === 'unpaid' ? 'unpaid' : undefined,
            startDate: start_date || undefined,
            endDate: end_date || undefined,
            serviceName: service_name || undefined,
            jobSource: job_source || undefined,
            provider: provider || undefined,
            tagIds: tag_ids || undefined,
            tagMatch: tag_match || undefined,
            providerScope: getProviderScope(req),
        });
        res.json({ ok: true, data: result });
    } catch (err) {
        const status = err.statusCode || err.httpStatus || 500;
        if (status >= 500) console.error('[Jobs API] List error:', err.message);
        res.status(status).json({ ok: false, error: err.message, code: err.code || 'INTERNAL_ERROR' });
    }
});

// GET /api/jobs/picker — bounded relationship-picker search.
router.get('/picker', requirePermission('jobs.view'), async (req, res) => {
    try {
        const companyId = req.companyFilter?.company_id;
        if (!companyId) {
            return res.status(403).json({
                ok: false,
                error: 'Company context is required',
                code: 'TENANT_CONTEXT_REQUIRED',
            });
        }

        const { search, limit } = req.query;
        if (search !== undefined && (typeof search !== 'string' || search.length > 200)) {
            return res.status(400).json({ ok: false, error: 'search must be at most 200 characters', code: 'INVALID_QUERY' });
        }
        if (limit !== undefined && (!/^\d+$/.test(String(limit)) || Number(limit) < 1 || Number(limit) > 50)) {
            return res.status(400).json({ ok: false, error: 'limit must be 1-50', code: 'INVALID_QUERY' });
        }

        const result = await jobsService.searchJobsForPicker({
            companyId,
            search: search || undefined,
            limit: limit === undefined ? 20 : Number(limit),
            providerScope: getProviderScope(req),
        });
        return res.json({ ok: true, data: result });
    } catch (err) {
        const status = err.statusCode || err.httpStatus || 500;
        if (status >= 500) console.error('[Jobs API] Picker error:', err.message);
        return res.status(status).json({ ok: false, error: err.message, code: err.code || 'INTERNAL_ERROR' });
    }
});

// ─── Resolve Job URLs ─────────────────────────────────────────────────────────

// Literal URL resolvers must stay above /:id so Express does not swallow them.
router.get('/by-seq/:seq', requirePermission('jobs.view'), async (req, res) => {
    try {
        const seq = Number(req.params.seq);
        if (!/^\d+$/.test(req.params.seq)
            || !Number.isSafeInteger(seq)
            || seq < 1
            || seq > 2147483647) {
            return res.status(400).json({ ok: false, error: 'seq must be a positive integer' });
        }

        const companyId = req.companyFilter?.company_id || null;
        const job = await jobsService.getJobBySeq(companyId, seq, getProviderScope(req));
        if (!job) return res.status(404).json({ ok: false, error: 'Job not found' });
        res.json({ ok: true, data: job });
    } catch (err) {
        console.error('[Jobs API] Get by seq error:', err.message);
        res.status(500).json({ ok: false, error: err.message });
    }
});

router.get('/by-code/:code', requirePermission('jobs.view'), async (req, res) => {
    try {
        const companyId = req.companyFilter?.company_id || null;
        if (!companyId) {
            return res.status(403).json({
                ok: false,
                error: 'Company context is required',
                code: 'TENANT_CONTEXT_REQUIRED',
            });
        }
        const resolvedJob = await jobsService.getJobByCode(req.params.code);
        if (!resolvedJob) return res.status(404).json({ ok: false, error: 'Job not found' });

        const hasCrossCompanyAccess = req.user?.is_super_admin === true
            || req.authz?.platform_role === 'super_admin';
        if (resolvedJob.company_id !== companyId && !hasCrossCompanyAccess) {
            return res.status(404).json({ ok: false, error: 'Job not found' });
        }

        const job = await jobsService.getJobById(
            resolvedJob.id,
            hasCrossCompanyAccess ? resolvedJob.company_id : companyId,
            getProviderScope(req)
        );
        if (!job) return res.status(404).json({ ok: false, error: 'Job not found' });
        res.json({ ok: true, data: job });
    } catch (err) {
        console.error('[Jobs API] Get by code error:', err.message);
        res.status(500).json({ ok: false, error: err.message });
    }
});

// ─── Get canonical Job finance ───────────────────────────────────────────────
router.get('/:id/finance', requirePermission('jobs.view'), async (req, res) => {
    try {
        const companyId = req.companyFilter?.company_id || null;
        if (!companyId) {
            return res.status(403).json({
                ok: false,
                error: 'Company context is required',
                code: 'TENANT_CONTEXT_REQUIRED',
            });
        }
        const finance = await jobsService.getJobFinance(
            req.params.id,
            companyId,
            getProviderScope(req)
        );
        if (!finance) return res.status(404).json({ ok: false, error: 'Job not found' });
        res.json({ ok: true, data: finance });
    } catch (err) {
        console.error('[Jobs API] Get finance error:', err.message);
        res.status(500).json({ ok: false, error: err.message });
    }
});

// ─── Get Job by ID ───────────────────────────────────────────────────────────
router.get('/:id', requirePermission('jobs.view'), async (req, res) => {
    try {
        const companyId = req.companyFilter?.company_id || null;
        if (!companyId) {
            return res.status(403).json({
                ok: false,
                error: 'Company context is required',
                code: 'TENANT_CONTEXT_REQUIRED',
            });
        }
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
        await jobsService.updateJobLocation(
            companyId,
            req.params.id,
            { lat, lng },
            jobUserActor(req)
        );
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
        }, jobUserActor(req));
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
        const result = await jobsService.updateJobTags(
            parseInt(req.params.id, 10),
            tag_ids,
            companyId,
            jobUserActor(req)
        );
        res.json({ ok: true, data: result });
    } catch (err) {
        console.error('[Jobs API] Update tags error:', err.message);
        res.status(err.statusCode || 500).json({ ok: false, error: err.message });
    }
});

// ─── Update Description (inline edit) ─────────────────────────────────────────

router.patch('/:id/description', requirePermission('jobs.edit'), async (req, res) => {
    try {
        const companyId = req.companyFilter?.company_id || null;
        const existing = await jobsService.getJobById(req.params.id, companyId, getProviderScope(req));
        if (!existing) return res.status(404).json({ ok: false, error: 'Job not found' });
        const { description } = req.body;
        if (typeof description !== 'string') return res.status(400).json({ ok: false, error: 'description string required' });
        if (description.length > 5000) return res.status(400).json({ ok: false, error: 'description too long' });
        const result = await jobsService.updateJobDescription(
            parseInt(req.params.id, 10),
            description,
            companyId,
            jobUserActor(req)
        );
        res.json({ ok: true, data: result });
    } catch (err) {
        console.error('[Jobs API] Update description error:', err.message);
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
        // Closing/terminal transitions need a closing permission (PF007-HARDENING-001,
        // ROLE-JOB-CLOSE-PERMS-001). Single source of truth in jobTransitionPerms so
        // this can't drift from the FSM /apply side-door (see that module for the map).
        if (!req.user?._devMode) {
            const permErr = closePermissionError(req.authz?.permissions || [], blanc_status);
            if (permErr) return res.status(permErr.status).json({ ok: false, error: permErr.error });
        }
        const result = await jobsService.updateBlancStatus(
            parseInt(req.params.id, 10),
            blanc_status,
            companyId,
            jobUserActor(req)
        );
        eventService.logEvent(companyId, 'job', req.params.id, 'status_changed',
            { from: existing.blanc_status, to: blanc_status, actor_name: eventService.actorName(req), reason: cancelReason }, 'user', req.user?.sub);
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

        const history = await eventService.getEntityHistory(
            companyId,
            'job',
            jobId,
            job.notes || [],
            { limit: req.query.limit, offset: req.query.offset }
        );
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
        const userId = req.user?.crmUser?.id || null;
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
        const result = await jobsService.addNote(jobId, text, attachments, author, userId, noteId, companyId);
        try {
            unitLabelScanService.queueScan({
                companyId,
                entityType: 'job',
                entityId: jobId,
                sourceNoteId: noteId,
                attachmentIds: attachments
                    .filter(attachment => attachment.content_type?.startsWith('image/'))
                    .map(attachment => attachment.id),
            });
        } catch (scanError) {
            console.warn('[Jobs API] Unit label scan queue failed:', scanError.message);
        }
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
        await notesMutationService.editNote(
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
        await notesMutationService.softDeleteNote(adapter, req.params.noteId, {
            actor: buildNoteActor(req),
            companyId,
        });

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
        const result = await jobsService.cancelJob(
            parseInt(req.params.id, 10),
            companyId,
            jobUserActor(req)
        );
        eventService.logEvent(companyId, 'job', req.params.id, 'canceled',
            { actor_name: eventService.actorName(req), reason: parsedReason.reason }, 'user', req.user?.sub);
        res.json({ ok: true, data: result });
    } catch (err) {
        console.error('[Jobs API] Cancel error:', err.message);
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
        const realtimeService = require('../services/realtimeService');

        // 1. Fetch the current local assignee mirror.
        const { rows } = await db.query(
            `SELECT assigned_provider_user_ids
             FROM jobs
             WHERE id = $1 AND company_id = $2`,
            [jobId, companyId]
        );
        if (!rows.length) return res.status(404).json({ ok: false, error: 'Job not found' });
        const currentProviderUserIds = (rows[0].assigned_provider_user_ids || []).map(String);
        let freshAssignedProviders = null;
        let freshProviderMirror = null;

        if (tech_id) {
            const technician = await require('../services/technicianRosterService')
                .requireActive(companyId, String(tech_id));
            freshAssignedProviders = [{ id: String(technician.id), name: technician.name || '' }];
            freshProviderMirror = await jobsService.resolveAssignedProviderUserIds(
                companyId,
                freshAssignedProviders
            );
        }

        // SCHED-ROUTE-VIS-001 (FR-1, S-8): capture the tech-day pairs this job
        // occupies BEFORE the reschedule so the vacated day repairs too.
        let beforeTechDays = [];
        if (companyId) {
            try {
                const routeQueries = require('../db/routeQueries');
                const tz = await routeQueries.getCompanyTimezone(companyId);
                beforeTechDays = await routeQueries.getTechDaysForJob(companyId, jobId, tz);
            } catch { /* non-fatal */ }
        }

        // 2. Update the local DB immediately.
        const endDate = new Date(new Date(start_date).getTime() + Number(arrival_window_minutes) * 60000).toISOString();
        await withTransaction(async (client) => {
            if (freshAssignedProviders) {
                await client.query(
                    `UPDATE jobs
                     SET assigned_techs = $1::jsonb,
                         assigned_provider_user_ids = $2::jsonb,
                         updated_at = NOW()
                     WHERE id = $3 AND company_id = $4`,
                    [JSON.stringify(freshAssignedProviders), freshProviderMirror, jobId, companyId]
                );
            }
            const { rowCount } = await client.query(
                `UPDATE jobs
                 SET start_date = $1,
                     end_date = $2,
                     zb_rescheduled = true,
                     updated_at = NOW()
                 WHERE id = $3 AND company_id = $4`,
                [start_date, endDate, jobId, companyId]
            );
            if (rowCount === 0) {
                throw Object.assign(new Error('Job not found'), { statusCode: 404 });
            }
            await logJobActivity({
                companyId,
                action: 'job.rescheduled',
                jobId,
                actor: jobUserActor(req),
            }, { client });
            const nextProviderUserIds = freshProviderMirror
                ? JSON.parse(freshProviderMirror).map(String)
                : currentProviderUserIds;
            await eventBus.emit(companyId, 'job.rescheduled', {
                job_id: jobId,
                assignee_user_ids: nextProviderUserIds,
                record_refs: [{ type: 'job', id: jobId }],
            }, {
                actorType: 'user',
                actorId: req.user?.crmUser?.id || null,
                aggregateType: 'job',
                aggregateId: jobId,
                client,
            });
            if (freshProviderMirror) {
                const previous = new Set(currentProviderUserIds);
                const next = new Set(nextProviderUserIds);
                const added = nextProviderUserIds.filter(id => !previous.has(id));
                const removed = currentProviderUserIds.filter(id => !next.has(id));
                if (added.length) {
                    await eventBus.emit(companyId, 'job.assigned', {
                        job_id: jobId,
                        assignee_user_ids: added,
                        record_refs: [{ type: 'job', id: jobId }],
                    }, {
                        actorType: 'user',
                        actorId: req.user?.crmUser?.id || null,
                        aggregateType: 'job',
                        aggregateId: jobId,
                        client,
                    });
                }
                if (removed.length) {
                    await eventBus.emit(companyId, 'job.unassigned', {
                        job_id: jobId,
                        previous_recipient_user_ids: removed,
                        previous_assigned_provider_user_ids: currentProviderUserIds,
                        record_refs: [{ type: 'job', id: jobId }],
                    }, {
                        actorType: 'user',
                        actorId: req.user?.crmUser?.id || null,
                        aggregateType: 'job',
                        aggregateId: jobId,
                        client,
                    });
                }
            }
        });

        // SCHED-ROUTE-VIS-001 (FR-1, S-8): best-effort route recalc after the
        // local UPDATE — fire-and-forget, the HTTP response never waits.
        if (companyId) {
            require('../services/routeSegmentService')
                .recalcForJob(companyId, jobId, { beforeTechDays })
                .catch(e => console.error('[Jobs API] reschedule recalc failed (non-fatal):', e.message));
        }

        // 3. Return updated job immediately (frontend gets instant response)
        const updated = await jobsService.getJobById(jobId, companyId);
        res.json({ ok: true, data: updated });
        realtimeService.publishJobUpdate(updated);
    } catch (err) {
        console.error('[Jobs API] Reschedule error:', err.message);
        res.status(err.statusCode || err.httpStatus || 500).json({ ok: false, error: err.message });
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
// With body.skip_status=true this is notify-only; the normal FSM transition has
// already changed status and this endpoint must not perform a second write.
router.post('/:id/eta/notify', requirePermission('messages.send'), async (req, res) => {
    try {
        const companyId = req.companyFilter?.company_id || null;
        const jobId = parseInt(req.params.id, 10);

        // Validate eta_minutes: integer 1–600 (defense-in-depth; UI validates too).
        const eta = req.body?.eta_minutes;
        if (!validateEtaMinutes(eta)) {
            return res.status(400).json({ ok: false, error: 'invalid_eta' });
        }

        const job = await jobsService.getJobById(jobId, companyId, getProviderScope(req));
        if (!job) return res.status(404).json({ ok: false, error: 'Job not found' });

        try {
            await notifyOnTheWay({
                job,
                companyId,
                etaMinutes: eta,
                activityActor: jobUserActor(req),
            });
        } catch (sendErr) {
            if (sendErr.code === 'invalid_eta') {
                return res.status(400).json({ ok: false, error: 'invalid_eta' });
            }
            return res.status(sendErr.httpStatus || 500).json({
                ok: false,
                code: sendErr.code,
                message: sendErr.message,
            });
        }

        if (req.body?.skip_status === true) {
            return res.json({ ok: true, data: { sent: true } });
        }

        // SMS sent (primary success). Advance status best-effort — no SMS rollback.
        try {
            await jobsService.updateBlancStatus(
                jobId,
                'On the way',
                companyId,
                jobUserActor(req)
            );
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
                    companyId,
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
        await logJobActivity({
            companyId,
            action: channel === 'copy'
                ? 'job.rating_link_created'
                : 'job.rating_link_sent',
            jobId,
            actor: jobUserActor(req),
            summary: { channel },
        });
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
const paymentsService = require('../services/paymentsService');
const { userActor: financialUserActor } = require('../services/financialActivityService');
const { withTransaction: withFinancialTransaction } = require('../services/transactionService');

function jobStripeError(err, res) {
    if (err instanceof stripePaymentsService.StripePaymentsError) {
        return res.status(err.httpStatus || 400).json({
            ok: false,
            error: { code: err.code, message: err.message, ...(err.details || {}) },
        });
    }
    console.error('[Jobs API] stripe error:', err.message);
    return res.status(err.httpStatus || 500).json({ ok: false, error: { code: err.code || 'INTERNAL', message: err.message } });
}

function jobStripeAccess(req) {
    const providerScope = getProviderScope(req);
    return {
        actorId: req.user?.crmUser?.id || null,
        providerLimited: !req.user?._devMode && providerScope.assignedOnly,
        providerScope,
    };
}

router.post('/:id/stripe-manual-card-session', requirePermission('payments.collect_keyed'), async (req, res) => {
    try {
        const companyId = req.companyFilter?.company_id;
        const actor = { id: req.user?.crmUser?.id || null };
        const data = await withFinancialTransaction(client => (
            stripePaymentsService.createManualCardSession(
                companyId,
                actor,
                { jobId: req.params.id, amount: req.body?.amount },
                client,
                financialUserActor(actor.id),
                jobStripeAccess(req)
            )
        ));
        res.json({ ok: true, data });
    } catch (err) { jobStripeError(err, res); }
});

router.get('/:id/saved-payment-methods', requirePermission('payments.collect_online'), async (req, res) => {
    try {
        const data = await stripePaymentsService.listJobSavedCards(
            req.companyFilter?.company_id,
            req.params.id,
            jobStripeAccess(req)
        );
        res.json({ ok: true, data });
    } catch (err) { jobStripeError(err, res); }
});

router.post('/:id/charge-saved-payment-method', requirePermission('payments.collect_online'), async (req, res) => {
    try {
        const actor = { id: req.user?.crmUser?.id || null };
        const data = await stripePaymentsService.chargeJobSavedCard(
            req.companyFilter?.company_id,
            actor,
            req.params.id,
            {
                savedCardId: req.body?.saved_card_id,
                amount: req.body?.amount,
                expectedDue: req.body?.expected_due,
                requestKey: req.body?.request_key,
            },
            jobStripeAccess(req)
        );
        res.json({ ok: true, data });
    } catch (err) { jobStripeError(err, res); }
});

router.post('/:id/tap-to-pay/payment-intent', requirePermission('payments.collect_terminal'), async (req, res) => {
    try {
        const companyId = req.companyFilter?.company_id;
        const actor = { id: req.user?.crmUser?.id || null };
        const data = await withFinancialTransaction(client => (
            stripePaymentsService.createTapToPayIntent(
                companyId,
                actor,
                { jobId: req.params.id, amount: req.body?.amount },
                client,
                financialUserActor(actor.id)
            )
        ));
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
        const data = await stripePaymentsService.sendJobPaymentLink(companyId, { id: req.user?.crmUser?.id || null }, req.params.id, { channel: req.body?.channel, amount: req.body?.amount, message: req.body?.message, recipient: req.body?.recipient });
        res.json({ ok: true, data });
    } catch (err) { jobStripeError(err, res); }
});

function jobPaymentError(err, res) {
    if (err instanceof paymentsService.PaymentsServiceError) {
        return res.status(err.httpStatus || 400).json({ ok: false, error: { code: err.code, message: err.message } });
    }
    console.error('[Jobs API] record payment error:', err.message);
    return res.status(500).json({ ok: false, error: { code: 'INTERNAL', message: err.message } });
}

router.post('/:id/record-payment', requirePermission('payments.collect_offline'), async (req, res) => {
    try {
        const companyId = req.companyFilter?.company_id;
        const job = await jobsService.getJobById(req.params.id, companyId);
        if (!job) {
            return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: 'Job not found' } });
        }

        const actorId = req.user?.crmUser?.id || null;
        const amount = parseFloat(req.body?.amount);
        if (!Number.isFinite(amount) || amount <= 0) {
            return res.status(400).json({ ok: false, error: { code: 'VALIDATION', message: 'amount must be greater than 0' } });
        }

        const payment_method = req.body?.payment_method;
        if (!['cash', 'check'].includes(payment_method)) {
            return res.status(400).json({ ok: false, error: { code: 'VALIDATION', message: 'payment_method must be one of: cash, check' } });
        }

        const processed_at = req.body?.payment_date || req.body?.processed_at || undefined;
        const data = await withFinancialTransaction(client => (
            paymentsService.recordManualPayment(
                companyId,
                actorId,
                {
                    job_id: req.params.id,
                    amount,
                    payment_method,
                    reference_number: req.body?.reference_number,
                    memo: req.body?.memo,
                    processed_at,
                },
                client,
                financialUserActor(actorId)
            )
        ));
        res.json({ ok: true, data });
    } catch (err) { jobPaymentError(err, res); }
});

// ─── Resolve a masked dial number for this job's contact ─────────────────────

router.get('/:id/call-masking', requirePermission('call_masking.use'), async (req, res) => {
    try {
        if (!/^\d+$/.test(req.params.id)) {
            return res.status(404).json({ ok: false, error: 'Job not found', code: 'NOT_FOUND' });
        }
        const result = await require('../services/callMaskingService').getMaskedDialForJob(
            req.companyFilter?.company_id,
            req.params.id,
            getProviderScope(req),
            undefined,
            req.user?.crmUser?.id || null
        );
        if (!result) {
            return res.status(404).json({ ok: false, error: 'Job not found', code: 'NOT_FOUND' });
        }
        res.json({ ok: true, data: result });
    } catch (err) {
        const status = err.httpStatus || 500;
        if (status >= 500) console.error('[Jobs API] Call masking error:', err.message);
        res.status(status).json({
            ok: false,
            error: status >= 500 ? 'Failed to resolve call masking number' : err.message,
            code: err.code || 'INTERNAL_ERROR',
        });
    }
});

module.exports = router;
