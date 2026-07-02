/**
 * Sync Queries — MOBILE-TECH-APP-001 / MTECH-T1
 *
 * Provider-scoped delta-sync reads that back `GET /api/sync/jobs` (spec §2.1–§2.4,
 * §4.1). Three company-scoped, provider-scoped queries:
 *
 *   - getChangedJobs   — the `changed[]` page: jobs assigned to the current
 *                        crm_user, forward-paginated on a stable (updated_at, id)
 *                        cursor (initial full sync uses a window + open-status
 *                        filter instead of a cursor). Returns full Job objects
 *                        (same shape as GET /api/jobs/:id) with a guaranteed
 *                        notes[] whose attachments carry NO presigned URL.
 *   - getUnassignedJobIds — `unassigned[]`: ids of company jobs touched since the
 *                        cursor that the caller can NO LONGER see under scope
 *                        (re-assigned away). Ids only — no fields leak.
 *   - getTombstoneJobIds  — `tombstones[]`: ids hard-deleted since the cursor
 *                        (from job_tombstones, migration 150).
 *
 * Cursor pattern mirrors backend/src/db/emailQueries.js (`"{ts}|{id}"`,
 * `(col, id) <cmp> ($ts, $id)`) but FORWARD: `ORDER BY updated_at ASC, id ASC`,
 * `WHERE (updated_at, id) > ($ts, $id)` — so a batch of jobs sharing one
 * updated_at (e.g. a Zenbooker bulk sync) is neither lost nor duplicated; id
 * breaks the tie deterministically (same trick as getUnifiedTimelinePage).
 *
 * Tenant isolation: EVERY query is filtered by company_id (spec §10). The scope
 * predicate is `assigned_provider_user_ids @> $me::jsonb` (GIN-indexed) with the
 * caller's crm_users.id — identical to jobsService.getJobById / listJobs.
 */
const db = require('./connection');

// Open (non-terminal) statuses for the initial full-sync fallback (spec §2.4):
// a fresh install pulls everything in the schedule window PLUS every still-open
// job outside it, so an old-but-active job is never missed.
const TERMINAL_BLANC_STATUSES = ['Visit completed', 'Job is Done', 'Canceled'];

// Column list mirrors jobsService.getJobById's `SELECT j.*, l.serial_id AS
// lead_serial_id` so rowToSyncJob() below can reuse the exact same mapping.
const JOB_SELECT = `
    SELECT j.*, l.serial_id AS lead_serial_id
    FROM jobs j
    LEFT JOIN leads l ON l.id = j.lead_id AND l.company_id = j.company_id
`;

/**
 * Map a raw jobs row to the wire Job shape. Field-for-field identical to
 * jobsService.rowToJob (the source of truth for GET /api/jobs/:id) — kept in sync
 * with it; if that mapping changes, mirror the change here. `notes` are attached
 * separately by the caller (enriched), so this leaves row.notes as-is.
 */
function rowToSyncJob(row) {
    return {
        id: row.id,
        lead_id: row.lead_id,
        lead_serial_id: row.lead_serial_id || null,
        contact_id: row.contact_id,
        zenbooker_job_id: row.zenbooker_job_id,

        blanc_status: row.blanc_status,
        zb_status: row.zb_status,
        zb_rescheduled: row.zb_rescheduled,
        zb_canceled: row.zb_canceled,

        job_number: row.job_number,
        service_name: row.service_name,
        start_date: row.start_date ? row.start_date.toISOString() : null,
        end_date: row.end_date ? row.end_date.toISOString() : null,
        customer_name: row.customer_name,
        customer_phone: row.customer_phone,
        customer_email: row.customer_email,
        address: row.address,
        city: row.city || null,
        territory: row.territory,
        invoice_total: row.invoice_total,
        invoice_status: row.invoice_status,
        assigned_techs: row.assigned_techs || [],
        assigned_provider_user_ids: row.assigned_provider_user_ids || [],
        notes: row.notes || [],
        tags: row.tags || [],

        job_type: row.job_type || null,
        job_source: row.job_source || null,
        description: row.description || null,
        comments: row.comments || null,
        metadata: row.metadata || {},

        company_id: row.company_id,
        created_at: row.created_at ? row.created_at.toISOString() : null,
        updated_at: row.updated_at ? row.updated_at.toISOString() : null,

        lat: row.lat || null,
        lng: row.lng || null,

        zb_raw: row.zb_raw || null,
    };
}

/**
 * Parse a `"{ISO8601}|{jobId}"` cursor into `{ ts, id }`. Returns null when the
 * input is empty/undefined (→ initial full sync). Throws on a malformed cursor
 * (missing `|`, unparseable timestamp, non-integer id) so the route can answer
 * `400` (spec §4.1 errors). Never silently coerces a bad cursor to full sync —
 * that would re-pull everything on a client bug.
 */
function parseCursor(since) {
    if (since === undefined || since === null || since === '') return null;
    if (typeof since !== 'string') {
        throw new Error('Invalid cursor: expected "{ISO8601}|{jobId}"');
    }
    const sep = since.lastIndexOf('|');
    if (sep <= 0 || sep === since.length - 1) {
        throw new Error('Invalid cursor: expected "{ISO8601}|{jobId}"');
    }
    const tsRaw = since.slice(0, sep);
    const idRaw = since.slice(sep + 1);
    const ms = Date.parse(tsRaw);
    if (!Number.isFinite(ms)) {
        throw new Error('Invalid cursor: unparseable timestamp');
    }
    if (!/^\d+$/.test(idRaw)) {
        throw new Error('Invalid cursor: job id must be a positive integer');
    }
    // Normalize the timestamp so the DB comparison uses a canonical ISO value.
    return { ts: new Date(ms).toISOString(), id: idRaw };
}

/** Serialize the cursor for the last row of a `changed` page. */
function serializeCursor(job) {
    return `${job.updated_at}|${job.id}`;
}

/**
 * Fetch attachment metadata for a set of job ids (company-scoped), WITHOUT
 * presigned URLs (spec §2.1: attachments are `{id, fileName, contentType,
 * fileSize}`; the URL is fetched lazily by the client via
 * GET /api/note-attachments/:id/url). One query for the whole page (no N+1, no
 * per-attachment S3 signing). Returns a Map<jobId, { byNoteId, byNoteIndex }>.
 * Mirrors the join keys used by jobs.js enrichJobNotes (note_id, else note_index).
 */
async function getAttachmentsByJob(companyId, jobIds) {
    const map = new Map();
    if (!jobIds.length) return map;
    const { rows } = await db.query(
        `SELECT entity_id AS job_id, id, note_index, note_id, file_name, content_type, file_size
         FROM note_attachments
         WHERE company_id = $1
           AND entity_type = 'job'
           AND entity_id = ANY($2::bigint[])
           AND note_index IS NOT NULL
         ORDER BY created_at`,
        [companyId, jobIds]
    );
    for (const r of rows) {
        let entry = map.get(String(r.job_id));
        if (!entry) { entry = { byNoteId: {}, byNoteIndex: {} }; map.set(String(r.job_id), entry); }
        const att = {
            id: r.id,
            fileName: r.file_name,
            contentType: r.content_type,
            fileSize: r.file_size,
        };
        if (r.note_id) (entry.byNoteId[r.note_id] ||= []).push(att);
        else (entry.byNoteIndex[r.note_index] ||= []).push(att);
    }
    return map;
}

// Coarse content-type guess for legacy Zenbooker image/file note URLs that have
// no attachment row — mirrors jobs.js guessContentTypeFromUrl (kept minimal).
function guessContentType(url, isImage) {
    const clean = String(url).split('?')[0].split('#')[0];
    const ext = clean.includes('.') ? clean.slice(clean.lastIndexOf('.') + 1).toLowerCase() : '';
    const map = {
        jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif',
        webp: 'image/webp', heic: 'image/heic', bmp: 'image/bmp', svg: 'image/svg+xml',
        pdf: 'application/pdf', mp4: 'video/mp4', mov: 'video/quicktime',
        doc: 'application/msword',
        docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    };
    return map[ext] || (isImage ? 'image/jpeg' : 'application/octet-stream');
}

function zbUrlToAttachmentMeta(id, url, isImage) {
    let fileName = '';
    try { fileName = decodeURIComponent(String(url).split('?')[0].split('/').pop() || ''); } catch { fileName = ''; }
    if (!fileName) fileName = isImage ? 'image' : 'file';
    // NO url field — sync payload never carries a presigned/raw URL (spec §2.1).
    return { id, fileName, contentType: guessContentType(url, isImage), fileSize: 0 };
}

const ZB_ID_RE = /^(\d{13,})x[\w-]+$/;

/**
 * Build the enriched notes[] for a job (spec §2.1: guaranteed notes[], each with
 * attachments[] as {id, fileName, contentType, fileSize} — NO URL). Excludes
 * soft-deleted notes, derives `created` from the Zenbooker id when absent, and
 * resolves attachments from three sources in the same precedence order as
 * jobs.js normalizeJobNote: already-normalized note.attachments → ZB images/files
 * → uploaded note_attachments rows. Purely in-memory apart from the single
 * attachments query the caller already ran.
 */
function enrichNotes(rawNotes, attachEntry, fallbackCreated) {
    const byNoteId = attachEntry?.byNoteId || {};
    const byNoteIndex = attachEntry?.byNoteIndex || {};
    return (rawNotes || [])
        .map((n, i) => ({ n, i }))
        .filter(({ n }) => !n.deleted_at)
        .map(({ n, i }) => {
            const zbMatch = typeof n.id === 'string' ? n.id.match(ZB_ID_RE) : null;

            let created = n.created || null;
            if (!created && zbMatch) {
                const ms = Number(zbMatch[1]);
                if (Number.isFinite(ms) && ms > 1e12) created = new Date(ms).toISOString();
            }
            if (!created) created = fallbackCreated;

            let attachments = [];
            if (Array.isArray(n.attachments) && n.attachments.length > 0) {
                // Strip any url the stored note may carry; keep only the metadata.
                attachments = n.attachments.map((a) => ({
                    id: a.id,
                    fileName: a.fileName || a.file_name || null,
                    contentType: a.contentType || a.content_type || null,
                    fileSize: a.fileSize ?? a.file_size ?? 0,
                }));
            } else if ((Array.isArray(n.images) && n.images.length) || (Array.isArray(n.files) && n.files.length)) {
                const noteKey = n.id || `note-${i}`;
                (n.images || []).forEach((url, k) => attachments.push(zbUrlToAttachmentMeta(`${noteKey}-img-${k}`, url, true)));
                (n.files || []).forEach((url, k) => attachments.push(zbUrlToAttachmentMeta(`${noteKey}-file-${k}`, url, false)));
            } else {
                const local = (n.id && byNoteId[n.id]) || byNoteIndex[i] || [];
                attachments = local;
            }

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
            };
        });
}

/**
 * `changed[]` — the paginated set of jobs assigned to `crmUserId` in `companyId`.
 *
 * @param {object} args
 * @param {string} args.companyId
 * @param {string} args.crmUserId       resolved crm_users.id (caller guarantees non-null)
 * @param {{ts:string,id:string}|null} args.cursor  null → initial full sync
 * @param {number} args.limit           page size (has_more detected via LIMIT+1)
 * @param {number} args.windowDays      full-sync schedule window (± from now)
 * @returns {Promise<{ jobs: Job[], hasMore: boolean, nextCursor: string|null }>}
 */
async function getChangedJobs({ companyId, crmUserId, cursor, limit, windowDays }) {
    const params = [companyId, JSON.stringify([crmUserId])];
    const conditions = [
        'j.company_id = $1',
        'j.assigned_provider_user_ids @> $2::jsonb',
    ];

    if (cursor) {
        // Incremental: strictly after the cursor, NO window bound (spec §2.4 —
        // an edit to an old open job outside the window must not be missed).
        params.push(cursor.ts, cursor.id);
        conditions.push(`(j.updated_at, j.id) > ($${params.length - 1}, $${params.length})`);
    } else {
        // Initial full sync: jobs whose start_date is within ±windowDays of now,
        // OR any still-open job (regardless of date). start_date NULL jobs are
        // "unscheduled" — include them via the open-status arm so they aren't lost.
        params.push(String(windowDays));
        const windowParam = `$${params.length}`;
        params.push(TERMINAL_BLANC_STATUSES);
        const terminalParam = `$${params.length}`;
        conditions.push(`(
            (j.start_date IS NOT NULL
                AND j.start_date >= now() - (${windowParam} || ' days')::interval
                AND j.start_date <= now() + (${windowParam} || ' days')::interval)
            OR j.blanc_status <> ALL(${terminalParam}::text[])
        )`);
    }

    params.push(limit + 1); // one extra row → has_more
    const { rows } = await db.query(
        `${JOB_SELECT}
         WHERE ${conditions.join(' AND ')}
         ORDER BY j.updated_at ASC, j.id ASC
         LIMIT $${params.length}`,
        params
    );

    const hasMore = rows.length > limit;
    if (hasMore) rows.pop();

    const jobs = rows.map(rowToSyncJob);

    // Enrich notes[] for the page in one attachments query (no N+1).
    const jobIds = jobs.map((j) => j.id);
    const attachMap = await getAttachmentsByJob(companyId, jobIds);
    for (const job of jobs) {
        const raw = job.notes;
        job.notes = enrichNotes(raw, attachMap.get(String(job.id)), job.updated_at);
    }

    const nextCursor = jobs.length > 0 ? serializeCursor(jobs[jobs.length - 1]) : null;
    return { jobs, hasMore, nextCursor };
}

/**
 * `unassigned[]` — ids of company jobs updated since the cursor that the caller
 * can NO LONGER see under scope (re-assigned away). Ids only; no fields leak
 * (spec §2.3). "Could I have seen it before" is not knowable (no membership
 * history), so the safe rule returns every not-visible id changed since `since`;
 * the client removes those it had cached, and it's a no-op for the rest.
 *
 * Only meaningful on an incremental delta (cursor present). On initial full sync
 * there is nothing cached to delete → caller passes cursor=null → returns [].
 */
async function getUnassignedJobIds({ companyId, crmUserId, cursor }) {
    if (!cursor) return [];
    const { rows } = await db.query(
        `SELECT j.id
         FROM jobs j
         WHERE j.company_id = $1
           AND j.updated_at > $2
           AND NOT (j.assigned_provider_user_ids @> $3::jsonb)`,
        [companyId, cursor.ts, JSON.stringify([crmUserId])]
    );
    return rows.map((r) => r.id);
}

/**
 * `tombstones[]` — ids hard-deleted since the cursor (job_tombstones, mig 150),
 * company-scoped (spec §2.3). Only meaningful incrementally (cursor present).
 */
async function getTombstoneJobIds({ companyId, cursor }) {
    if (!cursor) return [];
    const { rows } = await db.query(
        `SELECT job_id
         FROM job_tombstones
         WHERE company_id = $1
           AND deleted_at > $2`,
        [companyId, cursor.ts]
    );
    return rows.map((r) => r.job_id);
}

/**
 * Write a hard-delete tombstone in the caller's transaction (spec §2.3, §8.T1).
 * Called by whatever path physically DELETEs a job, using the SAME pg client so
 * the tombstone and the DELETE commit atomically. Idempotent
 * (ON CONFLICT DO NOTHING on the (company_id, job_id) PK). No such delete path
 * exists in the app today — this is the ready hook for when one is added.
 *
 * @param {object} client  a pg client already inside a transaction (BEGIN issued)
 * @param {string} companyId
 * @param {number|string} jobId
 */
async function insertJobTombstone(client, companyId, jobId) {
    await client.query(
        `INSERT INTO job_tombstones (company_id, job_id, deleted_at)
         VALUES ($1, $2, now())
         ON CONFLICT (company_id, job_id) DO NOTHING`,
        [companyId, jobId]
    );
}

module.exports = {
    parseCursor,
    serializeCursor,
    getChangedJobs,
    getUnassignedJobIds,
    getTombstoneJobIds,
    insertJobTombstone,
    // exported for unit tests
    rowToSyncJob,
    enrichNotes,
    TERMINAL_BLANC_STATUSES,
};
