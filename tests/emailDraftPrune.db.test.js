'use strict';

const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const db = require('../backend/src/db/connection');
const emailQueries = require('../backend/src/db/emailQueries');
const timelinesQueries = require('../backend/src/db/timelinesQueries');

const COMPANY_A = randomUUID();
const COMPANY_B = randomUUID();
const TAG = `email-draft-prune-${Date.now()}-${process.pid}`;
const SHARED_PROVIDER_ID = `${TAG}-shared-provider-id`;
const FOREIGN_PROVIDER_ID = `${TAG}-foreign-only`;

let setupStarted = false;
let mailboxAId;
let mailboxBId;
let threadAId;
let threadBId;
let mixedThreadId;
let allArtifactThreadId;
let contactAId;
let artifactTimelineId;

const REAL_AT = new Date('2026-08-14T10:00:00.000Z');
const DRAFT_AT = new Date('2026-08-14T10:05:00.000Z');
const ONLY_AT = new Date('2026-08-14T11:00:00.000Z');

async function ensureMailbox(companyId, suffix) {
    const existing = await db.query(
        'SELECT id FROM email_mailboxes WHERE company_id = $1 ORDER BY id LIMIT 1',
        [companyId]
    );
    if (existing.rows[0]) return { id: existing.rows[0].id, created: false };
    const inserted = await db.query(
        `INSERT INTO email_mailboxes (company_id, provider, email_address, status)
         VALUES ($1, 'gmail', $2, 'connected') RETURNING id`,
        [companyId, `${TAG}-${suffix}@example.com`]
    );
    return { id: inserted.rows[0].id, created: true };
}

async function seedThread(companyId, mailboxId, suffix) {
    const result = await db.query(
        `INSERT INTO email_threads
            (company_id, mailbox_id, provider_thread_id, subject, last_message_at)
         VALUES ($1, $2, $3, 'Draft prune fixture', now()) RETURNING id`,
        [companyId, mailboxId, `${TAG}-${suffix}`]
    );
    return result.rows[0].id;
}

async function seedMessage({
    companyId,
    mailboxId,
    threadId,
    providerMessageId,
    direction = 'outbound',
    contactId = null,
    timelineId = null,
    gmailInternalAt = new Date(),
    snippet = `${providerMessageId} snippet`,
    fromName = null,
    fromEmail = null,
}) {
    await db.query(
        `INSERT INTO email_messages
            (company_id, mailbox_id, thread_id, provider_message_id, direction,
             from_name, from_email, to_recipients_json, contact_id, timeline_id,
             on_timeline, body_text, snippet, gmail_internal_at, is_draft_artifact)
         VALUES ($1, $2, $3, $4, $5, $6, $7, '["customer@example.com"]'::jsonb,
                 $8, $9, $10, $11, $12, $13, false)`,
        [
            companyId,
            mailboxId,
            threadId,
            providerMessageId,
            direction,
            fromName,
            fromEmail || (direction === 'outbound' ? 'dispatch@example.com' : 'customer@example.com'),
            contactId,
            timelineId,
            contactId != null || timelineId != null,
            `${providerMessageId} body`,
            snippet,
            gmailInternalAt,
        ]
    );
}

beforeAll(async () => {
    const migration = fs.readFileSync(
        path.join(__dirname, '../backend/db/migrations/260_email_draft_artifact_flag.sql'),
        'utf8'
    );
    await db.query(migration);
    setupStarted = true;
    await db.query(
        `INSERT INTO companies (id, name, slug)
         VALUES
            ($1, 'Email Draft Prune Tenant A', $3),
            ($2, 'Email Draft Prune Tenant B', $4)`,
        [COMPANY_A, COMPANY_B, `${TAG}-tenant-a`, `${TAG}-tenant-b`]
    );
    const mailboxA = await ensureMailbox(COMPANY_A, 'a');
    mailboxAId = mailboxA.id;
    const mailboxB = await ensureMailbox(COMPANY_B, 'b');
    mailboxBId = mailboxB.id;
    threadAId = await seedThread(COMPANY_A, mailboxAId, 'thread-a');
    threadBId = await seedThread(COMPANY_B, mailboxBId, 'thread-b');
    const mixedThread = await db.query(
        `INSERT INTO email_threads
            (company_id, mailbox_id, provider_thread_id, subject,
             last_message_at, last_message_direction, last_message_preview,
             last_message_from, unread_count)
         VALUES ($1, $2, $3, 'Mixed aggregate fixture', $4, 'outbound',
                 'unfinished draft', 'Draft Author', 7)
         RETURNING id`,
        [COMPANY_A, mailboxAId, `${TAG}-mixed-thread`, DRAFT_AT]
    );
    mixedThreadId = mixedThread.rows[0].id;
    const allArtifactThread = await db.query(
        `INSERT INTO email_threads
            (company_id, mailbox_id, provider_thread_id, subject,
             last_message_at, last_message_direction, last_message_preview,
             last_message_from, unread_count)
         VALUES ($1, $2, $3, 'All artifact aggregate fixture', $4, 'outbound',
                 'only unfinished draft', 'Only Draft Author', 3)
         RETURNING id`,
        [COMPANY_A, mailboxAId, `${TAG}-all-artifact-thread`, ONLY_AT]
    );
    allArtifactThreadId = allArtifactThread.rows[0].id;
    const contact = await db.query(
        `INSERT INTO contacts (company_id, full_name)
         VALUES ($1, 'Email Draft Prune Contact') RETURNING id`,
        [COMPANY_A]
    );
    contactAId = contact.rows[0].id;
    const artifactTimeline = await db.query(
        `INSERT INTO timelines
            (company_id, yelp_conversation_id, display_name, external_source)
         VALUES ($1, $2, 'Draft-only timeline', 'yelp') RETURNING id`,
        [COMPANY_A, `${TAG}-draft-conversation`]
    );
    artifactTimelineId = artifactTimeline.rows[0].id;

    await seedMessage({
        companyId: COMPANY_A,
        mailboxId: mailboxAId,
        threadId: threadAId,
        providerMessageId: SHARED_PROVIDER_ID,
        contactId: contactAId,
    });
    await seedMessage({
        companyId: COMPANY_A,
        mailboxId: mailboxAId,
        threadId: threadAId,
        providerMessageId: `${TAG}-sent-a`,
        contactId: contactAId,
    });
    await seedMessage({
        companyId: COMPANY_A,
        mailboxId: mailboxAId,
        threadId: threadAId,
        providerMessageId: `${TAG}-inbound-a`,
        direction: 'inbound',
    });
    await seedMessage({
        companyId: COMPANY_A,
        mailboxId: mailboxAId,
        threadId: threadAId,
        providerMessageId: `${TAG}-pulse-artifact`,
        timelineId: artifactTimelineId,
    });
    await seedMessage({
        companyId: COMPANY_B,
        mailboxId: mailboxBId,
        threadId: threadBId,
        providerMessageId: SHARED_PROVIDER_ID,
    });
    await seedMessage({
        companyId: COMPANY_B,
        mailboxId: mailboxBId,
        threadId: threadBId,
        providerMessageId: FOREIGN_PROVIDER_ID,
    });
    await seedMessage({
        companyId: COMPANY_A,
        mailboxId: mailboxAId,
        threadId: mixedThreadId,
        providerMessageId: `${TAG}-mixed-real`,
        direction: 'inbound',
        gmailInternalAt: REAL_AT,
        snippet: 'complete real message',
        fromName: 'Real Customer',
    });
    await seedMessage({
        companyId: COMPANY_A,
        mailboxId: mailboxAId,
        threadId: mixedThreadId,
        providerMessageId: `${TAG}-mixed-draft`,
        gmailInternalAt: DRAFT_AT,
        snippet: 'unfinished draft',
        fromName: 'Draft Author',
    });
    await seedMessage({
        companyId: COMPANY_A,
        mailboxId: mailboxAId,
        threadId: allArtifactThreadId,
        providerMessageId: `${TAG}-only-draft`,
        gmailInternalAt: ONLY_AT,
        snippet: 'only unfinished draft',
        fromName: 'Only Draft Author',
    });
});

afterAll(async () => {
    if (setupStarted) {
        try {
            await db.query('DELETE FROM email_messages WHERE provider_message_id LIKE $1', [`${TAG}%`]);
            await db.query('DELETE FROM email_threads WHERE provider_thread_id LIKE $1', [`${TAG}%`]);
            await db.query('DELETE FROM timelines WHERE company_id = ANY($1::uuid[])', [[COMPANY_A, COMPANY_B]]);
            await db.query('DELETE FROM contacts WHERE company_id = ANY($1::uuid[])', [[COMPANY_A, COMPANY_B]]);
            await db.query('DELETE FROM email_mailboxes WHERE company_id = ANY($1::uuid[])', [[COMPANY_A, COMPANY_B]]);
            await db.query('DELETE FROM companies WHERE id = ANY($1::uuid[])', [[COMPANY_A, COMPANY_B]]);
        } catch (error) {
            console.warn('[emailDraftPrune.db] cleanup failed:', error.message);
        }
    }
    try { await db.pool.end(); } catch (_) { /* ignore */ }
});

describe('email draft artifact queries — real PostgreSQL', () => {
    test('T-own/T-foreign/T-blast: apply marks only the exact company+mailbox row and is idempotent', async () => {
        const beforeB = await db.query(
            `SELECT to_jsonb(message) AS snapshot
             FROM email_messages message
             WHERE company_id = $1 AND provider_message_id = $2`,
            [COMPANY_B, SHARED_PROVIDER_ID]
        );
        const foreignBefore = await db.query(
            `SELECT to_jsonb(message) AS snapshot
             FROM email_messages message
             WHERE company_id = $1 AND provider_message_id = $2`,
            [COMPANY_B, FOREIGN_PROVIDER_ID]
        );

        await expect(emailQueries.markDraftArtifact(
            COMPANY_A,
            mailboxAId,
            FOREIGN_PROVIDER_ID
        )).resolves.toBeNull();
        await expect(emailQueries.markDraftArtifact(
            COMPANY_A,
            mailboxAId,
            SHARED_PROVIDER_ID
        )).resolves.toMatchObject({
            provider_message_id: SHARED_PROVIDER_ID,
            is_draft_artifact: true,
        });
        await expect(emailQueries.markDraftArtifact(
            COMPANY_A,
            mailboxAId,
            SHARED_PROVIDER_ID
        )).resolves.toBeNull();

        const afterB = await db.query(
            `SELECT to_jsonb(message) AS snapshot
             FROM email_messages message
             WHERE company_id = $1 AND provider_message_id = $2`,
            [COMPANY_B, SHARED_PROVIDER_ID]
        );
        const foreignAfter = await db.query(
            `SELECT to_jsonb(message) AS snapshot
             FROM email_messages message
             WHERE company_id = $1 AND provider_message_id = $2`,
            [COMPANY_B, FOREIGN_PROVIDER_ID]
        );
        expect(afterB.rows[0].snapshot).toStrictEqual(beforeB.rows[0].snapshot);
        expect(foreignAfter.rows[0].snapshot).toStrictEqual(foreignBefore.rows[0].snapshot);
    });

    test('candidate scan and timeline/message lists exclude marked rows within the tenant', async () => {
        await emailQueries.markDraftArtifact(COMPANY_A, mailboxAId, SHARED_PROVIDER_ID);
        await emailQueries.markDraftArtifact(COMPANY_A, mailboxAId, `${TAG}-pulse-artifact`);

        const foreignCandidates = await emailQueries.listOutboundDraftArtifactCandidates(
            COMPANY_B,
            mailboxBId,
            { limit: 20 }
        );
        expect(foreignCandidates.map(row => row.provider_message_id))
            .toEqual(expect.arrayContaining([SHARED_PROVIDER_ID, FOREIGN_PROVIDER_ID]));

        const markedCandidate = await db.query(
            `SELECT provider_message_id
             FROM email_messages
             WHERE company_id = $1 AND mailbox_id = $2
               AND direction = 'outbound' AND is_draft_artifact = false
               AND provider_message_id = $3`,
            [COMPANY_A, mailboxAId, SHARED_PROVIDER_ID]
        );
        expect(markedCandidate.rows).toHaveLength(0);

        const candidateRows = await emailQueries.listOutboundDraftArtifactCandidates(
            COMPANY_A,
            mailboxAId,
            { limit: 100 }
        );
        const sentCandidate = candidateRows.find(
            row => row.provider_message_id === `${TAG}-sent-a`
        );
        expect(sentCandidate.body_text_length).toBe(`${TAG}-sent-a body`.length);
        expect(sentCandidate).not.toHaveProperty('body_text');

        const threadMessages = await emailQueries.getMessagesByThread(threadAId, COMPANY_A);
        expect(threadMessages.map(row => row.provider_message_id)).not.toContain(SHARED_PROVIDER_ID);
        expect(threadMessages.map(row => row.provider_message_id)).toContain(`${TAG}-sent-a`);

        const timelineMessages = await emailQueries.getTimelineEmailByContact(
            COMPANY_A,
            contactAId
        );
        expect(timelineMessages.map(row => row.id)).toHaveLength(1);
        expect(timelineMessages[0].body_text).toBe(`${TAG}-sent-a body`);

        const pulsePage = await timelinesQueries.getUnifiedTimelinePage({
            companyId: COMPANY_A,
            limit: 200,
            offset: 0,
        });
        expect(pulsePage.find(row => String(row.tl_id) === String(artifactTimelineId)))
            .toBeUndefined();
    });

    test('mark/unmark refreshes all four cached last-message fields and preserves unread_count', async () => {
        const selectAggregate = async () => {
            const result = await db.query(
                `SELECT last_message_at, last_message_direction, last_message_preview,
                        last_message_from, unread_count
                 FROM email_threads
                 WHERE id = $1 AND company_id = $2 AND mailbox_id = $3`,
                [mixedThreadId, COMPANY_A, mailboxAId]
            );
            return result.rows[0];
        };
        const initial = await selectAggregate();

        await expect(emailQueries.markDraftArtifact(
            COMPANY_A,
            mailboxAId,
            `${TAG}-mixed-draft`
        )).resolves.toMatchObject({ is_draft_artifact: true });
        await expect(selectAggregate()).resolves.toEqual({
            last_message_at: REAL_AT,
            last_message_direction: 'inbound',
            last_message_preview: 'complete real message',
            last_message_from: 'Real Customer',
            unread_count: initial.unread_count,
        });

        await expect(emailQueries.unmarkDraftArtifact(
            COMPANY_A,
            mailboxAId,
            `${TAG}-mixed-draft`
        )).resolves.toMatchObject({ is_draft_artifact: false });
        await expect(selectAggregate()).resolves.toEqual(initial);
    });

    test('mark leaves the thread cache unchanged when no visible message remains', async () => {
        const before = await db.query(
            `SELECT last_message_at, last_message_direction, last_message_preview,
                    last_message_from, unread_count
             FROM email_threads
             WHERE id = $1 AND company_id = $2 AND mailbox_id = $3`,
            [allArtifactThreadId, COMPANY_A, mailboxAId]
        );

        await expect(emailQueries.markDraftArtifact(
            COMPANY_A,
            mailboxAId,
            `${TAG}-only-draft`
        )).resolves.toMatchObject({ is_draft_artifact: true });

        const after = await db.query(
            `SELECT last_message_at, last_message_direction, last_message_preview,
                    last_message_from, unread_count
             FROM email_threads
             WHERE id = $1 AND company_id = $2 AND mailbox_id = $3`,
            [allArtifactThreadId, COMPANY_A, mailboxAId]
        );
        expect(after.rows[0]).toStrictEqual(before.rows[0]);
    });
});
