#!/usr/bin/env node
'use strict';

/**
 * YELP-CONVO-CONTEXT-002 — one-time historical agent-send backfill.
 *
 * OWNER-RUN ONLY. This is not a migration and is never invoked by ingest, poll,
 * or a worker. The backend/scripts directory is NOT in the Docker image, so the
 * production procedure is:
 *   1. scp backend/scripts/yelp_agent_sends_backfill.js to the application host.
 *   2. docker cp the script into the app container (for example, /tmp/).
 *   3. Review the default dry-run from inside the container:
 *        DATABASE_URL=... node /tmp/yelp_agent_sends_backfill.js [--company <uuid>]
 *   4. After owner confirmation, apply the reviewed mapping:
 *        DATABASE_URL=... node /tmp/yelp_agent_sends_backfill.js --apply --yes \
 *          [--company <uuid>] [--snapshot-dir <path>]
 *
 * A JSON snapshot of every candidate row is written before any plan is printed
 * or any row is updated. Apply is UPDATE-only, company-scoped, contactless, and
 * transaction-wrapped. Threads attributed to more than one timeline are skipped.
 */

const fs = require('fs');
const path = require('path');
const db = require('../src/db/connection');
const yelpConvoHistory = require('../src/services/yelpConvoHistory');

const DEFAULT_COMPANY_ID = '00000000-0000-0000-0000-000000000001';

function writeSnapshot(snapshotDir, payload) {
    fs.mkdirSync(snapshotDir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const file = path.join(snapshotDir, `yelp-agent-sends-backfill-${ts}.json`);
    fs.writeFileSync(file, JSON.stringify(payload, null, 2), 'utf8');
    return file;
}

function logValue(value) {
    if (value == null) return '';
    if (value instanceof Date) return value.toISOString();
    return String(value);
}

function warn(logger, message) {
    if (typeof logger.warn === 'function') logger.warn(message);
    else logger.log(message);
}

/**
 * @param {object} [opts]
 * @param {string} [opts.companyId] default: DEFAULT_COMPANY_ID
 * @param {boolean} [opts.dryRun] default: true
 * @param {string} [opts.snapshotDir]
 * @param {object} [opts.logger] default: console
 * @returns {Promise<{companyId:string, dryRun:boolean, snapshotFile:(string|null),
 *   threads:Array, conflictThreadIds:Array, linked:number, residueOutbound:number}>}
 */
async function runBackfill(opts = {}) {
    const companyId = opts.companyId || DEFAULT_COMPANY_ID;
    const dryRun = opts.dryRun !== false;
    const logger = opts.logger || console;
    const snapshotDir = opts.snapshotDir
        || path.join(__dirname, '.yelp-agent-sends-backfill-snapshots');

    const { rows: anchors } = await db.query(
        `SELECT DISTINCT em.thread_id, em.timeline_id,
                tl.yelp_conversation_id, tl.display_name
         FROM email_messages em
         JOIN timelines tl
           ON tl.id = em.timeline_id
          AND tl.company_id = $1
         WHERE em.company_id = $1
           AND em.on_timeline = true
           AND em.contact_id IS NULL
           AND tl.yelp_conversation_id IS NOT NULL`,
        [companyId]
    );

    const threadIds = [...new Map(
        anchors.map(anchor => [String(anchor.thread_id), anchor.thread_id])
    ).values()];

    let candidates = [];
    if (threadIds.length > 0) {
        const result = await db.query(
            `SELECT em.id, em.provider_message_id, em.thread_id, em.subject,
                    em.gmail_internal_at, em.body_text, em.snippet
             FROM email_messages em
             WHERE em.company_id = $1
               AND em.thread_id = ANY($2::bigint[])
               AND em.direction = 'outbound'
               AND em.timeline_id IS NULL
               AND em.contact_id IS NULL
               AND em.on_timeline = false
               AND em.message_id_header IS NOT NULL
               AND em.message_id_header <> ''
             ORDER BY em.thread_id, em.gmail_internal_at NULLS LAST, em.id`,
            [companyId, threadIds]
        );
        candidates = result.rows;
    }

    if (candidates.length === 0) {
        logger.log('[YelpAgentSendsBackfill] no candidates — nothing to do (idempotent no-op).');
        return {
            companyId,
            dryRun,
            snapshotFile: null,
            threads: [],
            conflictThreadIds: [],
            linked: 0,
            residueOutbound: 0,
        };
    }

    let snapshotFile;
    try {
        snapshotFile = writeSnapshot(snapshotDir, {
            feature: 'YELP-CONVO-CONTEXT-002',
            companyId,
            takenAt: new Date().toISOString(),
            email_messages: candidates,
        });
        logger.log(`[YelpAgentSendsBackfill] snapshot written: ${snapshotFile}`);
    } catch (error) {
        throw new Error(
            `[YelpAgentSendsBackfill] ABORT — could not write snapshot (${error.message})`
        );
    }

    const anchorsByThread = new Map();
    for (const anchor of anchors) {
        const threadKey = String(anchor.thread_id);
        if (!anchorsByThread.has(threadKey)) anchorsByThread.set(threadKey, new Map());
        anchorsByThread.get(threadKey).set(String(anchor.timeline_id), anchor);
    }

    const candidatesByThread = new Map();
    for (const candidate of candidates) {
        const threadKey = String(candidate.thread_id);
        if (!candidatesByThread.has(threadKey)) candidatesByThread.set(threadKey, []);
        candidatesByThread.get(threadKey).push(candidate);
    }

    const threads = [];
    const conflictThreadIds = [];
    let residueOutbound = 0;
    for (const [threadKey, messages] of candidatesByThread.entries()) {
        const mappings = anchorsByThread.get(threadKey) || new Map();
        if (mappings.size !== 1) {
            const threadId = messages[0].thread_id;
            conflictThreadIds.push(threadId);
            residueOutbound += messages.length;
            warn(
                logger,
                `[YelpAgentSendsBackfill] conflict thread=${logValue(threadId)} `
                    + `timelines=${[...mappings.keys()].join(',')} — skipped.`
            );
            continue;
        }

        const anchor = mappings.values().next().value;
        threads.push({
            threadId: anchor.thread_id,
            timelineId: anchor.timeline_id,
            convId: anchor.yelp_conversation_id,
            displayName: anchor.display_name,
            messages: messages.map(message => ({
                id: message.id,
                provider_message_id: message.provider_message_id,
                gmail_internal_at: message.gmail_internal_at,
                subject: message.subject,
                preview: yelpConvoHistory.sanitizeEntry(
                    message.body_text,
                    { snippet: message.snippet },
                    80
                ),
            })),
        });
    }

    for (const thread of threads) {
        logger.log(
            `[YelpAgentSendsBackfill] conv=${logValue(thread.convId)} `
                + `timeline=${logValue(thread.timelineId)} name=${logValue(thread.displayName)}`
        );
        for (const message of thread.messages) {
            logger.log(
                `[YelpAgentSendsBackfill] id=${logValue(message.id)} `
                    + `pmid=${logValue(message.provider_message_id)} `
                    + `at=${logValue(message.gmail_internal_at)} `
                    + `subj=${logValue(message.subject)} preview=${message.preview}`
            );
        }
    }

    if (dryRun || threads.length === 0) {
        logger.log(
            `[YelpAgentSendsBackfill] ${dryRun ? 'DRY-RUN' : 'APPLY'} — `
                + `${threads.reduce((sum, thread) => sum + thread.messages.length, 0)} `
                + `candidate(s) planned; ${residueOutbound} conflict residue left untouched.`
        );
        return {
            companyId,
            dryRun,
            snapshotFile,
            threads,
            conflictThreadIds,
            linked: 0,
            residueOutbound,
        };
    }

    const client = await db.pool.connect();
    let linked = 0;
    try {
        await client.query('BEGIN');
        for (const thread of threads) {
            const result = await client.query(
                `UPDATE email_messages
                 SET timeline_id = $3, on_timeline = true, updated_at = now()
                 WHERE company_id = $1
                   AND id = ANY($2::bigint[])
                   AND timeline_id IS NULL
                   AND contact_id IS NULL
                 RETURNING id`,
                [companyId, thread.messages.map(message => message.id), thread.timelineId]
            );
            linked += result.rowCount;
        }
        await client.query('COMMIT');
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
    }

    logger.log(
        `[YelpAgentSendsBackfill] APPLIED — linked ${linked} message(s); `
            + `${residueOutbound} conflict residue left untouched.`
    );
    return {
        companyId,
        dryRun: false,
        snapshotFile,
        threads,
        conflictThreadIds,
        linked,
        residueOutbound,
    };
}

function parseCliArgs(argv = []) {
    const has = flag => argv.includes(flag);
    const value = (flag, fallback = null) => {
        const index = argv.indexOf(flag);
        return index > -1 ? argv[index + 1] : fallback;
    };
    const apply = has('--apply');
    return {
        apply,
        confirmed: has('--yes'),
        dryRun: !apply || has('--dry-run'),
        companyId: value('--company', DEFAULT_COMPANY_ID),
        snapshotDir: value('--snapshot-dir'),
    };
}

if (require.main === module) {
    const args = parseCliArgs(process.argv.slice(2));
    if (args.apply && !args.confirmed) {
        console.error('Refusing to APPLY without --yes (owner confirmation). Re-run with --apply --yes.');
        process.exit(1);
    }

    runBackfill({
        companyId: args.companyId,
        dryRun: args.dryRun,
        snapshotDir: args.snapshotDir,
    })
        .then((summary) => {
            console.log('[YelpAgentSendsBackfill] summary:', JSON.stringify(summary, null, 2));
            return db.pool.end();
        })
        .then(() => process.exit(0))
        .catch((error) => {
            console.error(error.message || error);
            db.pool.end().finally(() => process.exit(1));
        });
}

module.exports = { runBackfill, parseCliArgs };
