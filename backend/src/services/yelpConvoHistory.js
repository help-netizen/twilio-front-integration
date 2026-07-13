'use strict';

const { toTimelineBody } = require('./email/emailTimelineBody');

const HISTORY_DEFAULTS = {
  maxEntryChars: 600,
  maxTotalChars: 6000,
  maxMessages: 30,
};

const INVISIBLE_CHARS = /[\u00AD\u034F\u061C\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/g;
const OMITTED_MARKER = '(earlier messages omitted)';

/**
 * Remove invisible formatting characters used as Yelp padding while preserving
 * Unicode line/paragraph separators as ordinary newlines for later collapsing.
 *
 * @param {*} text
 * @returns {string}
 */
function stripInvisible(text) {
  return String(text || '')
    .replace(/[\u2028\u2029]/g, '\n')
    .replace(INVISIBLE_CHARS, '');
}

/**
 * Project one stored email body to a bounded, single-line transcript entry.
 * This is deliberately fail-safe: a quote-strip fault falls back to the raw
 * body, truncated without any further transformations.
 *
 * @param {*} rawText
 * @param {object} [opts]
 * @param {*} [opts.snippet]
 * @param {number} [maxEntryChars]
 * @returns {string}
 */
function sanitizeEntry(rawText, opts = {}, maxEntryChars = HISTORY_DEFAULTS.maxEntryChars) {
  try {
    const snippet = opts && opts.snippet;
    const projected = toTimelineBody(stripInvisible(rawText), { snippet });
    const oneLine = String(projected || '')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/"{3,}/g, '""');

    if (oneLine.length > maxEntryChars) {
      return `${oneLine.slice(0, maxEntryChars)}…`;
    }
    return oneLine;
  } catch (_err) {
    try {
      return String(rawText || '').slice(0, maxEntryChars);
    } catch (_fallbackErr) {
      return '';
    }
  }
}

/**
 * Format a stored Gmail timestamp in UTC at minute precision.
 *
 * @param {*} gmailInternalAt
 * @returns {string|null}
 */
function formatHistoryTimestamp(gmailInternalAt) {
  if (gmailInternalAt == null || gmailInternalAt === '') return null;
  try {
    const date = gmailInternalAt instanceof Date
      ? gmailInternalAt
      : new Date(gmailInternalAt);
    if (Number.isNaN(date.getTime())) return null;
    return `${date.toISOString().slice(0, 16).replace('T', ' ')}Z`;
  } catch (_err) {
    return null;
  }
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

/**
 * Compose newest-first history rows into a bounded oldest-first transcript.
 * The omitted marker is presentation overhead and is excluded from `chars`.
 *
 * @param {object[]} rowsNewestFirst
 * @param {object} [opts]
 * @param {number} [opts.maxEntryChars]
 * @param {number} [opts.maxTotalChars]
 * @returns {{text:string|null, included:number, dropped:number, chars:number}}
 */
function composeTranscript(rowsNewestFirst, opts = {}) {
  try {
    const options = opts || {};
    const maxEntryChars = positiveInteger(
      options.maxEntryChars,
      HISTORY_DEFAULTS.maxEntryChars
    );
    const maxTotalChars = positiveInteger(
      options.maxTotalChars,
      HISTORY_DEFAULTS.maxTotalChars
    );
    const rows = Array.isArray(rowsNewestFirst) ? rowsNewestFirst : [];
    const renderedLines = [];

    for (const value of rows) {
      const row = value || {};
      const body = sanitizeEntry(row.body_text, { snippet: row.snippet }, maxEntryChars);
      if (body === '') continue;

      const timestamp = formatHistoryTimestamp(row.gmail_internal_at);
      const label = row.direction === 'outbound' ? 'AGENT' : 'CUSTOMER';
      renderedLines.push(`${timestamp ? `[${timestamp}] ` : ''}${label}: ${body}`);
    }

    if (renderedLines.length === 0) {
      return { text: null, included: 0, dropped: 0, chars: 0 };
    }

    const acceptedNewestFirst = [];
    let runningCost = 0;

    for (const line of renderedLines) {
      const nextCost = runningCost + (acceptedNewestFirst.length > 0 ? 1 : 0) + line.length;
      if (nextCost > maxTotalChars) {
        // Pathological knob guard: only the newest line may be truncated to fit
        // when it cannot fit by itself. Defaults make this branch unreachable.
        if (acceptedNewestFirst.length === 0) {
          const truncated = line.slice(0, maxTotalChars);
          acceptedNewestFirst.push(truncated);
          runningCost = truncated.length;
        }
        break;
      }

      acceptedNewestFirst.push(line);
      runningCost = nextCost;
    }

    const included = acceptedNewestFirst.length;
    const dropped = renderedLines.length - included;
    const chronologicalText = acceptedNewestFirst.reverse().join('\n');
    const text = dropped > 0
      ? `${OMITTED_MARKER}\n${chronologicalText}`
      : chronologicalText;

    return {
      text,
      included,
      dropped,
      chars: chronologicalText.length,
    };
  } catch (_err) {
    return { text: null, included: 0, dropped: 0, chars: 0 };
  }
}

module.exports = {
  HISTORY_DEFAULTS,
  stripInvisible,
  sanitizeEntry,
  formatHistoryTimestamp,
  composeTranscript,
};
