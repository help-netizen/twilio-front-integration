'use strict';

/**
 * YELP-REPLY-FORMAT-001 — the reply bodies Yelp's parser accepts (proven on prod:
 * thread "Ryan P.", same mailbox + same target message — the owner's Gmail reply
 * with multipart/alternative + quoted original was ACCEPTED and delivered; our
 * bare single-part send bounced cant_parse).
 *
 * NAMED SABOTAGE SAB-QUOTE-DROP: return {html: reply, text: reply} ignoring `quote`
 * → the "wrote:" attribution + "> " quoting assertions turn RED (and prod replies
 * bounce cant_parse again).
 *
 * Run:
 *   node <repo>/node_modules/jest/bin/jest.js tests/yelpReplyFormat.test.js \
 *     --rootDir . --testPathIgnorePatterns "/node_modules/" --forceExit
 */

const { buildReplyBodies, formatAttributionDate } = require('../backend/src/services/yelpReplyFormat');

const QUOTE = {
    body_text: 'Ryan requested a quote from ABC Homes for a refrigerator repair.\nIn what location do you need the service?\n02467',
    body_html: '<p>Ryan requested a quote from ABC Homes for a refrigerator repair.</p>',
    from_email: 'reply+9ef1b6fe57c446409174a9f93c54a3f5@messaging.yelp.com',
    from_name: 'Yelp Inbox',
    gmail_internal_at: '2026-07-13T02:27:05.000Z',
};

describe('YRF-01 · quoted reply mirrors Gmail (text/plain leg)', () => {
    it('reply on top, "On <date> <sender> wrote:" attribution, every original line "> "-prefixed', () => {
        const { text } = buildReplyBodies('Hi Ryan! What is the best phone number?', QUOTE);
        // reply text first
        expect(text.startsWith('Hi Ryan! What is the best phone number?')).toBe(true);
        // Gmail attribution: date (company TZ) + display name + address + "wrote:"
        expect(text).toMatch(/On .*2026 at .*Yelp Inbox <reply\+9ef1b6fe57c446409174a9f93c54a3f5@messaging\.yelp\.com> wrote:/);
        // every quoted line "> "-prefixed
        expect(text).toContain('> Ryan requested a quote from ABC Homes');
        expect(text).toContain('> In what location do you need the service?');
        expect(text).toContain('> 02467');
    });
});

describe('YRF-02 · quoted reply mirrors Gmail (text/html leg)', () => {
    it('gmail_quote wrapper + gmail_attr attribution + blockquote with the ORIGINAL html', () => {
        const { html } = buildReplyBodies("Hi Ryan! What's the best phone number?", QUOTE);
        expect(html).toContain('<div class="gmail_quote">');
        expect(html).toContain('class="gmail_attr"');
        expect(html).toMatch(/wrote:/);
        expect(html).toContain('<blockquote class="gmail_quote"');
        // original html is embedded UNescaped inside the blockquote
        expect(html).toContain('<p>Ryan requested a quote from ABC Homes for a refrigerator repair.</p>');
        // the reply itself is html-escaped (apostrophe)
        expect(html).toContain('What&#39;s the best phone number?');
    });
});

describe('YRF-03 · no quote → degrade to unquoted (never throw)', () => {
    it('null quote and empty-body quote both return the bare reply in both legs', () => {
        for (const q of [null, {}, { from_email: 'x@y.z' }]) {
            const { html, text } = buildReplyBodies('Hello there', q);
            expect(text).toBe('Hello there');
            expect(html).toContain('Hello there');
            expect(html).not.toContain('gmail_quote');
        }
    });

    it('text-only original (no body_html) still quotes: html leg escapes the plain text', () => {
        const { html, text } = buildReplyBodies('Reply', { ...QUOTE, body_html: null });
        expect(text).toContain('> Ryan requested');
        expect(html).toContain('<blockquote class="gmail_quote"');
        expect(html).toContain('Ryan requested a quote from ABC Homes');
    });
});

describe('YRF-04 · attribution date is company-TZ Gmail format', () => {
    it('formats like "Sun, Jul 12, 2026 at 10:27 PM" (America/New_York)', () => {
        // NB: U+202F (narrow no-break space) before AM/PM — Intl emits it, and the
        // ACCEPTED Gmail specimen uses the exact same char ("10:27=E2=80=AFPM" in its
        // quoted-printable), so we deliberately keep it.
        const got = formatAttributionDate('2026-07-13T02:27:05.000Z');
        expect(got).toBe('Sun, Jul 12, 2026 at 10:27\u202FPM');
        expect(formatAttributionDate('not-a-date')).toBe(null);
    });
});
