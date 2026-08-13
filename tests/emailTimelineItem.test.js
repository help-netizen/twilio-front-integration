'use strict';

const { projectEmailTimelineItem } = require('../backend/src/services/email/emailTimelineItem');

function emailRow(overrides = {}) {
    return {
        id: 1,
        direction: 'outbound',
        body_text: '',
        body_html: '',
        snippet: 'short provider snippet',
        ...overrides,
    };
}

describe('projectEmailTimelineItem — body fallback chain', () => {
    test('legacy plain text stored in body_html is returned in full, not truncated to snippet', () => {
        const firstParagraph = 'Complete legacy message content '.repeat(12).trim();
        const storedBodyHtml = `${firstParagraph}\n\nSecond paragraph after the blank line.`;
        const item = projectEmailTimelineItem(emailRow({ body_html: storedBodyHtml }));

        expect(item.body_text).toBe(storedBodyHtml);
        expect(item.body_text.length).toBeGreaterThan(280);
        expect(item.body_text).not.toBe('short provider snippet');
    });

    test('empty body_text falls back to full body_html text before snippet and strips quotes', () => {
        const fullText = 'This is the complete manually sent message, which is deliberately much longer than its provider snippet.';
        const item = projectEmailTimelineItem(emailRow({
            body_html: [
                `<div>${fullText}</div>`,
                '<div>Second paragraph remains visible.</div>',
                '<div>On Mon, Aug 10, 2026 Agent &lt;agent@example.com&gt; wrote:</div>',
                '<blockquote>&gt; quoted history</blockquote>',
            ].join(''),
        }));

        expect(item.body_text).toBe(`${fullText}\nSecond paragraph remains visible.`);
        expect(item.body_text).not.toBe('short provider snippet');
        expect(item.body_text).not.toContain('quoted history');
    });

    test('empty body_text and body_html fall back to snippet', () => {
        expect(projectEmailTimelineItem(emailRow()).body_text).toBe('short provider snippet');
    });

    test('non-empty body_text remains primary and still has quoted history stripped', () => {
        const item = projectEmailTimelineItem(emailRow({
            body_text: 'Fresh reply\n\nOn Mon Agent <agent@example.com> wrote:\n> old text',
            body_html: '<p>HTML must not replace plain text</p>',
        }));

        expect(item.body_text).toBe('Fresh reply');
    });
});
