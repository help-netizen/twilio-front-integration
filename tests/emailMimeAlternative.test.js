'use strict';

/**
 * YELP-REPLY-FORMAT-001 — buildMimeMessage's multipart/alternative support.
 * Yelp's reply-by-email parser can't handle a lone text/html part; when a
 * `textBody` is supplied the message must be multipart/alternative with the
 * text/plain part FIRST (like Gmail). Without textBody the historical single-part
 * text/html shape must be byte-compatible (every other sender is unaffected).
 *
 * NAMED SABOTAGE SAB-ALT-DROP-PLAIN: ignore textBody (always single-part html)
 * → the multipart assertions turn RED.
 *
 * Run:
 *   node <repo>/node_modules/jest/bin/jest.js tests/emailMimeAlternative.test.js \
 *     --rootDir . --testPathIgnorePatterns "/node_modules/" --forceExit
 */

// emailService requires googleapis + mailbox service at module load — stub the
// heavy deps; buildMimeMessage itself is a pure function.
jest.mock('googleapis', () => ({ google: { gmail: jest.fn() } }));
jest.mock('../backend/src/db/connection', () => ({ query: jest.fn() }));
jest.mock('../backend/src/db/emailQueries', () => ({
    getMailboxWithTokens: jest.fn(),
    getThreadById: jest.fn(),
    getMessagesByThread: jest.fn(),
}));
jest.mock('../backend/src/services/emailMailboxService', () => ({
    createOAuth2Client: jest.fn(),
    getValidAccessToken: jest.fn(),
}));
jest.mock('../backend/src/services/emailSyncService', () => ({ importGmailThread: jest.fn() }));

const { google } = require('googleapis');
const emailQueries = require('../backend/src/db/emailQueries');
const emailMailboxService = require('../backend/src/services/emailMailboxService');
const { importGmailThread } = require('../backend/src/services/emailSyncService');
const { buildMimeMessage, sendEmail, replyToThread } = require('../backend/src/services/emailService');
const { plainTextToHtml } = require('../backend/src/services/email/plainTextEmailBody');

const decode = (b64url) => Buffer.from(b64url, 'base64url').toString('utf8');

describe('MIME-ALT-01 · textBody → multipart/alternative, text/plain FIRST', () => {
    it('carries both parts, plain before html, threading headers intact', () => {
        const raw = decode(buildMimeMessage({
            from: 'help@bostonmasters.com',
            to: 'reply+abc@messaging.yelp.com',
            subject: 'Re: ABC Homes\'s response to Ryan P.',
            body: '<div dir="ltr">Hi Ryan</div>',
            textBody: 'Hi Ryan\n\nOn Sun wrote:\n> original',
            inReplyTo: '<mid@messaging.yelp.com>',
            references: '<mid@messaging.yelp.com>',
        }));

        expect(raw).toMatch(/Content-Type: multipart\/alternative; boundary="/);
        expect(raw).toContain('In-Reply-To: <mid@messaging.yelp.com>');
        expect(raw).toContain('References: <mid@messaging.yelp.com>');
        const plainAt = raw.indexOf('Content-Type: text/plain; charset=utf-8');
        const htmlAt = raw.indexOf('Content-Type: text/html; charset=utf-8');
        expect(plainAt).toBeGreaterThan(-1);
        expect(htmlAt).toBeGreaterThan(-1);
        expect(plainAt).toBeLessThan(htmlAt); // Gmail order: plain first
        expect(raw).toContain('> original');
        expect(raw).toContain('<div dir="ltr">Hi Ryan</div>');
        // closing boundary present
        expect(raw).toMatch(/--blanc_alt_[^\r\n]*--/);
    });

    it('manual text keeps the exact plain part and renders paragraphs plus indentation in HTML', () => {
        const textBody = 'First & <line> "quoted" \'single\'\n\n  indented\n\tTabbed';
        const htmlBody = plainTextToHtml(textBody);
        const raw = decode(buildMimeMessage({
            from: 'help@example.com',
            to: 'customer@example.com',
            subject: 'Manual email',
            body: htmlBody,
            textBody,
        }));

        const plainHeaderAt = raw.indexOf('Content-Type: text/plain; charset=utf-8');
        const plainBodyAt = raw.indexOf('\r\n\r\n', plainHeaderAt) + 4;
        const plainBodyEnd = raw.indexOf('\r\n\r\n--', plainBodyAt);
        const htmlHeaderAt = raw.indexOf('Content-Type: text/html; charset=utf-8');
        const htmlBodyAt = raw.indexOf('\r\n\r\n', htmlHeaderAt) + 4;
        const htmlBodyEnd = raw.indexOf('\r\n\r\n--', htmlBodyAt);

        expect(raw.slice(plainBodyAt, plainBodyEnd)).toBe(textBody);
        expect(raw.slice(htmlBodyAt, htmlBodyEnd)).toBe(htmlBody);
        expect(htmlBody).toBe(
            'First &amp; &lt;line&gt; &quot;quoted&quot; &#39;single&#39;<br>\r\n' +
            '<br>\r\n&nbsp;&nbsp;indented<br>\r\n' +
            '&nbsp;&nbsp;&nbsp;&nbsp;Tabbed'
        );
    });
});

describe('MIME-ALT-02 · no textBody → the historical single-part text/html (regression)', () => {
    it('keeps an estimate/invoice HTML body byte-identical for existing HTML senders', () => {
        const htmlBody = '<p style="color: red">Estimate &amp; invoice</p>';
        const raw = decode(buildMimeMessage({
            from: 'help@bostonmasters.com',
            to: 'x@y.z',
            subject: 'Estimate',
            body: htmlBody,
        }));
        expect(raw).toContain('Content-Type: text/html; charset=utf-8');
        expect(raw).not.toContain('multipart/alternative');
        expect(raw.slice(raw.indexOf('\r\n\r\n') + 4)).toBe(htmlBody);
    });
});

describe('MIME-ALT-03 · attachments + textBody → alternative pair nested in mixed', () => {
    it('multipart/mixed wraps [multipart/alternative, attachment]', () => {
        const raw = decode(buildMimeMessage({
            from: 'a@b.c', to: 'x@y.z', subject: 's',
            body: '<p>h</p>', textBody: 'h',
            files: [{ mimetype: 'application/pdf', originalname: 'doc.pdf', buffer: Buffer.from('PDF') }],
        }));
        expect(raw).toMatch(/Content-Type: multipart\/mixed; boundary="/);
        expect(raw).toMatch(/Content-Type: multipart\/alternative; boundary="/);
        expect(raw).toContain('Content-Type: text/plain; charset=utf-8');
        expect(raw).toContain('Content-Disposition: attachment; filename="doc.pdf"');
    });
});

describe('MIME-INLINE-01 · receipt logo uses a Content-ID part', () => {
    it('marks CID files inline while preserving ordinary PDF attachments', () => {
        const raw = decode(buildMimeMessage({
            from: 'a@b.c',
            to: 'x@y.z',
            subject: 'Payment receipt',
            body: '<img src="cid:albusto-company-logo">',
            textBody: 'Payment receipt',
            files: [
                {
                    mimetype: 'image/png',
                    originalname: 'company-logo.png',
                    buffer: Buffer.from('PNG'),
                    contentId: 'albusto-company-logo',
                },
                {
                    mimetype: 'application/pdf',
                    originalname: 'Invoice-88.pdf',
                    buffer: Buffer.from('PDF'),
                },
            ],
        }));

        expect(raw).toContain('Content-Disposition: inline; filename="company-logo.png"');
        expect(raw).toContain('Content-ID: <albusto-company-logo>');
        expect(raw).toContain('Content-Disposition: attachment; filename="Invoice-88.pdf"');
    });
});

describe('manual send/reply service plumbing', () => {
    let gmailSend;

    beforeEach(() => {
        jest.clearAllMocks();
        gmailSend = jest.fn().mockResolvedValue({ data: { id: 'sent-1', threadId: 'provider-thread-1' } });
        google.gmail.mockReturnValue({ users: { messages: { send: gmailSend } } });
        emailMailboxService.createOAuth2Client.mockReturnValue({ setCredentials: jest.fn() });
        emailMailboxService.getValidAccessToken.mockResolvedValue('access-token');
        emailQueries.getMailboxWithTokens.mockResolvedValue({
            id: 'mailbox-1',
            status: 'connected',
            email_address: 'help@example.com',
        });
        importGmailThread.mockResolvedValue(undefined);
    });

    test('sendEmail carries both manual alternatives into the Gmail raw message', async () => {
        const textBody = 'Compose line one\n\n  Compose paragraph';
        const htmlBody = plainTextToHtml(textBody);

        await sendEmail('company-1', {
            to: ['customer@example.com'],
            subject: 'Compose',
            body: htmlBody,
            textBody,
        });

        const raw = decode(gmailSend.mock.calls[0][0].requestBody.raw);
        expect(raw).toContain(`Content-Type: text/plain; charset=utf-8\r\n\r\n${textBody}`);
        expect(raw).toContain(`Content-Type: text/html; charset=utf-8\r\n\r\n${htmlBody}`);
    });

    test('replyToThread carries both manual alternatives into the Gmail raw message', async () => {
        const textBody = 'Reply line one\n\n\tReply paragraph';
        const htmlBody = plainTextToHtml(textBody);
        emailQueries.getThreadById.mockResolvedValue({
            subject: 'Original',
            provider_thread_id: 'provider-thread-1',
        });
        emailQueries.getMessagesByThread.mockResolvedValue([{
            message_id_header: '<original@example.com>',
            references_header: null,
        }]);

        await replyToThread('company-1', 'local-thread-1', {
            to: ['customer@example.com'],
            body: htmlBody,
            textBody,
        });

        const raw = decode(gmailSend.mock.calls[0][0].requestBody.raw);
        expect(raw).toContain(`Content-Type: text/plain; charset=utf-8\r\n\r\n${textBody}`);
        expect(raw).toContain(`Content-Type: text/html; charset=utf-8\r\n\r\n${htmlBody}`);
        expect(raw).toContain('In-Reply-To: <original@example.com>');
    });
});
