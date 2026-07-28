'use strict';

const fs = require('fs');
const path = require('path');
const {
    MAX_HTML_BYTES,
    stripTimelineHtml,
} = require('../backend/src/services/email/emailTimelineHtml');

const OUTLOOK_FIXTURE = fs.readFileSync(
    path.join(__dirname, 'fixtures/email-79436-outlook-desktop.html'),
    'utf8'
);

describe('stripTimelineHtml — Pulse new-message HTML projection', () => {
    test('real 79436 Outlook-desktop shape strips the contained header and whole quoted chain', () => {
        const output = stripTimelineHtml(OUTLOOK_FIXTURE);

        expect(output).toContain('Hello:');
        expect(output).toContain('updated W-9 form');
        expect(output).toContain('Kind regards');
        expect(output).not.toContain('From:');
        expect(output).not.toContain('Hi Thank you, it is attached');
        expect(output).not.toContain('OLDER-THREAD-SENTINEL');
    });

    test('chooses the earliest Outlook boundary over a later high-confidence Gmail marker', () => {
        const withNestedGmailClass = OUTLOOK_FIXTURE.replace(
            '<div>On Mon, Jul 27, 2026',
            '<div class="gmail_quote">On Mon, Jul 27, 2026'
        );
        const output = stripTimelineHtml(withNestedGmailClass);

        expect(output).toContain('updated W-9 form');
        expect(output).not.toContain('From:');
        expect(output).not.toContain('Hi Thank you, it is attached');
    });

    test('deep attribution fallback reaches a nested On-wrote line when the border detector is disabled', () => {
        const borderDisabled = OUTLOOK_FIXTURE.replace(
            'border-top:solid #E1E1E1 1.0pt',
            'border-bottom:solid #E1E1E1 1.0pt'
        );
        const output = stripTimelineHtml(borderDisabled);

        // With the earlier Outlook marker intentionally disabled, conservative
        // under-stripping keeps that older segment but still reaches and removes
        // the deeply nested Gmail attribution and everything after it.
        expect(output).toContain('Hi Thank you, it is attached');
        expect(output).not.toContain('On Mon, Jul 27, 2026');
        expect(output).not.toContain('OLDER-THREAD-SENTINEL');
    });

    test('path-preserving deep cut keeps a reply that shares the attribution wrapper', () => {
        const html = [
            '<div class="outer"><div class="mail-wrapper">',
            '<p>Fresh reply survives</p>',
            '<div><span>On Mon, Jul 27, 2026 at 8:11 PM</span> Person wrote:</div>',
            '<blockquote>QUOTED-SENTINEL</blockquote>',
            '</div><div>later quote sibling</div></div>',
        ].join('');

        const output = stripTimelineHtml(html);
        expect(output).toContain('Fresh reply survives');
        expect(output).not.toContain('On Mon');
        expect(output).not.toContain('QUOTED-SENTINEL');
        expect(output).not.toContain('later quote sibling');
    });

    test('supports the older Outlook shape whose header run precedes the border div', () => {
        const html = [
            '<p>New reply</p>',
            '<div>From: Support &lt;help@example.com&gt;<br>Sent: Monday<br>',
            'To: Customer &lt;customer@example.com&gt;<br>Subject: Re: Work</div>',
            '<div style="border-top:1px solid #ccc">old body</div>',
        ].join('');

        const output = stripTimelineHtml(html);
        expect(output).toContain('New reply');
        expect(output).not.toContain('From:');
        expect(output).not.toContain('old body');
    });

    test.each([
        ['Gmail class', '<p>New</p><div class="gmail_quote">OLD</div>'],
        ['Apple cite', '<p>New</p><blockquote type="cite">OLD</blockquote>'],
        ['Outlook append marker', '<p>New</p><div id="appendonsend"></div><p>OLD</p>'],
        ['Yahoo class', '<p>New</p><div class="yahoo_quoted">OLD</div>'],
    ])('%s marker strips its quote', (_name, html) => {
        const output = stripTimelineHtml(html);
        expect(output).toContain('New');
        expect(output).not.toContain('OLD');
    });

    test('no recognized boundary is a byte-identical passthrough', () => {
        const html = '<div style="color:red">Standalone &amp; complete message</div>';
        expect(stripTimelineHtml(html)).toBe(html);
    });

    test('recognized quote with a near-empty HTML reply falls back to body_text via null', () => {
        expect(stripTimelineHtml('<p>&nbsp;</p><div class="gmail_quote">OLD</div>')).toBeNull();
    });

    test('image-only new reply survives the near-empty guard', () => {
        const output = stripTimelineHtml(
            '<div><img src="cid:photo"></div><div class="gmail_quote">OLD</div>'
        );
        expect(output).toContain('cid:photo');
        expect(output).not.toContain('OLD');
    });

    test('oversize HTML and empty inputs return null instead of leaking raw HTML', () => {
        expect(stripTimelineHtml('x'.repeat(MAX_HTML_BYTES + 1))).toBeNull();
        expect(stripTimelineHtml(null)).toBeNull();
        expect(stripTimelineHtml('  ')).toBeNull();
    });

    test('parsing raw HTML never executes scripts; rendering sanitization remains client-side', () => {
        delete global.__emailTimelineHtmlExecuted;
        const output = stripTimelineHtml([
            '<p>Safe reply</p>',
            '<script>global.__emailTimelineHtmlExecuted = true</script>',
            '<div class="gmail_quote">OLD</div>',
        ].join(''));

        expect(global.__emailTimelineHtmlExecuted).toBeUndefined();
        expect(output).toContain('<script>');
        expect(output).not.toContain('OLD');
    });

    test('a stripped result is idempotent', () => {
        const once = stripTimelineHtml('<p>New</p><div class="gmail_quote">OLD</div>');
        expect(stripTimelineHtml(once)).toBe(once);
    });
});
