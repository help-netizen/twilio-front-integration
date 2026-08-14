'use strict';

const fs = require('fs');
const path = require('path');
const db = require('../backend/src/db/connection');
const emailQueries = require('../backend/src/db/emailQueries');

const COMPANY_A = '00000000-0000-0000-0000-00000000ea01';
const COMPANY_B = '00000000-0000-0000-0000-00000000ea02';
const TAG = `email-occurred-${Date.now()}`;
const PARENT_AT = new Date('2026-08-14T15:39:00.000Z');
const SKEWED_PROVIDER_AT = new Date('2026-08-14T06:40:27.000Z');
const OBSERVED_AT = new Date('2026-08-14T15:40:33.000Z');
const MIGRATION = fs.readFileSync(
    path.join(__dirname, '../backend/db/migrations/261_email_message_occurred_at.sql'),
    'utf8'
);
const ROLLBACK = fs.readFileSync(
    path.join(__dirname, '../backend/db/migrations/rollback_261_email_message_occurred_at.sql'),
    'utf8'
);

let mailboxA;
let mailboxB;
let threadA;
let threadB;

async function insertMessage({
    companyId,
    mailboxId,
    threadId,
    providerMessageId,
    direction,
    gmailInternalAt,
    occurredAt,
    inReplyToHeader = null,
}) {
    return emailQueries.upsertMessage({
        company_id: companyId,
        mailbox_id: mailboxId,
        thread_id: threadId,
        provider_message_id: providerMessageId,
        provider_thread_id: `${TAG}-provider-thread`,
        message_id_header: `<${providerMessageId}@example.com>`,
        in_reply_to_header: inReplyToHeader,
        references_header: inReplyToHeader,
        direction,
        from_email: direction === 'outbound' ? 'dispatch@example.com' : 'customer@example.com',
        to_recipients_json: [],
        cc_recipients_json: [],
        subject: direction === 'outbound' ? 'Re: Need service' : 'Need service',
        snippet: providerMessageId,
        body_text: providerMessageId,
        has_attachments: false,
        gmail_internal_at: gmailInternalAt,
        occurred_at: occurredAt,
    });
}

beforeAll(async () => {
    await db.query(MIGRATION);

    await db.query('DELETE FROM companies WHERE id = ANY($1::uuid[])', [[COMPANY_A, COMPANY_B]]);
    await db.query(
        `INSERT INTO companies (id, name, slug)
         VALUES ($1, 'Occurred At Tenant A', $3), ($2, 'Occurred At Tenant B', $4)`,
        [COMPANY_A, COMPANY_B, `${TAG}-a`, `${TAG}-b`]
    );
    const mailboxes = await db.query(
        `INSERT INTO email_mailboxes (company_id, provider, email_address, status)
         VALUES ($1, 'gmail', $3, 'connected'), ($2, 'gmail', $4, 'connected')
         RETURNING id, company_id`,
        [COMPANY_A, COMPANY_B, `${TAG}-a@example.com`, `${TAG}-b@example.com`]
    );
    mailboxA = mailboxes.rows.find(row => row.company_id === COMPANY_A).id;
    mailboxB = mailboxes.rows.find(row => row.company_id === COMPANY_B).id;
    const threads = await db.query(
        `INSERT INTO email_threads
            (company_id, mailbox_id, provider_thread_id, unread_count, last_message_at)
         VALUES ($1, $3, $5, 7, '2000-01-01T00:00:00Z'),
                ($2, $4, $6, 9, '2000-01-01T00:00:00Z')
         RETURNING id, company_id`,
        [COMPANY_A, COMPANY_B, mailboxA, mailboxB, `${TAG}-thread-a`, `${TAG}-thread-b`]
    );
    threadA = threads.rows.find(row => row.company_id === COMPANY_A).id;
    threadB = threads.rows.find(row => row.company_id === COMPANY_B).id;

    await insertMessage({
        companyId: COMPANY_A,
        mailboxId: mailboxA,
        threadId: threadA,
        providerMessageId: `${TAG}-parent`,
        direction: 'inbound',
        gmailInternalAt: PARENT_AT,
        occurredAt: PARENT_AT,
    });
    await insertMessage({
        companyId: COMPANY_A,
        mailboxId: mailboxA,
        threadId: threadA,
        providerMessageId: `${TAG}-reply`,
        direction: 'outbound',
        gmailInternalAt: SKEWED_PROVIDER_AT,
        occurredAt: OBSERVED_AT,
        inReplyToHeader: `<${TAG}-parent@example.com>`,
    });
    await insertMessage({
        companyId: COMPANY_B,
        mailboxId: mailboxB,
        threadId: threadB,
        providerMessageId: `${TAG}-reply`,
        direction: 'outbound',
        gmailInternalAt: SKEWED_PROVIDER_AT,
        occurredAt: SKEWED_PROVIDER_AT,
    });
});

afterAll(async () => {
    try {
        await db.query('DELETE FROM companies WHERE id = ANY($1::uuid[])', [[COMPANY_A, COMPANY_B]]);
    } finally {
        try { await db.pool.end(); } catch (_) { /* ignore */ }
    }
});

describe('EMAIL-OCCURRED-AT-001 — real PostgreSQL', () => {
    test('migration backfills every existing-row branch exactly', async () => {
        const client = await db.getClient();
        try {
            await client.query('BEGIN');
            await client.query(
                `INSERT INTO email_messages
                    (company_id, mailbox_id, thread_id, provider_message_id, provider_thread_id,
                     direction, created_at, gmail_internal_at, occurred_at)
                 VALUES
                    ($1, $2, $3, $4 || '-inbound', $4, 'inbound',  '2025-01-01T15:00:00Z', '2025-01-01T12:00:00Z', '2000-01-01T00:00:00Z'),
                    ($1, $2, $3, $4 || '-agree',   $4, 'outbound', '2025-01-02T12:05:00Z', '2025-01-02T12:00:00Z', '2000-01-01T00:00:00Z'),
                    ($1, $2, $3, $4 || '-skew',    $4, 'outbound', '2025-01-03T21:00:00Z', '2025-01-03T12:00:00Z', '2000-01-01T00:00:00Z'),
                    ($1, $2, $3, $4 || '-history', $4, 'outbound', '2025-01-05T12:00:00Z', '2025-01-03T12:00:00Z', '2000-01-01T00:00:00Z'),
                    ($1, $2, $3, $4 || '-null',    $4, 'outbound', '2025-01-06T12:00:00Z', NULL, '2000-01-01T00:00:00Z')`,
                [COMPANY_A, mailboxA, threadA, `${TAG}-migration`]
            );

            await client.query(MIGRATION);
            const result = await client.query(
                `SELECT provider_message_id, occurred_at
                 FROM email_messages
                 WHERE company_id = $1 AND provider_message_id LIKE $2
                 ORDER BY provider_message_id`,
                [COMPANY_A, `${TAG}-migration-%`]
            );
            const bySuffix = Object.fromEntries(result.rows.map(row => [
                row.provider_message_id.slice(row.provider_message_id.lastIndexOf('-') + 1),
                row.occurred_at.toISOString(),
            ]));
            expect(bySuffix).toEqual({
                agree: '2025-01-02T12:00:00.000Z',
                history: '2025-01-03T12:00:00.000Z',
                inbound: '2025-01-01T12:00:00.000Z',
                null: '2025-01-06T12:00:00.000Z',
                skew: '2025-01-03T21:00:00.000Z',
            });
        } finally {
            await client.query('ROLLBACK');
            client.release();
        }
    });

    test('old-code inserts receive the permanent now() default', async () => {
        const client = await db.getClient();
        try {
            await client.query('BEGIN');
            const result = await client.query(
                `INSERT INTO email_messages
                    (company_id, mailbox_id, thread_id, provider_message_id, provider_thread_id,
                     direction, gmail_internal_at)
                 VALUES ($1, $2, $3, $4, $5, 'outbound', '2026-08-14T06:40:27Z')
                 RETURNING occurred_at::text AS occurred_bytes,
                           CURRENT_TIMESTAMP::text AS transaction_bytes`,
                [COMPANY_A, mailboxA, threadA, `${TAG}-old-code-default`, `${TAG}-provider-thread`]
            );
            const schema = await client.query(
                `SELECT is_nullable, column_default
                 FROM information_schema.columns
                 WHERE table_schema = 'public'
                   AND table_name = 'email_messages'
                   AND column_name = 'occurred_at'`
            );

            expect(result.rows[0].occurred_bytes).toBe(result.rows[0].transaction_bytes);
            expect(schema.rows[0].is_nullable).toBe('NO');
            expect(schema.rows[0].column_default).toMatch(/now\(\)/);
        } finally {
            await client.query('ROLLBACK');
            client.release();
        }
    });

    test('forward migration and rollback preserve byte-identical cache for draft-only thread', async () => {
        const client = await db.getClient();
        try {
            await client.query('BEGIN');
            await client.query(
                `UPDATE email_messages
                 SET is_draft_artifact = true
                 WHERE company_id = $1 AND thread_id = $2`,
                [COMPANY_A, threadA]
            );
            await client.query(
                `UPDATE email_threads
                 SET last_message_at = '2026-08-14T15:40:33.123456Z'
                 WHERE company_id = $1 AND id = $2`,
                [COMPANY_A, threadA]
            );
            const before = await client.query(
                `SELECT last_message_at::text AS bytes
                 FROM email_threads
                 WHERE company_id = $1 AND id = $2`,
                [COMPANY_A, threadA]
            );

            await client.query(MIGRATION);
            const afterForward = await client.query(
                `SELECT last_message_at::text AS bytes
                 FROM email_threads
                 WHERE company_id = $1 AND id = $2`,
                [COMPANY_A, threadA]
            );
            await client.query(ROLLBACK);
            const afterRollback = await client.query(
                `SELECT last_message_at::text AS bytes
                 FROM email_threads
                 WHERE company_id = $1 AND id = $2`,
                [COMPANY_A, threadA]
            );

            expect(afterForward.rows[0].bytes).toBe(before.rows[0].bytes);
            expect(afterRollback.rows[0].bytes).toBe(before.rows[0].bytes);
        } finally {
            await client.query('ROLLBACK');
            client.release();
        }
    });

    test('reply is strictly after its parent and thread reads are chronological by occurred_at', async () => {
        const rows = await emailQueries.getMessagesByThread(threadA, COMPANY_A);

        expect(rows.map(row => row.provider_message_id)).toEqual([
            `${TAG}-parent`,
            `${TAG}-reply`,
        ]);
        expect(rows[1].in_reply_to_header).toBe(`<${TAG}-parent@example.com>`);
        expect(new Date(rows[1].occurred_at).getTime())
            .toBeGreaterThan(new Date(rows[0].occurred_at).getTime());
    });

    test('thread cache uses occurred_at and leaves unread_count unchanged', async () => {
        await emailQueries.refreshThreadLastMessage(threadA, COMPANY_A, mailboxA);
        const refreshed = await emailQueries.getThreadById(threadA, COMPANY_A);
        expect(refreshed.last_message_at).toEqual(OBSERVED_AT);
        expect(refreshed.last_message_direction).toBe('outbound');
        expect(refreshed.unread_count).toBe(7);

        await emailQueries.markDraftArtifact(COMPANY_A, mailboxA, `${TAG}-reply`);
        const afterDraft = await emailQueries.getThreadById(threadA, COMPANY_A);
        expect(afterDraft.last_message_at).toEqual(PARENT_AT);
        expect(afterDraft.last_message_direction).toBe('inbound');
        expect(afterDraft.unread_count).toBe(7);
    });

    test('T-own/T-foreign/T-blast: cache and draft writes cannot cross companies', async () => {
        const beforeB = await db.query(
            `SELECT to_jsonb(thread) AS snapshot
             FROM email_threads thread
             WHERE id = $1 AND company_id = $2`,
            [threadB, COMPANY_B]
        );

        await expect(emailQueries.refreshThreadLastMessage(threadA, COMPANY_B, mailboxB))
            .resolves.toBeNull();
        await expect(emailQueries.markDraftArtifact(COMPANY_A, mailboxA, `${TAG}-reply`))
            .resolves.toBeNull();

        const afterB = await db.query(
            `SELECT to_jsonb(thread) AS snapshot
             FROM email_threads thread
             WHERE id = $1 AND company_id = $2`,
            [threadB, COMPANY_B]
        );
        const foreignMessage = await db.query(
            `SELECT is_draft_artifact
             FROM email_messages
             WHERE company_id = $1 AND provider_message_id = $2`,
            [COMPANY_B, `${TAG}-reply`]
        );
        expect(afterB.rows[0].snapshot).toStrictEqual(beforeB.rows[0].snapshot);
        expect(foreignMessage.rows[0].is_draft_artifact).toBe(false);
    });
});
