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
jest.mock('../backend/src/services/emailMailboxService', () => ({
    createOAuth2Client: jest.fn(),
    getValidAccessToken: jest.fn(),
}));
jest.mock('../backend/src/services/emailSyncService', () => ({ importGmailThread: jest.fn() }));

const { buildMimeMessage } = require('../backend/src/services/emailService');

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
});

describe('MIME-ALT-02 · no textBody → the historical single-part text/html (regression)', () => {
    it('keeps the lone text/html shape for every non-Yelp sender', () => {
        const raw = decode(buildMimeMessage({
            from: 'help@bostonmasters.com',
            to: 'x@y.z',
            subject: 'Estimate',
            body: '<p>doc</p>',
        }));
        expect(raw).toContain('Content-Type: text/html; charset=utf-8');
        expect(raw).not.toContain('multipart/alternative');
        expect(raw.trim().endsWith('<p>doc</p>')).toBe(true);
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
