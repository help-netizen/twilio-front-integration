'use strict';

/**
 * YELP-CONVO-CONTEXT-002 — REAL-POSTGRES shared history/backfill dataset.
 * T2 owns this seed and the history-SQL describe (TC-A9-01/02); T7 appends the
 * backfill describe without changing either section. The DB seam is not mocked.
 *
 * SELF-SKIPS when no database with migration 165 is reachable. Every seeded row
 * is tagged and removed in afterAll, including both tenants' mail/thread rows.
 *
 * Run:
 *   node <repo>/node_modules/jest/bin/jest.js tests/yelpSendsBackfill.db.test.js \
 *     --rootDir . --testPathIgnorePatterns "/node_modules/" --forceExit
 */

const { randomUUID } = require('crypto');
const db = require('../backend/src/db/connection');
const emailQueries = require('../backend/src/db/emailQueries');
const { DEFAULT_COMPANY_ID } = require('./yelpFixtures');

const TAG = `YSB-${Date.now()}-${process.pid}`;
const COMPANY_B_ID = randomUUID();
const CONV_A = `CONVBF01-${TAG}`;
const CONV_B = `CONVBF02-${TAG}`;
const CONV_FOREIGN = `CONVBF01-B-${TAG}`;

const TIMES = {
    I1: '2026-07-11T10:00:00.000Z',
    I3: '2026-07-11T11:00:00.000Z',
    O1: '2026-07-11T12:00:00.000Z',
    O3: '2026-07-11T13:00:00.000Z',
    I2: '2026-07-11T13:30:00.000Z',
    O2: '2026-07-11T14:00:00.000Z',
    M1: '2026-07-11T15:00:00.000Z',
    D1: '2026-07-11T16:00:00.000Z',
    N1: '2026-07-11T17:00:00.000Z',
};

const PMIDS = Object.fromEntries(
    ['I1', 'I2', 'I3', 'O1', 'O2', 'O3', 'D1', 'M1', 'N1', 'NULL_TS']
        .map(key => [key, `${TAG}-${key}`])
);
const FOREIGN_PMIDS = Object.fromEntries(
    ['I1', 'I2', 'O1', 'O2', 'D1', 'M1', 'N1', 'NULL_TS']
        .map(key => [key, `${TAG}-B-${key}`])
);

let dbReady = false;
let companyBCreated = false;
let mailboxAId = null;
let mailboxBId = null;
let threadT1Id = null;
let threadT2Id = null;
let foreignThreadId = null;
let timelineAId = null;
let timelineBId = null;
let foreignTimelineId = null;

const createdMailboxIds = { [DEFAULT_COMPANY_ID]: [], [COMPANY_B_ID]: [] };
const seededThreadIds = { [DEFAULT_COMPANY_ID]: [], [COMPANY_B_ID]: [] };
const seededTimelineIds = { [DEFAULT_COMPANY_ID]: [], [COMPANY_B_ID]: [] };
const seededMessageIds = { [DEFAULT_COMPANY_ID]: [], [COMPANY_B_ID]: [] };

async function ensureMailbox(companyId, emailPrefix) {
    const existing = await db.query(
        `SELECT id
         FROM email_mailboxes
         WHERE company_id = $1
         ORDER BY id
         LIMIT 1`,
        [companyId]
    );
    if (existing.rows[0]) return existing.rows[0].id;

    const inserted = await db.query(
        `INSERT INTO email_mailboxes (company_id, provider, email_address, status)
         VALUES ($1, 'gmail', $2, 'connected')
         RETURNING id`,
        [companyId, `${emailPrefix}-${TAG.toLowerCase()}@example.com`]
    );
    createdMailboxIds[companyId].push(inserted.rows[0].id);
    return inserted.rows[0].id;
}

async function seedTimeline(companyId, conversationId, displayName) {
    const result = await db.query(
        `INSERT INTO timelines
            (company_id, yelp_conversation_id, display_name, external_source)
         VALUES ($1, $2, $3, 'yelp')
         RETURNING id`,
        [companyId, conversationId, displayName]
    );
    seededTimelineIds[companyId].push(result.rows[0].id);
    return result.rows[0].id;
}

async function seedThread(companyId, mailboxId, providerThreadId) {
    const result = await db.query(
        `INSERT INTO email_threads (company_id, mailbox_id, provider_thread_id, subject)
         VALUES ($1, $2, $3, 'Yelp conversation history fixture')
         RETURNING id`,
        [companyId, mailboxId, providerThreadId]
    );
    seededThreadIds[companyId].push(result.rows[0].id);
    return result.rows[0].id;
}

async function seedMessage({
    companyId,
    mailboxId,
    threadId,
    providerThreadId,
    pmid,
    direction,
    messageIdHeader,
    timelineId = null,
    onTimeline = false,
    at,
    subject,
    bodyText,
    snippet,
    bodyHtml,
    fromEmail,
    fromName,
}) {
    const result = await db.query(
        `INSERT INTO email_messages
            (company_id, mailbox_id, thread_id, provider_message_id,
             provider_thread_id, message_id_header, direction, contact_id,
             timeline_id, on_timeline, from_email, from_name, subject, snippet,
             body_text, body_html, gmail_internal_at)
         VALUES
            ($1, $2, $3, $4, $5, $6, $7, NULL, $8, $9, $10, $11, $12,
             $13, $14, $15, $16)
         RETURNING id`,
        [
            companyId, mailboxId, threadId, pmid, providerThreadId,
            messageIdHeader, direction, timelineId, onTimeline, fromEmail,
            fromName, subject, snippet, bodyText, bodyHtml, at,
        ]
    );
    seededMessageIds[companyId].push(result.rows[0].id);
}

function row({ key, direction, header, timelineId = null, onTimeline = false, at = TIMES[key] }) {
    const inbound = direction === 'inbound';
    return {
        pmid: PMIDS[key],
        direction,
        messageIdHeader: header,
        timelineId,
        onTimeline,
        at,
        subject: `${key} Yelp subject`,
        bodyText: `${key} body text`,
        snippet: `${key} snippet`,
        bodyHtml: `<p>${key} body html</p>`,
        fromEmail: inbound ? 'reply+fixture@messaging.yelp.com' : 'dispatch@example.com',
        fromName: inbound ? 'Kim L.' : 'Albusto Dispatch',
    };
}

async function seedCompanyARows() {
    const providerT1 = `${TAG}-thread-T1`;
    const providerT2 = `${TAG}-thread-T2`;
    const t1Rows = [
        row({ key: 'I1', direction: 'inbound', header: `<${TAG}-i1@x>`, timelineId: timelineAId, onTimeline: true }),
        row({ key: 'I2', direction: 'inbound', header: `<${TAG}-i2@x>`, timelineId: timelineAId, onTimeline: true }),
        row({ key: 'O1', direction: 'outbound', header: `<${TAG}-m1@x>` }),
        row({ key: 'O2', direction: 'outbound', header: `<${TAG}-m2@x>` }),
        row({ key: 'D1', direction: 'outbound', header: null }),
        row({ key: 'M1', direction: 'outbound', header: `<${TAG}-m3@x>` }),
        row({ key: 'N1', direction: 'inbound', header: `<${TAG}-notice@x>` }),
        row({
            key: 'NULL_TS', direction: 'outbound', header: `<${TAG}-null-ts@x>`,
            timelineId: timelineAId, onTimeline: true, at: null,
        }),
    ];
    for (const message of t1Rows) {
        await seedMessage({
            companyId: DEFAULT_COMPANY_ID,
            mailboxId: mailboxAId,
            threadId: threadT1Id,
            providerThreadId: providerT1,
            ...message,
        });
    }

    const t2Rows = [
        row({ key: 'I3', direction: 'inbound', header: `<${TAG}-i3@x>`, timelineId: timelineAId, onTimeline: true }),
        row({ key: 'O3', direction: 'outbound', header: `<${TAG}-m4@x>` }),
    ];
    for (const message of t2Rows) {
        await seedMessage({
            companyId: DEFAULT_COMPANY_ID,
            mailboxId: mailboxAId,
            threadId: threadT2Id,
            providerThreadId: providerT2,
            ...message,
        });
    }
}

async function seedForeignT1Clone() {
    const providerThreadId = `${TAG}-thread-B-T1`;
    const definitions = [
        { key: 'I1', direction: 'inbound', header: `<${TAG}-b-i1@x>`, linked: true },
        { key: 'I2', direction: 'inbound', header: `<${TAG}-b-i2@x>`, linked: true },
        { key: 'O1', direction: 'outbound', header: `<${TAG}-b-m1@x>` },
        { key: 'O2', direction: 'outbound', header: `<${TAG}-b-m2@x>` },
        { key: 'D1', direction: 'outbound', header: null },
        { key: 'M1', direction: 'outbound', header: `<${TAG}-b-m3@x>` },
        { key: 'N1', direction: 'inbound', header: `<${TAG}-b-notice@x>` },
        { key: 'NULL_TS', direction: 'outbound', header: `<${TAG}-b-null-ts@x>`, linked: true, at: null },
    ];
    for (const definition of definitions) {
        const message = row({
            key: definition.key,
            direction: definition.direction,
            header: definition.header,
            timelineId: definition.linked ? foreignTimelineId : null,
            onTimeline: Boolean(definition.linked),
            at: definition.at === null ? null : TIMES[definition.key],
        });
        await seedMessage({
            companyId: COMPANY_B_ID,
            mailboxId: mailboxBId,
            threadId: foreignThreadId,
            providerThreadId,
            ...message,
            pmid: FOREIGN_PMIDS[definition.key],
            subject: `B-${message.subject}`,
        });
    }
}

beforeAll(async () => {
    try {
        await db.query(
            `SELECT yelp_conversation_id
             FROM timelines
             WHERE company_id = $1
             LIMIT 1`,
            [DEFAULT_COMPANY_ID]
        );
        dbReady = true;
    } catch (error) {
        console.warn('\n[yelpSendsBackfill.db] SKIPPED-NEEDS-DB —', error.message, '\n');
        dbReady = false;
        return;
    }

    const companyB = await db.query(
        `INSERT INTO companies (id, name, slug)
         VALUES ($1, 'Yelp Backfill Test Company B', $2)
         RETURNING id`,
        [COMPANY_B_ID, `ysb-company-b-${TAG.toLowerCase()}`]
    );
    companyBCreated = Boolean(companyB.rows[0]);

    mailboxAId = await ensureMailbox(DEFAULT_COMPANY_ID, 'ysb-a');
    mailboxBId = await ensureMailbox(COMPANY_B_ID, 'ysb-b');
    timelineAId = await seedTimeline(DEFAULT_COMPANY_ID, CONV_A, 'Kim L.');
    timelineBId = await seedTimeline(DEFAULT_COMPANY_ID, CONV_B, 'Alex R.');
    foreignTimelineId = await seedTimeline(COMPANY_B_ID, CONV_FOREIGN, 'Foreign Kim');
    threadT1Id = await seedThread(DEFAULT_COMPANY_ID, mailboxAId, `${TAG}-thread-T1`);
    threadT2Id = await seedThread(DEFAULT_COMPANY_ID, mailboxAId, `${TAG}-thread-T2`);
    foreignThreadId = await seedThread(COMPANY_B_ID, mailboxBId, `${TAG}-thread-B-T1`);
    await seedCompanyARows();
    await seedForeignT1Clone();
});

async function cleanupCompany(companyId) {
    const messageIds = seededMessageIds[companyId];
    if (messageIds.length) {
        const deleted = await db.query(
            `DELETE FROM email_messages
             WHERE company_id = $1 AND id = ANY($2::bigint[])`,
            [companyId, messageIds]
        );
        if (deleted.rowCount !== messageIds.length) {
            throw new Error(`cleanup deleted ${deleted.rowCount}/${messageIds.length} email_messages for ${companyId}`);
        }
    }

    const threadIds = seededThreadIds[companyId];
    if (threadIds.length) {
        const deleted = await db.query(
            `DELETE FROM email_threads
             WHERE company_id = $1 AND id = ANY($2::bigint[])`,
            [companyId, threadIds]
        );
        if (deleted.rowCount !== threadIds.length) {
            throw new Error(`cleanup deleted ${deleted.rowCount}/${threadIds.length} email_threads for ${companyId}`);
        }
    }

    const timelineIds = seededTimelineIds[companyId];
    if (timelineIds.length) {
        const deleted = await db.query(
            `DELETE FROM timelines
             WHERE company_id = $1 AND id = ANY($2::bigint[])`,
            [companyId, timelineIds]
        );
        if (deleted.rowCount !== timelineIds.length) {
            throw new Error(`cleanup deleted ${deleted.rowCount}/${timelineIds.length} timelines for ${companyId}`);
        }
    }

    const mailboxIds = createdMailboxIds[companyId];
    if (mailboxIds.length) {
        const deleted = await db.query(
            `DELETE FROM email_mailboxes
             WHERE company_id = $1 AND id = ANY($2::uuid[])`,
            [companyId, mailboxIds]
        );
        if (deleted.rowCount !== mailboxIds.length) {
            throw new Error(`cleanup deleted ${deleted.rowCount}/${mailboxIds.length} email_mailboxes for ${companyId}`);
        }
    }
}

afterAll(async () => {
    let cleanupError = null;
    if (dbReady) {
        try {
            await cleanupCompany(DEFAULT_COMPANY_ID);
            await cleanupCompany(COMPANY_B_ID);
            if (companyBCreated) {
                const deleted = await db.query(
                    `DELETE FROM companies
                     WHERE id = $1`,
                    [COMPANY_B_ID]
                );
                if (deleted.rowCount !== 1) {
                    throw new Error(`cleanup deleted ${deleted.rowCount}/1 company-B rows`);
                }
            }
        } catch (error) {
            cleanupError = error;
            console.warn('[yelpSendsBackfill.db] cleanup failed:', error.message);
        }
    }
    try { await db.pool.end(); } catch (_) { /* ignore */ }
    if (cleanupError) throw cleanupError;
});

describe('history SQL · real PostgreSQL', () => {
    it('TC-A9-01 · branches, dedup, exclusion, order, limit, tenant scope, and threading fields', async () => {
        if (!dbReady) return console.warn('TC-A9-01 SKIPPED-NEEDS-DB');

        const rows = await emailQueries.listYelpConversationHistory(
            DEFAULT_COMPANY_ID,
            timelineAId,
            { excludeProviderMessageId: PMIDS.I2, limit: 30 }
        );

        expect(rows.map(item => item.provider_message_id)).toEqual([
            PMIDS.M1,
            PMIDS.O2,
            PMIDS.O3,
            PMIDS.O1,
            PMIDS.I3,
            PMIDS.I1,
            PMIDS.NULL_TS,
        ]);
        expect(Object.keys(rows[0])).toEqual([
            'id',
            'provider_message_id',
            'direction',
            'body_text',
            'snippet',
            'gmail_internal_at',
        ]);
        expect(rows.filter(item => item.provider_message_id === PMIDS.NULL_TS)).toHaveLength(1);
        expect(rows.at(-1).gmail_internal_at).toBeNull();
        expect(rows.some(item => item.provider_message_id === PMIDS.D1)).toBe(false);
        expect(rows.some(item => Object.values(FOREIGN_PMIDS).includes(item.provider_message_id))).toBe(false);

        const limited = await emailQueries.listYelpConversationHistory(
            DEFAULT_COMPANY_ID,
            timelineAId,
            { excludeProviderMessageId: PMIDS.I2, limit: 2 }
        );
        expect(limited.map(item => item.provider_message_id)).toEqual([PMIDS.M1, PMIDS.O2]);

        const withoutExclusion = await emailQueries.listYelpConversationHistory(
            DEFAULT_COMPANY_ID,
            timelineAId,
            { excludeProviderMessageId: null, limit: 30 }
        );
        expect(withoutExclusion.map(item => item.provider_message_id)).toEqual([
            PMIDS.M1,
            PMIDS.O2,
            PMIDS.I2,
            PMIDS.O3,
            PMIDS.O1,
            PMIDS.I3,
            PMIDS.I1,
            PMIDS.NULL_TS,
        ]);

        const defaults = await emailQueries.listYelpConversationHistory(DEFAULT_COMPANY_ID, timelineAId);
        expect(defaults.map(item => item.provider_message_id)).toEqual(
            withoutExclusion.map(item => item.provider_message_id)
        );

        const crossTenantTimeline = await emailQueries.listYelpConversationHistory(
            COMPANY_B_ID,
            timelineAId,
            { limit: 30 }
        );
        expect(crossTenantTimeline).toEqual([]);

        const threading = await emailQueries.getThreadingByProviderMessageId(
            PMIDS.I1,
            DEFAULT_COMPANY_ID
        );
        expect(threading).toEqual({
            message_id_header: `<${TAG}-i1@x>`,
            provider_thread_id: `${TAG}-thread-T1`,
            subject: 'I1 Yelp subject',
            body_text: 'I1 body text',
            body_html: '<p>I1 body html</p>',
            from_email: 'reply+fixture@messaging.yelp.com',
            from_name: 'Kim L.',
            gmail_internal_at: new Date(TIMES.I1),
            timeline_id: timelineAId,
        });
        await expect(emailQueries.getThreadingByProviderMessageId(`${TAG}-unknown`, DEFAULT_COMPANY_ID))
            .resolves.toBeNull();
        await expect(emailQueries.getThreadingByProviderMessageId(PMIDS.I1, COMPANY_B_ID))
            .resolves.toBeNull();
    });

    it('TC-A9-02 · unlinked inbound Yelp bounce notice never enters history', async () => {
        if (!dbReady) return console.warn('TC-A9-02 SKIPPED-NEEDS-DB');

        const rows = await emailQueries.listYelpConversationHistory(
            DEFAULT_COMPANY_ID,
            timelineAId,
            { excludeProviderMessageId: null, limit: 30 }
        );
        expect(rows.some(item => item.provider_message_id === PMIDS.N1)).toBe(false);
        expect(rows.filter(item => item.direction === 'inbound').map(item => item.provider_message_id))
            .toEqual([PMIDS.I2, PMIDS.I3, PMIDS.I1]);
    });
});
