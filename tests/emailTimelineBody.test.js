'use strict';

/**
 * Unit suite for the pure quote/thread stripper — EMAIL-TIMELINE-001 §3c.
 * Covers TC-ET-011..018 plus edge cases (earliest-wins, CRLF, passthrough,
 * whitespace/empty, signature preservation, HTML-only fallback).
 *
 * Run:
 *   npx jest --runTestsByPath tests/emailTimelineBody.test.js \
 *     --testPathIgnorePatterns "/node_modules/"
 */

const {
  toTimelineBody,
  htmlToText,
} = require('../backend/src/services/email/emailTimelineBody');

describe('toTimelineBody — quote/thread stripper (EMAIL-TIMELINE-001 §3c)', () => {
  // ── Fixture strings (mirror docs/test-cases/EMAIL-TIMELINE-001.md "Fixtures") ──

  // gmail-on-wrote.txt: new body + `On … wrote:` + `>`-quote + `-- ` signature
  const GMAIL_ON_WROTE = [
    'Sounds good, Tuesday works',
    '',
    'On Mon, Jun 23, 2026 at 9:14 AM Agent Smith <agent@co.com> wrote:',
    '> Can you do Tuesday?',
    '> Let me know.',
    '',
    '-- ',
    'Alice',
  ].join('\n');

  // caret-quoted.txt: new lines + contiguous trailing `>`-quoted block,
  // and one stray mid-sentence `>` that must NOT cut.
  const CARET_QUOTED = [
    'Yes please proceed.',
    'Budget is < 500 so keep it tight.',
    '',
    '> Original request below',
    '> Please confirm budget',
    '> Thanks',
  ].join('\n');

  // outlook-header-block.txt: new body + From:/Sent:/To:/Subject: + quoted prior
  const OUTLOOK_HEADER_BLOCK = [
    'Approved — go ahead.',
    '',
    'From: Agent Smith <agent@co.com>',
    'Sent: Monday, June 23, 2026 9:14 AM',
    'To: Alice <alice@example.com>',
    'Subject: Re: Booking',
    '',
    'Here is the prior message body that should be removed.',
  ].join('\n');

  // original-message.txt: new body + `----- Original Message -----` + quote
  const ORIGINAL_MESSAGE = [
    'Confirmed for Thursday.',
    '',
    '----- Original Message -----',
    'From: Agent Smith',
    'Subject: Re: Booking',
    '',
    'Previous content here.',
  ].join('\n');

  // html-only.html: HTML body with a quoted block (E-8)
  const HTML_ONLY = [
    '<div>Sounds good, Tuesday works</div>',
    '<br>',
    '<div>On Mon, Jun 23 Agent &lt;agent@co.com&gt; wrote:</div>',
    '<blockquote>&gt; Can you do Tuesday?</blockquote>',
  ].join('');

  // ── TC-ET-012: Gmail "On … wrote:" attribution stripped, signature kept ──

  test('TC-ET-012: strips Gmail "On … wrote:" attribution, keeps body + signature', () => {
    const out = toTimelineBody(GMAIL_ON_WROTE);
    expect(out).toBe('Sounds good, Tuesday works\n\n-- \nAlice');
    expect(out).toContain('-- \nAlice'); // signature retained
    expect(out).not.toContain('wrote:');
    expect(out).not.toContain('> Can you do Tuesday?');
  });

  test('TC-ET-012b: tolerates a 2-line wrapped attribution', () => {
    const wrapped = [
      'Works for me.',
      '',
      'On Mon, Jun 23, 2026 at 9:14 AM Agent Smith',
      '<agent@co.com> wrote:',
      '> earlier text',
    ].join('\n');
    expect(toTimelineBody(wrapped)).toBe('Works for me.');
  });

  // ── TC-ET-013: leading `>`-quoted block stripped; stray `>` does not cut ──

  test('TC-ET-013: strips trailing `>`-quoted block, keeps new lines', () => {
    const out = toTimelineBody(CARET_QUOTED);
    expect(out).toBe('Yes please proceed.\nBudget is < 500 so keep it tight.');
    expect(out).not.toContain('> Original request below');
  });

  test('TC-ET-013b: a single stray mid-body `>` does NOT trigger a cut', () => {
    const stray = 'Price is > 100 but < 200.\nThat works for us.';
    expect(toTimelineBody(stray)).toBe('Price is > 100 but < 200.\nThat works for us.');
  });

  // ── TC-ET-014: Outlook From:/Sent:/To: header block stripped ──

  test('TC-ET-014: strips Outlook From:/Sent:/To: header block', () => {
    const out = toTimelineBody(OUTLOOK_HEADER_BLOCK);
    expect(out).toBe('Approved — go ahead.');
    expect(out).not.toContain('From:');
    expect(out).not.toContain('prior message body');
  });

  test('TC-ET-014b: Date: variant of the header block also cuts', () => {
    const body = [
      'See below.',
      '',
      'From: Agent <a@co.com>',
      'Date: Mon, 23 Jun 2026 09:14:00',
      'To: Alice <alice@example.com>',
      '',
      'quoted prior',
    ].join('\n');
    expect(toTimelineBody(body)).toBe('See below.');
  });

  test('TC-ET-014c: a lone "From:" line without Sent+To does NOT cut', () => {
    const body = 'Forwarding the note From: the vendor as requested.\nLet me know.';
    expect(toTimelineBody(body)).toBe(
      'Forwarding the note From: the vendor as requested.\nLet me know.'
    );
  });

  // ── TC-ET-015: "----- Original Message -----" delimiter stripped ──

  test('TC-ET-015: cuts at "----- Original Message -----"', () => {
    const out = toTimelineBody(ORIGINAL_MESSAGE);
    expect(out).toBe('Confirmed for Thursday.');
    expect(out).not.toContain('Original Message');
    expect(out).not.toContain('Previous content');
  });

  test('TC-ET-015b: Outlook underscore divider cuts', () => {
    const body = [
      'Done.',
      '',
      '________________________________',
      'From: Agent',
      'prior content',
    ].join('\n');
    expect(toTimelineBody(body)).toBe('Done.');
  });

  // ── TC-ET-016: signature-only / no-quote body returned unchanged ──

  test('TC-ET-016: no-quote body with signature is returned unchanged', () => {
    const body = 'Thanks for the update!\nTalk soon.\n\n-- \nAlice\nBoston Masters';
    expect(toTimelineBody(body)).toBe(body);
  });

  test('TC-ET-016b: "Sent from my iPhone" is kept (not stripped as signature)', () => {
    const body = 'On my way.\n\nSent from my iPhone';
    expect(toTimelineBody(body)).toBe('On my way.\n\nSent from my iPhone');
  });

  // ── TC-ET-017: quote-only body falls back (never blank) ──

  test('TC-ET-017: quote-only body falls back to snippet', () => {
    const quoteOnly = '> previous message line 1\n> previous message line 2';
    expect(toTimelineBody(quoteOnly, { snippet: 'Re: Booking confirmed' })).toBe(
      'Re: Booking confirmed'
    );
  });

  test('TC-ET-017b: quote-only with no snippet falls back to trimmed original', () => {
    const quoteOnly = '> only a quote here';
    // No snippet → never blank → original trimmed text.
    expect(toTimelineBody(quoteOnly)).toBe('> only a quote here');
  });

  test('TC-ET-017c: attribution-then-quote-only falls back to snippet', () => {
    const body = 'On Mon Agent <a@co.com> wrote:\n> earlier';
    expect(toTimelineBody(body, { snippet: 'snip' })).toBe('snip');
  });

  // ── TC-ET-018: HTML-only → text extracted then stripped ──

  test('TC-ET-018: htmlToText extracts text, then quote-strip removes history', () => {
    const text = htmlToText(HTML_ONLY);
    expect(text).toContain('Sounds good, Tuesday works');
    const out = toTimelineBody(text);
    expect(out).toBe('Sounds good, Tuesday works');
    expect(out).not.toContain('wrote:');
  });

  test('TC-ET-018b: htmlToText strips tags, decodes entities, collapses whitespace', () => {
    expect(htmlToText('<p>Hi&nbsp;&amp;   welcome</p><p>Line two</p>')).toBe(
      'Hi & welcome\nLine two'
    );
  });

  // ── Earliest-wins: multiple delimiters present ──

  test('earliest delimiter wins: attribution before an Outlook block', () => {
    const body = [
      'Top reply.',
      '',
      'On Mon Agent <a@co.com> wrote:',
      '> quoted',
      '',
      'From: someone',
      'Sent: today',
      'To: me',
    ].join('\n');
    expect(toTimelineBody(body)).toBe('Top reply.');
  });

  test('earliest delimiter wins: a `>` run earlier than a later attribution', () => {
    const body = [
      'Reply A.',
      '> quoted run to end',
      '> still quoted',
    ].join('\n');
    // `>` run begins at line 1; that is the earliest boundary.
    expect(toTimelineBody(body)).toBe('Reply A.');
  });

  // ── No-delimiter passthrough (conservative) ──

  test('no-delimiter body is returned trimmed (no over-cutting)', () => {
    const body = 'Just a plain reply.\nNothing quoted at all.';
    expect(toTimelineBody(body)).toBe('Just a plain reply.\nNothing quoted at all.');
  });

  test('trims leading/trailing blank lines and collapses 3+ blanks to 1', () => {
    const body = '\n\n\nFirst line.\n\n\n\nSecond line.\n\n\n';
    expect(toTimelineBody(body)).toBe('First line.\n\nSecond line.');
  });

  // ── CRLF handling ──

  test('CRLF line endings are normalized and stripped correctly', () => {
    const body = 'Sounds good\r\n\r\nOn Mon Agent <a@co.com> wrote:\r\n> earlier\r\n';
    expect(toTimelineBody(body)).toBe('Sounds good');
  });

  test('lone CR line endings are handled', () => {
    const body = 'Hello\r\rOn Mon X <x@x.com> wrote:\r> q';
    expect(toTimelineBody(body)).toBe('Hello');
  });

  // ── Empty / whitespace / bad input (never throws) ──

  test('empty string returns empty string', () => {
    expect(toTimelineBody('')).toBe('');
  });

  test('whitespace-only body returns snippet fallback when provided', () => {
    expect(toTimelineBody('   \n\n\t', { snippet: 'fallback snip' })).toBe('fallback snip');
  });

  test('whitespace-only body with no snippet returns empty string', () => {
    expect(toTimelineBody('   \n\n\t')).toBe('');
  });

  test('non-string input does not throw and returns snippet fallback', () => {
    expect(toTimelineBody(null, { snippet: 's' })).toBe('s');
    expect(toTimelineBody(undefined)).toBe('');
    expect(toTimelineBody(42)).toBe('');
    expect(toTimelineBody({})).toBe('');
  });

  // ── TC-ET-011: purity — input is byte-identical after projection ──

  test('TC-ET-011: does not mutate the input string (byte-identical after call)', () => {
    const original = GMAIL_ON_WROTE;
    const before = String(original);
    toTimelineBody(original);
    expect(original).toBe(before);
  });

  test('TC-ET-011b: opts object is not mutated', () => {
    const opts = { snippet: 'snip' };
    toTimelineBody('> only quote', opts);
    expect(opts).toEqual({ snippet: 'snip' });
  });
});
