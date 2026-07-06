import { formatPhone } from './formatPhone';

/**
 * EMAIL-HTML-RENDER-001 — TASK-EHR-002
 *
 * `linkifyToHtml(text)` — pure string -> string, NO external dependency.
 *
 * Turns plain text into an HTML string where URLs, bare emails, and phone-like
 * sequences become safe `<a target="_blank" rel="noopener noreferrer">` links.
 *
 * SECURITY — escape FIRST: the whole input is HTML-escaped (`& < > " '`) before
 * any `<a>` is wrapped around it. Hostile plain text like `<img onerror=...>` or
 * `<script>` therefore becomes VISIBLE TEXT and can never inject markup. Only
 * after escaping do we wrap URL/email/phone matches, so the wrappers are the only
 * live HTML in the output.
 *
 * The result is meant to be injected via `dangerouslySetInnerHTML` onto a normal
 * (non-shadow) `<p class="whitespace-pre-wrap break-words">`, which preserves the
 * `\n` line breaks — we operate per-line and rejoin with `\n` so newlines survive.
 *
 * Conservative: linkification runs on the ESCAPED text, so `&`, `<`, `>`, `"`,
 * `'` are already entities (`&amp;` etc.) by the time regexes see them and cannot
 * be re-mangled. Malformed fragments (a lone `a@`) are not matched.
 */

function escapeHtml(input: string): string {
    return input
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function attrEscape(url: string): string {
    // Value already comes from HTML-escaped text; quotes/&/<> are entities.
    // href lives in a double-quoted attribute, so this is defense-in-depth.
    return url.replace(/"/g, '&quot;');
}

function anchor(href: string, label: string): string {
    return `<a href="${attrEscape(href)}" target="_blank" rel="noopener noreferrer">${label}</a>`;
}

// Single alternation so each character is consumed once (no overlapping matches):
//   1. absolute URL   http(s)://...
//   2. bare www.      www....
//   3. email          local@domain.tld
//   4. phone          10-15 digit run allowing + ( ) - . and spaces
// NOTE: run against ESCAPED text — hence `&amp;` etc. may appear inside a URL and
// are preserved as-is (we stop a URL match at raw whitespace / `<` boundaries,
// which no longer exist post-escape, so entities inside are safe to keep).
const TOKEN_RE = new RegExp(
    [
        '(https?:\\/\\/[^\\s<]+)', // 1 absolute URL
        '(www\\.[^\\s<]+)', // 2 bare www.
        "([A-Za-z0-9._%+\\-]+@[A-Za-z0-9.\\-]+\\.[A-Za-z]{2,})", // 3 email
        '(\\+?\\d[\\d\\s().\\-]{8,}\\d)', // 4 phone-like (>= 10 chars, digit-bounded)
    ].join('|'),
    'g'
);

// Trailing punctuation that should not be swallowed into a URL/email match.
const TRAILING_PUNCT = /[.,;:!?)\]'"]+$/;

/**
 * Split a trailing-punctuation tail off a matched token so `see http://a.com.`
 * links only `http://a.com` and leaves the `.` as text. Balanced closing paren
 * kept if the URL contains an opening paren (e.g. Wikipedia-style links).
 */
function splitTrailing(token: string, keepBalancedParen: boolean): { core: string; tail: string } {
    const m = TRAILING_PUNCT.exec(token);
    if (!m) return { core: token, tail: '' };
    let tail = m[0];
    let core = token.slice(0, token.length - tail.length);
    if (keepBalancedParen && tail.startsWith(')')) {
        const opens = (core.match(/\(/g) || []).length;
        const closes = (core.match(/\)/g) || []).length;
        if (opens > closes) {
            // Give one ')' back to the URL to balance it.
            core += ')';
            tail = tail.slice(1);
        }
    }
    return { core, tail };
}

function linkifyLine(escapedLine: string): string {
    return escapedLine.replace(
        TOKEN_RE,
        (match, urlAbs?: string, urlWww?: string, email?: string, phone?: string): string => {
            if (urlAbs) {
                const { core, tail } = splitTrailing(urlAbs, true);
                return anchor(core, core) + tail;
            }
            if (urlWww) {
                const { core, tail } = splitTrailing(urlWww, true);
                return anchor(`https://${core}`, core) + tail;
            }
            if (email) {
                const { core, tail } = splitTrailing(email, false);
                return anchor(`mailto:${core}`, core) + tail;
            }
            if (phone) {
                // Require at least 10 digits to avoid linkifying long number runs / IDs.
                const digits = phone.replace(/\D/g, '');
                if (digits.length < 10 || digits.length > 15) return match;
                const display = formatPhone(phone);
                const label = display && display !== '-' ? display : phone;
                return anchor(`tel:${digits}`, label);
            }
            return match;
        }
    );
}

/**
 * Escape plain text, then wrap URL/email/phone matches in safe anchors.
 *
 * @param text  plain text (may contain `\n`, may be null/undefined/empty)
 * @returns     HTML string of the escaped text with safe `<a>` wrappers; `''` on
 *              null/empty input
 */
export function linkifyToHtml(text: string | null | undefined): string {
    if (text == null || text === '') return '';
    // Split on \n so line breaks are preserved for whitespace-pre-wrap rendering;
    // escape each line FIRST, then linkify the escaped text.
    return text
        .split('\n')
        .map((line) => linkifyLine(escapeHtml(line)))
        .join('\n');
}
