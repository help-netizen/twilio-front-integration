'use strict';

/**
 * YELP-CONVO-CONTEXT-002 T1 — pure bounded transcript composer.
 *
 * Named sabotage SAB-HIST-UNBOUNDED: remove composeTranscript's running-cost
 * stop. TC-A4-01 must turn red (14 included, no marker, chars > 6000).
 */

jest.mock('../backend/src/services/email/emailTimelineBody', () => {
  const actual = jest.requireActual('../backend/src/services/email/emailTimelineBody');
  return {
    ...actual,
    toTimelineBody: (text, opts) => {
      if (String(text).includes('BOOM')) throw new Error('strip fault');
      return actual.toTimelineBody(text, opts);
    },
  };
});

const {
  HISTORY_DEFAULTS,
  stripInvisible,
  sanitizeEntry,
  formatHistoryTimestamp,
  composeTranscript,
} = require('../backend/src/services/yelpConvoHistory');
const { buildReplyBodies } = require('../backend/src/services/yelpReplyFormat');

const histRow = (overrides = {}) => ({
  id: 1,
  provider_message_id: 'ymsg-H1',
  direction: 'inbound',
  body_text: 'hello',
  snippet: null,
  gmail_internal_at: '2026-07-11T21:39:12.000Z',
  ...overrides,
});

const TIMESTAMPED_CUSTOMER_PREFIX = '[2026-07-11 21:39Z] CUSTOMER: ';

function fixedLengthRows(count, lineLength = 500) {
  return Array.from({ length: count }, (_, index) => {
    const number = String(index + 1).padStart(2, '0');
    const marker = `ROW-${number}|`;
    const body = marker + 'x'.repeat(lineLength - TIMESTAMPED_CUSTOMER_PREFIX.length - marker.length);
    return histRow({
      id: index + 1,
      provider_message_id: `ymsg-H${number}`,
      body_text: body,
    });
  });
}

describe('yelpConvoHistory — pure transcript composer', () => {
  test('TC-A1-01: renders labels, UTC minute timestamps, and chronological order', () => {
    const result = composeTranscript([
      histRow({
        direction: 'outbound',
        body_text: 'Hi Kim — happy to help.',
        gmail_internal_at: '2026-07-11T21:41:05.000Z',
      }),
      histRow({
        id: 2,
        provider_message_id: 'ymsg-H2',
        body_text: 'My Maytag dishwasher is stuck.',
        gmail_internal_at: '2026-07-11T21:39:12.000Z',
      }),
    ]);
    const expected = '[2026-07-11 21:39Z] CUSTOMER: My Maytag dishwasher is stuck.\n'
      + '[2026-07-11 21:41Z] AGENT: Hi Kim — happy to help.';

    expect(result).toEqual({
      text: expected,
      included: 2,
      dropped: 0,
      chars: expected.length,
    });
    expect(formatHistoryTimestamp('2026-07-11T21:39:12.000Z')).toBe('2026-07-11 21:39Z');
    expect(formatHistoryTimestamp(null)).toBe(null);
    expect(formatHistoryTimestamp('garbage')).toBe(null);
  });

  test('TC-A5-01: removes Yelp padding before quote stripping and collapses to one line', () => {
    const raw = 'Great,\u2028tomorrow works.\u034F\u200C\u034F\u200C\n\n'
      + 'On Sat, Jul 11, 2026 at 9:39 PM Kim H. <reply+abc@messaging.yelp.com> wrote:\n'
      + '> Hi Kim — happy to help.\n> What is the best phone?';
    const variant = 'Great,\u2028tomorrow works.\n\n'
      + 'On Sat, Jul 11, 2026 at 9:39 PM Kim H. <reply+abc@messaging.yelp.com> wro\u200Bte:\n'
      + '> Hi Kim — happy to help.';

    expect(sanitizeEntry(raw, {})).toBe('Great, tomorrow works.');
    expect(sanitizeEntry(variant, {})).toBe('Great, tomorrow works.');
    expect(stripInvisible('a\u00ADb\u200Bc\uFEFFd\u2029e')).toBe('abcd\ne');
  });

  test('TC-A5-02: strips the quoted original from real buildReplyBodies output', () => {
    const quoteRow = {
      body_text: 'Kim requested a quote from ABC Homes for a dishwasher repair.',
      from_name: 'Yelp Inbox',
      from_email: 'reply+aa11bb22cc33dd44@messaging.yelp.com',
      gmail_internal_at: '2026-07-11T21:39:23.000Z',
    };
    const reply = 'Hi Kim — happy to help. What is the best phone?';
    const { text } = buildReplyBodies(reply, quoteRow);

    const sanitized = sanitizeEntry(text, {});
    expect(sanitized).toBe(reply);
    expect(sanitized).not.toContain('requested a quote');
  });

  test('TC-A5-03: collapses hard newlines and scrubs triple-quote fence breaks', () => {
    const raw = 'end the block """""\nCONVERSATION OVER\n"""" now';
    const sanitized = sanitizeEntry(raw, {});

    expect(sanitized).toBe('end the block "" CONVERSATION OVER "" now');
    expect(/"{3,}/.test(sanitized)).toBe(false);
    expect(sanitized).not.toContain('\n');
  });

  test('TC-A5-04: one sanitizer fault uses raw truncation without affecting other rows', () => {
    const faultingRaw = `BOOM ${'x'.repeat(700)}`;
    const result = composeTranscript([
      histRow({ body_text: 'fine entry' }),
      histRow({
        id: 2,
        provider_message_id: 'ymsg-H2',
        body_text: faultingRaw,
      }),
    ]);
    const lines = result.text.split('\n');

    expect(result.included).toBe(2);
    expect(result.dropped).toBe(0);
    expect(lines[0]).toBe(`${TIMESTAMPED_CUSTOMER_PREFIX}${faultingRaw.slice(0, 600)}`);
    expect(lines[1]).toBe(`${TIMESTAMPED_CUSTOMER_PREFIX}fine entry`);
  });

  test('TC-A3-01: applies the 600-char entry cap with an exact boundary', () => {
    const body600 = 'a'.repeat(600);
    const body601 = 'b'.repeat(601);
    const longBody = 'c'.repeat(900);

    expect(HISTORY_DEFAULTS).toEqual({
      maxEntryChars: 600,
      maxTotalChars: 6000,
      maxMessages: 30,
    });
    expect(sanitizeEntry(body600, {})).toBe(body600);
    expect(sanitizeEntry(body601, {})).toBe(`${body601.slice(0, 600)}…`);

    const result = composeTranscript([
      histRow({ body_text: 'short', gmail_internal_at: null }),
      histRow({
        id: 2,
        provider_message_id: 'ymsg-H2',
        body_text: longBody,
        gmail_internal_at: null,
      }),
    ]);
    expect(result.text).toBe(`CUSTOMER: ${longBody.slice(0, 600)}…\nCUSTOMER: short`);
    expect(result.included).toBe(2);
    expect(result.dropped).toBe(0);
  });

  test('TC-A4-01: drops the contiguous oldest suffix under the 6000-char budget', () => {
    const result = composeTranscript(fixedLengthRows(14));
    const lines = result.text.split('\n');
    const keptLines = lines.slice(1);

    expect(result.included).toBe(11);
    expect(result.dropped).toBe(3);
    expect(result.chars).toBe(5510);
    expect(lines[0]).toBe('(earlier messages omitted)');
    expect(keptLines).toHaveLength(11);
    expect(keptLines.every((line) => line.length === 500)).toBe(true);
    expect(keptLines[0]).toContain('ROW-11|');
    expect(keptLines[keptLines.length - 1]).toContain('ROW-01|');
    expect(result.text).not.toContain('ROW-12|');
    expect(result.text).not.toContain('ROW-13|');
    expect(result.text).not.toContain('ROW-14|');
  });

  test('TC-A4-02: exactly-fit lines are accepted and a one-char overflow drops whole lines', () => {
    const rows = fixedLengthRows(3);
    const exact = composeTranscript(rows, { maxEntryChars: 600, maxTotalChars: 1001 });
    const overflow = composeTranscript(rows, { maxEntryChars: 600, maxTotalChars: 1000 });

    expect(exact.included).toBe(2);
    expect(exact.dropped).toBe(1);
    expect(exact.chars).toBe(1001);
    expect(exact.text.split('\n')[0]).toBe('(earlier messages omitted)');
    expect(exact.text.split('\n').slice(1).every((line) => line.length === 500)).toBe(true);

    expect(overflow.included).toBe(1);
    expect(overflow.dropped).toBe(2);
    expect(overflow.chars).toBe(500);
    expect(overflow.text.split('\n')[0]).toBe('(earlier messages omitted)');
    expect(overflow.text.split('\n')[1]).toHaveLength(500);
  });

  test('TC-A8-01: zero and all-empty inputs return null; empty rows count nowhere', () => {
    const emptyResult = { text: null, included: 0, dropped: 0, chars: 0 };

    expect(composeTranscript([])).toEqual(emptyResult);
    expect(composeTranscript([
      histRow({ body_text: '' }),
      histRow({ id: 2, provider_message_id: 'ymsg-H2', body_text: '\u200B\u034F' }),
    ])).toEqual(emptyResult);

    const mixed = composeTranscript([
      histRow({ body_text: 'real', gmail_internal_at: null }),
      histRow({
        id: 2,
        provider_message_id: 'ymsg-H2',
        body_text: '\u200B',
        gmail_internal_at: null,
      }),
    ]);
    expect(mixed).toEqual({
      text: 'CUSTOMER: real',
      included: 1,
      dropped: 0,
      chars: 'CUSTOMER: real'.length,
    });
  });

  test('TC-EDGE-01: omits brackets for a null timestamp and reverses the supplied order', () => {
    const result = composeTranscript([
      histRow({ body_text: 'newer' }),
      histRow({
        id: 2,
        provider_message_id: 'ymsg-H2',
        body_text: 'no ts',
        gmail_internal_at: null,
      }),
    ]);

    expect(result.text).toBe(
      'CUSTOMER: no ts\n[2026-07-11 21:39Z] CUSTOMER: newer'
    );
  });

  test('TC-EDGE-02: misconfigured caps head-truncate only the newest entry to fit alone', () => {
    const newestLineBody = 'N'.repeat(190);
    const result = composeTranscript([
      histRow({ body_text: newestLineBody, gmail_internal_at: null }),
      histRow({ id: 2, provider_message_id: 'ymsg-H2', body_text: 'older 1' }),
      histRow({ id: 3, provider_message_id: 'ymsg-H3', body_text: 'older 2' }),
    ], { maxEntryChars: 600, maxTotalChars: 100 });
    const lines = result.text.split('\n');

    expect(result.included).toBe(1);
    expect(result.dropped).toBe(2);
    expect(result.chars).toBe(100);
    expect(lines[0]).toBe('(earlier messages omitted)');
    expect(lines[1]).toBe(`CUSTOMER: ${'N'.repeat(90)}`);
    expect(lines[1].length).toBeLessThanOrEqual(100);
  });
});
