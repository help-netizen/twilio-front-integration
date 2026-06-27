'use strict';

/**
 * emailTimelineBody — pure quote/thread stripper for the email timeline projection.
 *
 * Spec: EMAIL-TIMELINE-001 §3c (FR-IN-8, AC-4).
 *
 * Given an email's plain-text body, return ONLY the new message text by cutting
 * the quoted history at the EARLIEST quote-boundary delimiter:
 *   - Gmail/Apple attribution:  `On <…> wrote:`  (tolerant of a 2-line wrap)
 *   - Outlook divider:          `----- Original Message -----`
 *   - Outlook header block:     a `From:` line followed within 4 lines by
 *                               `Sent:`/`Date:` AND `To:`
 *   - Outlook underscore rule:  `________________________________`
 *   - Leading-`>` quoted run:   first line of the first contiguous `^>` run that
 *                               continues to end-of-body (a stray mid-body `>`
 *                               does NOT cut)
 *
 * Decisions (per spec):
 *   - KEEP the author's signature. We do NOT strip `-- `, "Sent from my iPhone",
 *     or contact blocks. Only quoted *history* is removed.
 *   - Trim leading/trailing blank lines; collapse 3+ blank lines to 1.
 *   - If stripping yields empty (the whole body was a quote), fall back to
 *     `opts.snippet` (trimmed), then to the original trimmed text — never blank.
 *   - Conservative: when no delimiter matches, return the input trimmed.
 *   - Never throws.
 *
 * This module is PURE: no IO, no googleapis, no provider/Gmail types. The caller
 * passes plain text. For HTML-only emails the caller may pre-extract text via the
 * exported `htmlToText` helper and pass the result as `rawText`.
 *
 * @module emailTimelineBody
 */

/** Matches a single-line Gmail/Apple attribution: `On <date>, <name> … wrote:` */
const RE_ON_WROTE = /^\s*On\s.+\swrote:\s*$/;
/** First line of a wrapped attribution: `On <date>, <name> <addr>` (no `wrote:` yet). */
const RE_ON_START = /^\s*On\s.+$/;
/** Continuation line that ends a wrapped attribution: `… wrote:` */
const RE_WROTE_END = /wrote:\s*$/;
/** Outlook `----- Original Message -----` divider (case-insensitive, 2+ dashes). */
const RE_ORIGINAL_MESSAGE = /^\s*-{2,}\s*Original Message\s*-{2,}\s*$/i;
/** Outlook underscore divider (a run of 10+ underscores). */
const RE_UNDERSCORE_DIVIDER = /^\s*_{10,}\s*$/;
/** Start of an Outlook quoted-header block. */
const RE_HEADER_FROM = /^\s*From:\s.+/;
const RE_HEADER_SENT = /^\s*(?:Sent|Date):\s/;
const RE_HEADER_TO = /^\s*To:\s/;
/** A quoted line (leading optional whitespace then `>`). */
const RE_QUOTE = /^\s*>/;
/** RFC 3676 signature delimiter line: exactly `--` or `-- ` (optional trailing ws). */
const RE_SIG_DELIM = /^--\s?$/;

/** Fallback truncation length for a never-blank bubble. */
const FALLBACK_MAX = 280;

/**
 * Find the earliest 0-based line index at which quoted history begins, or -1 if
 * none of the delimiters match. The matched line itself and everything after it
 * are discarded by the caller.
 *
 * @param {string[]} lines
 * @returns {number} cut index, or -1
 */
function findCutIndex(lines) {
  let cut = -1;
  const consider = (idx) => {
    if (idx >= 0 && (cut === -1 || idx < cut)) cut = idx;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // 1) Gmail/Apple attribution, single line: `On … wrote:`
    if (RE_ON_WROTE.test(line)) {
      consider(i);
      break; // earliest possible at/after i is i itself; nothing earlier can appear later
    }

    // 1b) Wrapped attribution: `On …` then a following line ending `wrote:`
    // (allow the `wrote:` within the next 1-2 lines to tolerate a hard wrap).
    if (RE_ON_START.test(line) && !RE_WROTE_END.test(line)) {
      for (let j = i + 1; j <= i + 2 && j < lines.length; j++) {
        if (RE_WROTE_END.test(lines[j])) {
          consider(i);
          break;
        }
        // a blank line breaks the wrapped attribution
        if (lines[j].trim() === '') break;
      }
      if (cut === i) break;
    }

    // 2) Outlook `----- Original Message -----`
    if (RE_ORIGINAL_MESSAGE.test(line)) {
      consider(i);
      break;
    }

    // 3) Outlook underscore divider
    if (RE_UNDERSCORE_DIVIDER.test(line)) {
      consider(i);
      break;
    }

    // 4) Outlook header block: `From:` then within 4 lines a `Sent:`/`Date:` AND a `To:`
    if (RE_HEADER_FROM.test(line)) {
      let sawSent = false;
      let sawTo = false;
      for (let j = i + 1; j <= i + 4 && j < lines.length; j++) {
        if (RE_HEADER_SENT.test(lines[j])) sawSent = true;
        if (RE_HEADER_TO.test(lines[j])) sawTo = true;
      }
      if (sawSent && sawTo) {
        consider(i);
        break;
      }
    }
  }

  // 5) Leading-`>` quoted run: the first line of the first contiguous `^>` run
  // that continues to end-of-body. A stray mid-body `>` (run that is followed by
  // non-quote content) does NOT cut. Scan for the earliest qualifying run; if it
  // is earlier than an already-found delimiter, it wins.
  const quoteCut = findTrailingQuoteRunStart(lines);
  consider(quoteCut);

  return cut;
}

/**
 * Index of the first line of the earliest contiguous `>`-run that extends to
 * end-of-body (ignoring trailing blank lines). Returns -1 if no such run exists.
 *
 * A run that is followed by further non-blank, non-quote content is a stray quote
 * and is skipped.
 *
 * @param {string[]} lines
 * @returns {number}
 */
function findTrailingQuoteRunStart(lines) {
  // Determine the last non-blank line index.
  let lastContent = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].trim() !== '') {
      lastContent = i;
      break;
    }
  }
  if (lastContent === -1) return -1; // all blank

  // The trailing block must end in a quoted line to be a quoted history block.
  if (!RE_QUOTE.test(lines[lastContent])) return -1;

  // Walk backwards from lastContent over a contiguous quote run. Blank lines
  // interleaved *within* the trailing quoted block are tolerated (quoted replies
  // often have empty `>` separated by bare blanks), but a non-blank non-quote
  // line terminates the run — its line is real content, so the run starts after.
  let start = lastContent;
  for (let i = lastContent - 1; i >= 0; i--) {
    const t = lines[i];
    if (RE_QUOTE.test(t)) {
      start = i;
    } else if (t.trim() === '') {
      // blank: part of the trailing block only if still bordered by quotes above;
      // keep scanning but don't move `start` onto a blank.
      continue;
    } else {
      // real content above the run → run starts at the last quote we saw.
      break;
    }
  }
  return start;
}

/**
 * Trim leading/trailing blank lines and collapse 3+ consecutive blank lines to 1.
 *
 * @param {string[]} lines
 * @returns {string}
 */
function normalize(lines) {
  // Collapse runs of 3+ blank lines down to a single blank line.
  const collapsed = [];
  let blankRun = 0;
  for (const line of lines) {
    if (line.trim() === '') {
      blankRun++;
      if (blankRun <= 1) collapsed.push('');
    } else {
      blankRun = 0;
      collapsed.push(line);
    }
  }
  // Trim leading/trailing blanks.
  let start = 0;
  let end = collapsed.length - 1;
  while (start <= end && collapsed[start].trim() === '') start++;
  while (end >= start && collapsed[end].trim() === '') end--;
  return collapsed.slice(start, end + 1).join('\n');
}

/**
 * Recover a trailing signature from the discarded (quoted-history) tail.
 *
 * Per spec step 4, the author's signature can sit *after* the quoted history
 * (e.g. body → `On … wrote:` → `>`-quote → `-- `/Alice). When we cut the history
 * we must not lose that signature. Scan the discarded tail for the first RFC 3676
 * signature delimiter (`-- `); if present, return the delimiter and the lines
 * after it, dropping any `>`-quoted lines (those are quoted history, not sig).
 *
 * Returns [] if no signature delimiter is found in the tail.
 *
 * @param {string[]} lines  full (newline-normalized) line array
 * @param {number} cut      index at which quoted history began
 * @returns {string[]} signature block lines (possibly empty)
 */
function recoverSignature(lines, cut) {
  let sigStart = -1;
  for (let i = cut; i < lines.length; i++) {
    if (RE_SIG_DELIM.test(lines[i])) {
      sigStart = i;
      break;
    }
  }
  if (sigStart === -1) return [];
  // Keep the delimiter + following lines, minus quoted-history lines.
  const block = lines.slice(sigStart).filter((l) => !RE_QUOTE.test(l));
  // Trim trailing blanks within the recovered block.
  let end = block.length - 1;
  while (end >= 0 && block[end].trim() === '') end--;
  return block.slice(0, end + 1);
}

/**
 * Minimal HTML→text extraction for the HTML-only fallback (E-8). Strips tags and
 * collapses whitespace; converts `<br>` / block-closers to newlines so the quote
 * stripper still sees line structure. Pure, best-effort — not a full parser.
 *
 * @param {string} html
 * @returns {string}
 */
function htmlToText(html) {
  if (typeof html !== 'string' || html === '') return '';
  let s = html;
  // Drop script/style content entirely.
  s = s.replace(/<(script|style)[\s\S]*?<\/\1>/gi, '');
  // Block boundaries → newline.
  s = s.replace(/<\s*br\s*\/?\s*>/gi, '\n');
  s = s.replace(/<\s*\/\s*(p|div|blockquote|li|tr|h[1-6])\s*>/gi, '\n');
  // Remaining tags → gone.
  s = s.replace(/<[^>]+>/g, '');
  // Decode the handful of entities that matter for text.
  s = s
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
  // Collapse intra-line whitespace but preserve newlines.
  s = s
    .split('\n')
    .map((line) => line.replace(/[ \t\f\v]+/g, ' ').trim())
    .join('\n');
  // Drop leading/trailing blank lines introduced by block boundaries.
  return s.replace(/^\n+/, '').replace(/\n+$/, '');
}

/**
 * Project an email plain-text body to its timeline display body: the new message
 * text with quoted history removed and the signature kept. Pure, never throws.
 *
 * @param {string} rawText  the email's plain-text body (`body_text`).
 * @param {object} [opts]
 * @param {string} [opts.snippet]  provider snippet, used as the first fallback if
 *                                 stripping empties the body.
 * @returns {string} the timeline body (never blank unless every source is empty).
 */
function toTimelineBody(rawText, opts) {
  const snippet = opts && typeof opts.snippet === 'string' ? opts.snippet : '';

  if (typeof rawText !== 'string' || rawText.trim() === '') {
    // Nothing usable in the body → fall back to snippet, else empty string.
    return snippet.trim();
  }

  try {
    // Normalize newlines (handle CRLF / lone CR) without mutating the caller's value.
    const lines = rawText.replace(/\r\n?/g, '\n').split('\n');

    const cut = findCutIndex(lines);
    let kept = cut === -1 ? lines : lines.slice(0, cut);

    // Spec step 4 — keep the signature even when it trails the quoted history:
    // if a `-- ` signature delimiter appears in the discarded tail, recover that
    // signature block (delimiter → end-of-body, minus any quoted lines) and
    // re-append it to the kept region.
    if (cut !== -1) {
      const sig = recoverSignature(lines, cut);
      if (sig.length > 0) kept = kept.concat('', ...sig);
    }

    const result = normalize(kept);

    if (result !== '') return result;

    // Stripping emptied the body (whole thing was a quote) → never blank.
    if (snippet.trim() !== '') return snippet.trim();
    const original = normalize(rawText.replace(/\r\n?/g, '\n').split('\n'));
    if (original.length <= FALLBACK_MAX) return original;
    return `${original.slice(0, FALLBACK_MAX).trimEnd()}…`;
  } catch (_err) {
    // Defensive: never throw. Return a best-effort trimmed input.
    return typeof rawText === 'string' ? rawText.trim() : snippet.trim();
  }
}

module.exports = { toTimelineBody, htmlToText };
