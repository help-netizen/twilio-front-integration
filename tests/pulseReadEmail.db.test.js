'use strict';

const db = require('../backend/src/db/connection');
const emailQueries = require('../backend/src/db/emailQueries');

const COMPANY_A = '00000000-0000-0000-0000-000000000001';
const COMPANY_B = '00000000-0000-0000-0000-0000000000e1';
const TAG = `pulse-read-email-${Date.now()}`;
const SHARED_EMAIL = `${TAG}@example.com`;

let dbReady = false;
const contactIds = [];
const threadIds = [];
const messageIds = [];
const mailboxes = {};

async function ensureMailbox(companyId) {
    if (mailboxes[companyId]) return mailboxes[companyId].id;
    const existing = await db.query(
        'SELECT id FROM email_mailboxes WHERE company_id = $1 ORDER BY id LIMIT 1',
        [companyId]
    );
    if (existing.rows[0]) {
        mailboxes[companyId] = { id: existing.rows[0].id, created: false };
        return existing.rows[0].id;
    }
    const result = await db.query(
        `INSERT INTO email_mailboxes (company_id, provider, email_address, status)
         VALUES ($1, 'gmail', $2, 'connected') RETURNING id`,
        [companyId, `${TAG}-${companyId.slice(-4)}@mailbox.example.com`]
    );
    mailboxes[companyId] = { id: result.rows[0].id, created: true };
    return result.rows[0].id;
}

async function seedContact(companyId, name, email) {
    const result = await db.query(
        'INSERT INTO contacts (company_id, full_name) VALUES ($1, $2) RETURNING id',
        [companyId, name]
    );
    const contactId = result.rows[0].id;
    contactIds.push(contactId);
    await db.query(
        `INSERT INTO contact_emails (contact_id, email, email_normalized, is_primary)
         VALUES ($1, $2, lower(trim($2)), true)`,
        [contactId, email]
    );
    return contactId;
}

async function seedThread(companyId, unreadCount, suffix) {
    const mailboxId = await ensureMailbox(companyId);
    const result = await db.query(
        `INSERT INTO email_threads
            (company_id, mailbox_id, provider_thread_id, unread_count)
         VALUES ($1, $2, $3, $4) RETURNING id`,
        [companyId, mailboxId, `${TAG}-${suffix}`, unreadCount]
    );
    threadIds.push(result.rows[0].id);
    return result.rows[0].id;
}

async function seedMessage(companyId, threadId, suffix, {
    direction,
    fromEmail,
    contactId = null,
    onTimeline = false,
}) {
    const mailboxId = await ensureMailbox(companyId);
    const providerMessageId = `${TAG}-${suffix}`;
    messageIds.push(providerMessageId);
    await db.query(
        `INSERT INTO email_messages
            (company_id, mailbox_id, thread_id, provider_message_id, direction,
             from_email, contact_id, on_timeline)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [companyId, mailboxId, threadId, providerMessageId, direction,
            fromEmail || null, contactId, onTimeline]
    );
}

beforeAll(async () => {
    try {
        const company = await db.query('SELECT id FROM companies WHERE id = $1', [COMPANY_A]);
        if (!company.rows[0]) throw new Error('default company is not seeded');
        await db.query('SELECT on_timeline FROM email_messages LIMIT 1');
        dbReady = true;
    } catch (error) {
        console.warn('\n[pulseReadEmail.db] SKIPPED-NEEDS-DB —', error.message, '\n');
        return;
    }

    await db.query(
        `INSERT INTO companies (id, name, slug)
         VALUES ($1, 'Pulse Read Email Test Co', $2)
         ON CONFLICT (id) DO NOTHING`,
        [COMPANY_B, `${TAG}-company-b`]
    );
});

afterAll(async () => {
    if (dbReady) {
        try {
            if (messageIds.length) {
                await db.query(
                    'DELETE FROM email_messages WHERE provider_message_id = ANY($1)',
                    [messageIds]
                );
            }
            if (threadIds.length) {
                await db.query('DELETE FROM email_threads WHERE id = ANY($1)', [threadIds]);
            }
            if (contactIds.length) {
                await db.query('DELETE FROM contacts WHERE id = ANY($1)', [contactIds]);
            }
            for (const mailbox of Object.values(mailboxes)) {
                if (mailbox.created) {
                    await db.query('DELETE FROM email_mailboxes WHERE id = $1', [mailbox.id]);
                }
            }
            await db.query('DELETE FROM companies WHERE id = $1', [COMPANY_B]);
        } catch (error) {
            console.warn('[pulseReadEmail.db] cleanup failed:', error.message);
        }
    }
    try { await db.pool.end(); } catch (_) { /* ignore */ }
});

describe('markContactEmailThreadsRead — real PostgreSQL', () => {
    test('clears inbound-email and outbound-timeline threads only within the contact company', async () => {
        if (!dbReady) return console.warn('PULSE-READ-EMAIL-001 SKIPPED-NEEDS-DB');

        const contactId = await seedContact(COMPANY_A, 'Pulse Email Contact', SHARED_EMAIL);
        const unrelatedContactId = await seedContact(
            COMPANY_A,
            'Unrelated Pulse Contact',
            `unrelated-${SHARED_EMAIL}`
        );
        const otherCompanyContactId = await seedContact(
            COMPANY_B,
            'Other Company Contact',
            SHARED_EMAIL
        );

        const inboundThreadId = await seedThread(COMPANY_A, 2, 'inbound');
        const outboundThreadId = await seedThread(COMPANY_A, 1, 'outbound');
        const unrelatedThreadId = await seedThread(COMPANY_A, 1, 'unrelated');
        const otherCompanyThreadId = await seedThread(COMPANY_B, 1, 'other-company');

        await seedMessage(COMPANY_A, inboundThreadId, 'inbound-message', {
            direction: 'inbound',
            fromEmail: `  ${SHARED_EMAIL.toUpperCase()}  `,
        });
        await seedMessage(COMPANY_A, outboundThreadId, 'outbound-message', {
            direction: 'outbound',
            contactId,
            onTimeline: true,
        });
        await seedMessage(COMPANY_A, unrelatedThreadId, 'unrelated-message', {
            direction: 'outbound',
            contactId: unrelatedContactId,
            onTimeline: true,
        });
        await seedMessage(COMPANY_B, otherCompanyThreadId, 'other-company-message', {
            direction: 'inbound',
            fromEmail: SHARED_EMAIL,
            contactId: otherCompanyContactId,
            onTimeline: true,
        });

        await expect(emailQueries.markContactEmailThreadsRead(contactId, COMPANY_A))
            .resolves.toBe(2);

        const unread = await db.query(
            `SELECT id, unread_count
             FROM email_threads
             WHERE id = ANY($1)`,
            [[inboundThreadId, outboundThreadId, unrelatedThreadId, otherCompanyThreadId]]
        );
        const byId = new Map(unread.rows.map(row => [String(row.id), row.unread_count]));
        expect(byId.get(String(inboundThreadId))).toBe(0);
        expect(byId.get(String(outboundThreadId))).toBe(0);
        expect(byId.get(String(unrelatedThreadId))).toBe(1);
        expect(byId.get(String(otherCompanyThreadId))).toBe(1);

        await expect(emailQueries.markContactEmailThreadsRead(contactId, COMPANY_B))
            .resolves.toBe(0);
        const otherCompanyUnread = await db.query(
            'SELECT unread_count FROM email_threads WHERE id = $1',
            [otherCompanyThreadId]
        );
        expect(otherCompanyUnread.rows[0].unread_count).toBe(1);
    });
});
