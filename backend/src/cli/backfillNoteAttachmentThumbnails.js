#!/usr/bin/env node
'use strict';

/**
 * NOTE-THUMBS-001: create deterministic thumbnails for existing note images.
 *
 * Usage:
 *   node backend/src/cli/backfillNoteAttachmentThumbnails.js --company-id=<uuid>
 *   node backend/src/cli/backfillNoteAttachmentThumbnails.js --company-id=<uuid> --apply
 *
 * Dry-run is the default. Apply mode checks the thumbnail key before doing any
 * download or upload, so a repeated run skips completed attachments.
 */

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function parseArgs(argv) {
    const args = { companyId: null, apply: false, dryRun: false };
    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        if (arg === '--apply') args.apply = true;
        else if (arg === '--dry-run') args.dryRun = true;
        else if (arg === '--company-id') {
            args.companyId = argv[index + 1] || null;
            index += 1;
        } else if (arg.startsWith('--company-id=')) {
            args.companyId = arg.slice('--company-id='.length);
        } else {
            throw new Error(`Unknown argument: ${arg}`);
        }
    }
    if (args.apply && args.dryRun) {
        throw new Error('--apply and --dry-run are mutually exclusive');
    }
    if (!UUID_SHAPE.test(args.companyId || '')) {
        throw new Error('--company-id=<uuid> is required');
    }
    args.dryRun = !args.apply;
    return args;
}

async function backfillThumbnails(args, dependencies = {}) {
    const db = dependencies.db || require('../db/connection');
    const storageService = dependencies.storageService || require('../services/storageService');
    const noteAttachmentsService = dependencies.noteAttachmentsService
        || require('../services/noteAttachmentsService');
    const logger = dependencies.logger || console;

    const { rows } = await db.query(
        `SELECT id, storage_key, content_type
         FROM note_attachments
         WHERE company_id = $1
           AND content_type LIKE 'image/%'
         ORDER BY id`,
        [args.companyId]
    );

    const summary = {
        mode: args.dryRun ? 'dry-run' : 'apply',
        company_id: args.companyId,
        found: rows.length,
        existing: 0,
        would_create: 0,
        created: 0,
        failed: 0,
    };

    for (const row of rows) {
        const thumbnailKey = noteAttachmentsService.generateThumbnailStorageKey(row.storage_key);
        try {
            if (await storageService.fileExists(thumbnailKey)) {
                summary.existing += 1;
                continue;
            }
            if (args.dryRun) {
                summary.would_create += 1;
                continue;
            }

            const original = await storageService.downloadFile(row.storage_key);
            const thumbnail = await noteAttachmentsService.createThumbnailBuffer(original);
            await storageService.uploadFile(thumbnail, 'image/jpeg', thumbnailKey);
            summary.created += 1;
        } catch (err) {
            summary.failed += 1;
            logger.error(`[NoteAttachmentThumbBackfill] attachment ${row.id} failed: ${err.message}`);
        }
    }

    return summary;
}

async function run(argv = process.argv.slice(2), dependencies = {}) {
    const args = parseArgs(argv);
    const summary = await backfillThumbnails(args, dependencies);
    (dependencies.logger || console).log(JSON.stringify(summary, null, 2));
    return summary;
}

if (require.main === module) {
    require('dotenv').config();
    const db = require('../db/connection');
    run(process.argv.slice(2), { db }).then(summary => {
        if (summary.failed > 0) process.exitCode = 1;
    }).catch(err => {
        console.error(`[NoteAttachmentThumbBackfill] fatal: ${err.message}`);
        process.exitCode = 1;
    }).finally(async () => {
        if (db.pool?.end) await db.pool.end();
    });
}

module.exports = { parseArgs, backfillThumbnails, run };
