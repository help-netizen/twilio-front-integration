/**
 * EmailSyncService — Unit Tests
 * Gmail parsing helpers, message extraction, sync logic.
 */

const mockGoogleGmail = jest.fn();

jest.mock('googleapis', () => ({
    google: { gmail: mockGoogleGmail },
}));
jest.mock('../../backend/src/db/emailQueries', () => ({
    getMailboxWithTokens: jest.fn(),
    getSyncState: jest.fn(),
    upsertThread: jest.fn(),
    upsertMessage: jest.fn(),
    upsertAttachments: jest.fn(),
    refreshThreadLastMessage: jest.fn(),
    upsertSyncState: jest.fn(),
    updateMailboxStatus: jest.fn(),
}));
jest.mock('../../backend/src/services/emailMailboxService', () => ({
    createOAuth2Client: jest.fn(() => ({ setCredentials: jest.fn() })),
    getValidAccessToken: jest.fn(),
    getGmailProfile: jest.fn(),
}));

const emailQueries = require('../../backend/src/db/emailQueries');
const emailMailboxService = require('../../backend/src/services/emailMailboxService');
const {
    parseGmailHeaders,
    parseEmailAddress,
    parseRecipientList,
    extractBody,
    extractAttachments,
    importGmailThread,
    runInitialBackfill,
    pullChangesNormalized,
    computeOccurredAt,
} = require('../../backend/src/services/emailSyncService');

const COMPANY_ID = '00000000-0000-0000-0000-00000000000a';
const MAILBOX_ID = '11111111-1111-1111-1111-111111111111';
const MAILBOX_EMAIL = 'dispatch@example.com';

function gmailMessage({ id, from, to, subject, at, labels = [], snippet, attachment = false, inReplyTo = null }) {
    const parts = [{
        mimeType: 'text/plain',
        body: { data: Buffer.from(`${id} body`).toString('base64url') },
    }];
    if (attachment) {
        parts.push({
            mimeType: 'application/pdf',
            filename: `${id}.pdf`,
            partId: '2',
            body: { attachmentId: `${id}-attachment`, size: 10 },
            headers: [{ name: 'Content-Disposition', value: 'attachment' }],
        });
    }
    return {
        id,
        threadId: 'thread-1',
        internalDate: String(at),
        labelIds: labels,
        snippet,
        payload: {
            mimeType: 'multipart/mixed',
            headers: [
                { name: 'From', value: from },
                { name: 'To', value: to },
                { name: 'Subject', value: subject },
                { name: 'Message-ID', value: `<${id}@example.com>` },
                ...(inReplyTo ? [{ name: 'In-Reply-To', value: inReplyTo }] : []),
            ],
            parts,
        },
    };
}

function gmailClient({ threads = [], threadMessages = [] } = {}) {
    return {
        users: {
            history: {
                list: jest.fn().mockResolvedValue({ data: { history: [] } }),
            },
            threads: {
                list: jest.fn().mockResolvedValue({ data: { threads } }),
                get: jest.fn().mockResolvedValue({ data: { messages: threadMessages } }),
            },
            messages: { get: jest.fn() },
        },
    };
}

beforeEach(() => {
    jest.clearAllMocks();
    emailQueries.getMailboxWithTokens.mockResolvedValue({
        id: MAILBOX_ID,
        email_address: MAILBOX_EMAIL,
        history_id: null,
    });
    emailQueries.upsertThread.mockResolvedValue({ id: 77 });
    emailQueries.upsertMessage.mockImplementation(async data => ({ id: data.provider_message_id }));
    emailQueries.upsertAttachments.mockResolvedValue([]);
    emailQueries.refreshThreadLastMessage.mockResolvedValue({ id: 77 });
    emailMailboxService.getValidAccessToken.mockResolvedValue('access-token');
    emailMailboxService.getGmailProfile.mockResolvedValue({ history_id: 'cursor-new' });
});

describe('emailSyncService — parsing helpers', () => {
    // ─── parseGmailHeaders ───────────────────────────────────────���───────
    describe('parseGmailHeaders', () => {
        test('extracts standard headers', () => {
            const headers = [
                { name: 'Subject', value: 'Hello World' },
                { name: 'From', value: 'John <john@test.com>' },
                { name: 'To', value: 'jane@test.com' },
                { name: 'Message-ID', value: '<abc@test.com>' },
            ];
            const result = parseGmailHeaders(headers);
            expect(result.subject).toBe('Hello World');
            expect(result.from).toBe('John <john@test.com>');
            expect(result.to).toBe('jane@test.com');
            expect(result.message_id).toBe('<abc@test.com>');
        });

        test('returns nulls for missing headers', () => {
            const result = parseGmailHeaders([]);
            expect(result.subject).toBeNull();
            expect(result.from).toBeNull();
        });

        test('handles case-insensitive header names', () => {
            const headers = [{ name: 'subject', value: 'Lower case' }];
            const result = parseGmailHeaders(headers);
            expect(result.subject).toBe('Lower case');
        });
    });

    // ─── parseEmailAddress ───────────────────────────────────────────────
    describe('parseEmailAddress', () => {
        test('parses "Name <email>" format', () => {
            const result = parseEmailAddress('John Doe <john@test.com>');
            expect(result.name).toBe('John Doe');
            expect(result.email).toBe('john@test.com');
        });

        test('parses bare email', () => {
            const result = parseEmailAddress('john@test.com');
            expect(result.email).toBe('john@test.com');
        });

        test('parses "Name" <email> with quotes', () => {
            const result = parseEmailAddress('"Jane Doe" <jane@test.com>');
            expect(result.name).toBe('Jane Doe');
            expect(result.email).toBe('jane@test.com');
        });

        test('handles null input', () => {
            const result = parseEmailAddress(null);
            expect(result.name).toBeNull();
            expect(result.email).toBeNull();
        });
    });

    // ─── parseRecipientList ──────────────────────────────────────────────
    describe('parseRecipientList', () => {
        test('parses comma-separated list', () => {
            const result = parseRecipientList('a@test.com, John <b@test.com>');
            expect(result).toHaveLength(2);
            expect(result[0].email).toBe('a@test.com');
            expect(result[1].email).toBe('b@test.com');
        });

        test('returns empty array for null', () => {
            expect(parseRecipientList(null)).toEqual([]);
        });
    });

    // ─── extractBody ─────────────────────────────────────────────────────
    describe('extractBody', () => {
        test('extracts text/plain from simple payload', () => {
            const payload = {
                mimeType: 'text/plain',
                body: { data: Buffer.from('Hello world').toString('base64url') },
            };
            const { text, html } = extractBody(payload);
            expect(text).toBe('Hello world');
            expect(html).toBeNull();
        });

        test('extracts both text and html from multipart', () => {
            const payload = {
                mimeType: 'multipart/alternative',
                parts: [
                    { mimeType: 'text/plain', body: { data: Buffer.from('Plain text').toString('base64url') } },
                    { mimeType: 'text/html', body: { data: Buffer.from('<b>HTML</b>').toString('base64url') } },
                ],
            };
            const { text, html } = extractBody(payload);
            expect(text).toBe('Plain text');
            expect(html).toBe('<b>HTML</b>');
        });

        test('handles empty payload', () => {
            const { text, html } = extractBody({});
            expect(text).toBeNull();
            expect(html).toBeNull();
        });
    });

    // ─── extractAttachments ──────────────────────────────────────────────
    describe('extractAttachments', () => {
        test('extracts file attachments from multipart', () => {
            const payload = {
                mimeType: 'multipart/mixed',
                parts: [
                    { mimeType: 'text/plain', body: { data: 'text' } },
                    {
                        mimeType: 'application/pdf',
                        filename: 'report.pdf',
                        body: { attachmentId: 'att-1', size: 12345 },
                        partId: '2',
                        headers: [{ name: 'Content-Disposition', value: 'attachment; filename="report.pdf"' }],
                    },
                ],
            };
            const atts = extractAttachments(payload, 'msg-1');
            expect(atts).toHaveLength(1);
            expect(atts[0].file_name).toBe('report.pdf');
            expect(atts[0].provider_attachment_id).toBe('att-1');
            expect(atts[0].content_type).toBe('application/pdf');
            expect(atts[0].file_size).toBe(12345);
            expect(atts[0].is_inline).toBe(false);
        });

        test('detects inline attachments', () => {
            const payload = {
                mimeType: 'multipart/related',
                parts: [
                    {
                        mimeType: 'image/png',
                        filename: 'image.png',
                        body: { attachmentId: 'att-2', size: 5000 },
                        headers: [
                            { name: 'Content-Disposition', value: 'inline; filename="image.png"' },
                            { name: 'Content-ID', value: '<img001>' },
                        ],
                    },
                ],
            };
            const atts = extractAttachments(payload, 'msg-2');
            expect(atts).toHaveLength(1);
            expect(atts[0].is_inline).toBe(true);
            expect(atts[0].content_id).toBe('img001');
        });

        test('returns empty for no attachments', () => {
            const payload = { mimeType: 'text/plain', body: { data: 'text' } };
            expect(extractAttachments(payload, 'msg-3')).toHaveLength(0);
        });
    });
});

describe('emailSyncService — Gmail draft polling guards', () => {
    test('thread [inbound, DRAFT, sent] persists exactly two and aggregates without the draft', async () => {
        const inbound = gmailMessage({
            id: 'inbound-1',
            from: 'Customer <customer@example.com>',
            to: MAILBOX_EMAIL,
            subject: 'Need service',
            at: 1000,
            labels: ['INBOX', 'UNREAD'],
            snippet: 'incoming',
        });
        const draft = gmailMessage({
            id: 'draft-1',
            from: MAILBOX_EMAIL,
            to: 'draft-only@example.com',
            subject: 'Half written',
            at: 3000,
            labels: ['DRAFT', 'UNREAD'],
            snippet: 'unfinished',
            attachment: true,
        });
        const sent = gmailMessage({
            id: 'sent-1',
            from: `Dispatcher <${MAILBOX_EMAIL}>`,
            to: 'customer@example.com',
            subject: 'Re: Need service',
            at: 2000,
            labels: ['SENT'],
            snippet: 'finished reply',
        });
        const gmail = gmailClient({ threadMessages: [inbound, draft, sent] });

        await importGmailThread(
            gmail,
            'thread-1',
            COMPANY_ID,
            MAILBOX_ID,
            MAILBOX_EMAIL,
            { observedAt: new Date(2500) }
        );

        expect(emailQueries.upsertMessage).toHaveBeenCalledTimes(2);
        expect(emailQueries.upsertMessage.mock.calls.map(([row]) => row.provider_message_id))
            .toEqual(['inbound-1', 'sent-1']);
        expect(emailQueries.upsertThread).toHaveBeenCalledWith(expect.objectContaining({
            company_id: COMPANY_ID,
            mailbox_id: MAILBOX_ID,
            provider_thread_id: 'thread-1',
            last_message_at: new Date(2000),
            last_message_preview: 'finished reply',
            last_message_direction: 'outbound',
            unread_count: 1,
            has_attachments: false,
            message_count: 2,
        }));
        const aggregate = emailQueries.upsertThread.mock.calls[0][0];
        expect(aggregate.participants_json.map(person => person.email).sort())
            .toEqual([MAILBOX_EMAIL, 'customer@example.com'].sort());
    });

    test('live poll repairs a nine-hour outbound skew while inbound keeps provider time and reply follows parent', async () => {
        const parentAt = new Date('2026-08-14T15:39:00.000Z');
        const observedAt = new Date('2026-08-14T15:40:33.000Z');
        const skewedAt = new Date('2026-08-14T06:40:27.000Z');
        const parent = gmailMessage({
            id: 'parent-live', from: 'Customer <customer@example.com>', to: MAILBOX_EMAIL,
            subject: 'Need service', at: parentAt.getTime(), labels: ['INBOX'], snippet: 'parent',
        });
        const reply = gmailMessage({
            id: 'reply-live', from: MAILBOX_EMAIL, to: 'customer@example.com',
            subject: 'Re: Need service', at: skewedAt.getTime(), labels: ['SENT'], snippet: 'reply',
            inReplyTo: '<parent-live@example.com>',
        });
        const gmail = gmailClient({ threadMessages: [parent, reply] });

        await importGmailThread(
            gmail,
            'thread-1',
            COMPANY_ID,
            MAILBOX_ID,
            MAILBOX_EMAIL,
            { observedAt }
        );

        const persisted = emailQueries.upsertMessage.mock.calls.map(([row]) => row);
        const parentRow = persisted.find(row => row.provider_message_id === parent.id);
        const replyRow = persisted.find(row => row.provider_message_id === reply.id);
        expect(parentRow.occurred_at).toEqual(parentAt);
        expect(replyRow.occurred_at).toEqual(observedAt);
        expect(replyRow.in_reply_to_header).toBe('<parent-live@example.com>');
        expect(replyRow.occurred_at.getTime()).toBeGreaterThan(parentRow.occurred_at.getTime());
        expect(emailQueries.upsertThread).toHaveBeenCalledWith(expect.objectContaining({
            last_message_at: observedAt,
            last_message_direction: 'outbound',
        }));
        expect(emailQueries.refreshThreadLastMessage).toHaveBeenCalledWith(77, COMPANY_ID, MAILBOX_ID);
    });

    test('initial backfill always persists provider time despite a large observation gap', async () => {
        const providerAt = new Date('2025-01-02T03:04:05.000Z');
        const sent = gmailMessage({
            id: 'sent-historical', from: MAILBOX_EMAIL, to: 'customer@example.com',
            subject: 'Historical', at: providerAt.getTime(), labels: ['SENT'], snippet: 'old send',
        });
        const gmail = gmailClient({ threads: [{ id: 'thread-1' }], threadMessages: [sent] });
        mockGoogleGmail.mockReturnValue(gmail);

        await runInitialBackfill(COMPANY_ID);

        expect(emailQueries.upsertMessage).toHaveBeenCalledWith(expect.objectContaining({
            provider_message_id: sent.id,
            gmail_internal_at: providerAt,
            occurred_at: providerAt,
        }));
    });

    test('ten-minute boundary is inclusive for live outbound provider time', () => {
        const observedAt = new Date('2026-08-14T15:40:00.000Z');
        const gmailInternalAt = new Date('2026-08-14T15:30:00.000Z');
        expect(computeOccurredAt({
            direction: 'outbound',
            gmailInternalAt,
            observedAt,
        })).toEqual(gmailInternalAt);
    });

    test('both threads.list queries include -in:draft and normalized backfill omits DRAFT messages', async () => {
        const draft = gmailMessage({
            id: 'draft-backfill', from: MAILBOX_EMAIL, to: 'customer@example.com',
            subject: 'Draft', at: 3000, labels: ['DRAFT'], snippet: 'draft',
        });
        const sent = gmailMessage({
            id: 'sent-backfill', from: MAILBOX_EMAIL, to: 'customer@example.com',
            subject: 'Sent', at: 4000, labels: ['SENT'], snippet: 'sent',
        });
        const normalizedGmail = gmailClient({
            threads: [{ id: 'thread-backfill' }],
            threadMessages: [draft, sent],
        });
        const inboxGmail = gmailClient();
        mockGoogleGmail
            .mockReturnValueOnce(normalizedGmail)
            .mockReturnValueOnce(inboxGmail);

        const result = await pullChangesNormalized(COMPANY_ID, null);

        expect(inboxGmail.users.threads.list).toHaveBeenCalledWith(expect.objectContaining({
            q: expect.stringContaining('-in:draft'),
        }));
        expect(normalizedGmail.users.threads.list).toHaveBeenCalledWith(expect.objectContaining({
            q: expect.stringContaining('-in:draft'),
        }));
        expect(result.messages.map(message => message.provider_message_id)).toEqual(['sent-backfill']);
    });

    test('initial backfill threads.list query includes -in:draft', async () => {
        const gmail = gmailClient();
        mockGoogleGmail.mockReturnValue(gmail);

        await runInitialBackfill(COMPANY_ID);

        expect(gmail.users.threads.list).toHaveBeenCalledWith(expect.objectContaining({
            q: expect.stringContaining('-in:draft'),
        }));
    });

    test('history normalization omits a DRAFT fetched by message id', async () => {
        const draft = gmailMessage({
            id: 'draft-history', from: MAILBOX_EMAIL, to: 'customer@example.com',
            subject: 'Draft', at: 5000, labels: ['DRAFT'], snippet: 'unfinished',
        });
        const sent = gmailMessage({
            id: 'sent-history', from: MAILBOX_EMAIL, to: 'customer@example.com',
            subject: 'Sent', at: 6000, labels: ['SENT'], snippet: 'finished',
        });
        const gmail = gmailClient({ threadMessages: [draft, sent] });
        gmail.users.history.list.mockResolvedValue({
            data: {
                history: [{
                    messagesAdded: [
                        { message: { id: draft.id, threadId: draft.threadId } },
                        { message: { id: sent.id, threadId: sent.threadId } },
                    ],
                }],
            },
        });
        gmail.users.messages.get.mockImplementation(async ({ id }) => ({
            data: id === draft.id ? draft : sent,
        }));
        mockGoogleGmail.mockReturnValue(gmail);

        const result = await pullChangesNormalized(COMPANY_ID, 'cursor-old');

        expect(gmail.users.messages.get).toHaveBeenCalledTimes(2);
        expect(result.messages.map(message => message.provider_message_id))
            .toEqual(['sent-history']);
    });
});
