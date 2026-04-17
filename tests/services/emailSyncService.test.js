/**
 * EmailSyncService — Unit Tests
 * Gmail parsing helpers, message extraction, sync logic.
 */

const {
    parseGmailHeaders,
    parseEmailAddress,
    parseRecipientList,
    extractBody,
    extractAttachments,
} = require('../../backend/src/services/emailSyncService');

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
