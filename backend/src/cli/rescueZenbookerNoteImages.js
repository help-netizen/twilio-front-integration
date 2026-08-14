#!/usr/bin/env node
'use strict';

/**
 * ZB-IMAGE-RESCUE-001: bring the job photos home.
 *
 * The Zenbooker import copied job notes but not the photographs in them. What it
 * stored is a link:
 *
 *   { "id": "1770…", "text": null, "images": ["https://…cdn.bubble.io/f177…/IMG.jpeg"] }
 *
 * So ~3,000 site photos across ~1,000 jobs live on a decommissioned vendor's CDN
 * and exist nowhere else. The day that CDN stops answering, they are gone — there
 * is no copy to restore from. This downloads each one into our own storage,
 * records it as an ordinary note attachment (thumbnail and all), and rewrites the
 * note to stop pointing at bubble.io.
 *
 * Usage:
 *   node backend/src/cli/rescueZenbookerNoteImages.js --company-id=<uuid>
 *   node backend/src/cli/rescueZenbookerNoteImages.js --company-id=<uuid> --apply
 *   …optionally --job-id=<id> | --limit=<jobs> | --concurrency=<n>
 *
 * Dry-run is the default and only reads: it asks each URL whether it is still
 * alive, so you learn how much is already lost BEFORE anything is written.
 *
 * Resumable and idempotent by construction: a rescued URL is removed from
 * `images` and kept in `zb_images_rescued` on the same note, so a second run
 * finds nothing to do and no photo is ever fetched or stored twice. A URL that
 * fails stays in `images` and is retried next run.
 */

const db = require('../db/connection');
const storageService = require('../services/storageService');
const noteAttachmentsService = require('../services/noteAttachmentsService');

const EXTERNAL_HOST = /(^|\.)bubble\.io$|(^|\.)zenbooker\.com$/i;

/**
 * A Zenbooker note keeps photographs in `images` and everything else — the
 * signed work order, a part invoice — in `files`. Both are plain URL arrays and
 * both point at the vendor, so both come home; only the field they are archived
 * into differs.
 */
const RESCUE_FIELDS = [
    { source: 'images', archive: 'zb_images_rescued' },
    { source: 'files', archive: 'zb_files_rescued' },
];
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FETCH_TIMEOUT_MS = 60_000;

const EXTENSION_TYPES = {
    '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
    '.webp': 'image/webp', '.gif': 'image/gif', '.heic': 'image/heic', '.heif': 'image/heif',
    '.pdf': 'application/pdf',
};

function parseArgs(argv) {
    const args = { companyId: null, apply: false, jobId: null, limit: null, concurrency: 6 };
    for (const arg of argv) {
        if (arg === '--apply') args.apply = true;
        else if (arg.startsWith('--company-id=')) args.companyId = arg.slice('--company-id='.length);
        else if (arg.startsWith('--job-id=')) args.jobId = Number(arg.slice('--job-id='.length));
        else if (arg.startsWith('--limit=')) args.limit = Number(arg.slice('--limit='.length));
        else if (arg.startsWith('--concurrency=')) args.concurrency = Number(arg.slice('--concurrency='.length));
        else throw new Error(`Unknown argument: ${arg}`);
    }
    if (!UUID_SHAPE.test(args.companyId || '')) throw new Error('--company-id=<uuid> is required');
    if (!Number.isInteger(args.concurrency) || args.concurrency < 1 || args.concurrency > 16) {
        throw new Error('--concurrency must be 1..16');
    }
    return args;
}

function isExternalImageUrl(value) {
    if (typeof value !== 'string' || !/^https?:\/\//i.test(value)) return false;
    try {
        return EXTERNAL_HOST.test(new URL(value).hostname);
    } catch {
        return false;
    }
}

/** Zenbooker keeps the original filename as the last path segment. */
function fileNameFromUrl(url) {
    try {
        const raw = decodeURIComponent(new URL(url).pathname.split('/').pop() || '');
        const cleaned = raw.replace(/[^A-Za-z0-9._-]/g, '_').slice(-120);
        return cleaned || 'zenbooker-image.jpg';
    } catch {
        return 'zenbooker-image.jpg';
    }
}

function contentTypeFor(fileName, headerValue) {
    const fromHeader = (headerValue || '').split(';')[0].trim().toLowerCase();
    if (fromHeader && fromHeader !== 'application/octet-stream' && fromHeader !== 'binary/octet-stream') {
        return fromHeader;
    }
    const dot = fileName.lastIndexOf('.');
    const ext = dot === -1 ? '' : fileName.slice(dot).toLowerCase();
    return EXTENSION_TYPES[ext] || 'application/octet-stream';
}

/**
 * Is the file still there?
 *
 * HEAD alone lies: `zenbooker.com/fileupload/…` answers 403 to HEAD and 200 to
 * GET, because it only signs a CDN redirect for a real read. A dry-run that
 * trusted HEAD called twenty live files dead — so a refused HEAD is re-asked as
 * a one-byte ranged GET, which costs nothing and tells the truth.
 */
async function probe(url) {
    const attempt = async init => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
        try {
            const res = await fetch(url, { ...init, signal: controller.signal });
            return { ok: res.ok, status: res.status };
        } catch (err) {
            return { ok: false, status: 0, error: String(err.message || err) };
        } finally {
            clearTimeout(timer);
        }
    };

    const head = await attempt({ method: 'HEAD' });
    if (head.ok) return { alive: true, status: head.status };

    const ranged = await attempt({ headers: { Range: 'bytes=0-0' } });
    return { alive: ranged.ok, status: ranged.status, error: ranged.error };
}

async function download(url) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
        const res = await fetch(url, { signal: controller.signal });
        if (!res.ok) return { ok: false, status: res.status };
        const buffer = Buffer.from(await res.arrayBuffer());
        return { ok: true, status: res.status, buffer, contentType: res.headers.get('content-type') };
    } catch (err) {
        return { ok: false, status: 0, error: String(err.message || err) };
    } finally {
        clearTimeout(timer);
    }
}

/** Run tasks with a small fixed concurrency — the CDN is a guest, not a target. */
async function mapLimit(items, limit, worker) {
    const results = [];
    let cursor = 0;
    const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (cursor < items.length) {
            const index = cursor++;
            results[index] = await worker(items[index], index);
        }
    });
    await Promise.all(runners);
    return results;
}

/**
 * Store one photo and record it exactly as an in-app upload would: original and
 * thumbnail beside each other, one note_attachments row bound to the note.
 */
async function storeImage(companyId, jobId, note, noteIndex, url, buffer, contentType) {
    const fileName = fileNameFromUrl(url);
    const storageKey = storageService.generateStorageKey(companyId, 'job', jobId, fileName);

    await storageService.uploadFile(buffer, contentType, storageKey);

    // A thumbnail is a convenience, not the payload: a format sharp cannot read
    // (HEIC without libheif, say) must not cost us the photograph itself.
    if (noteAttachmentsService.isImageContentType(contentType)) {
        try {
            const thumbnail = await noteAttachmentsService.createThumbnailBuffer(buffer);
            await storageService.uploadFile(
                thumbnail, 'image/jpeg', noteAttachmentsService.generateThumbnailStorageKey(storageKey)
            );
        } catch (err) {
            console.warn(`[ZBImageRescue] thumbnail failed for ${fileName}: ${err.message}`);
        }
    }

    const { rows } = await db.query(
        `INSERT INTO note_attachments
             (company_id, entity_type, entity_id, note_id, note_index,
              file_name, content_type, file_size, storage_key, uploaded_by)
         VALUES ($1, 'job', $2, $3, $4, $5, $6, $7, $8, NULL)
         RETURNING id`,
        [companyId, jobId, note.id || null, noteIndex, fileName, contentType, buffer.length, storageKey]
    );
    return { attachmentId: rows[0].id, storageKey, fileName, bytes: buffer.length };
}

async function run() {
    const args = parseArgs(process.argv.slice(2));
    const where = ['company_id = $1', `notes::text ~* '(bubble\\.io|zenbooker\\.com)'`];
    const params = [args.companyId];
    if (Number.isInteger(args.jobId)) {
        params.push(args.jobId);
        where.push(`id = $${params.length}`);
    }
    const limitClause = Number.isInteger(args.limit) ? ` LIMIT ${args.limit}` : '';

    const { rows: jobs } = await db.query(
        `SELECT id, notes FROM jobs WHERE ${where.join(' AND ')} ORDER BY id${limitClause}`,
        params
    );

    const summary = {
        mode: args.apply ? 'apply' : 'dry-run',
        company_id: args.companyId,
        jobs_scanned: jobs.length,
        notes_with_external_images: 0,
        urls_found: 0,
        urls_alive: 0,
        urls_dead: 0,
        rescued: 0,
        bytes_stored: 0,
        jobs_rewritten: 0,
        failed: 0,
    };

    for (const job of jobs) {
        const notes = Array.isArray(job.notes) ? job.notes : [];
        let jobChanged = false;

        for (let index = 0; index < notes.length; index += 1) {
            const note = notes[index];
            if (!note || typeof note !== 'object') continue;

            for (const field of RESCUE_FIELDS) {
                const held = Array.isArray(note[field.source]) ? note[field.source] : [];
                const external = held.filter(isExternalImageUrl);
                if (external.length === 0) continue;

                summary.notes_with_external_images += 1;
                summary.urls_found += external.length;

                if (!args.apply) {
                    const probes = await mapLimit(external, args.concurrency, probe);
                    probes.forEach(result => {
                        if (result.alive) summary.urls_alive += 1;
                        else summary.urls_dead += 1;
                    });
                    continue;
                }

                const outcomes = await mapLimit(external, args.concurrency, async url => {
                    const got = await download(url);
                    if (!got.ok) return { url, ok: false, status: got.status, error: got.error };
                    try {
                        const contentType = contentTypeFor(fileNameFromUrl(url), got.contentType);
                        const stored = await storeImage(
                            args.companyId, job.id, note, index, url, got.buffer, contentType
                        );
                        return { url, ok: true, ...stored };
                    } catch (err) {
                        return { url, ok: false, status: got.status, error: String(err.message || err) };
                    }
                });

                const rescuedUrls = new Set();
                for (const outcome of outcomes) {
                    if (outcome.ok) {
                        summary.rescued += 1;
                        summary.urls_alive += 1;
                        summary.bytes_stored += outcome.bytes;
                        rescuedUrls.add(outcome.url);
                    } else {
                        summary.failed += 1;
                        if (outcome.status === 404 || outcome.status === 410) summary.urls_dead += 1;
                        console.warn(`[ZBImageRescue] job ${job.id} note ${index} ${field.source}: ${outcome.url} — ${outcome.error || 'HTTP ' + outcome.status}`);
                    }
                }

                if (rescuedUrls.size > 0) {
                    // The URL leaves the note so it stops reaching for the vendor
                    // (the attachment now carries the file), and lands in the
                    // archive field so where it came from is never lost.
                    note[field.source] = held.filter(url => !rescuedUrls.has(url));
                    note[field.archive] = [...(note[field.archive] || []), ...rescuedUrls];
                    jobChanged = true;
                }
            }
        }

        if (jobChanged) {
            await db.query(
                `UPDATE jobs SET notes = $1::jsonb, updated_at = NOW() WHERE id = $2 AND company_id = $3`,
                [JSON.stringify(notes), job.id, args.companyId]
            );
            summary.jobs_rewritten += 1;
        }
    }

    console.log(JSON.stringify(summary, null, 2));
}

if (require.main === module) {
    run()
        .then(() => process.exit(0))
        .catch(err => {
            console.error(`[ZBImageRescue] ${err.message}`);
            process.exit(1);
        });
}

module.exports = { parseArgs, isExternalImageUrl, fileNameFromUrl, contentTypeFor, mapLimit, run, RESCUE_FIELDS };
