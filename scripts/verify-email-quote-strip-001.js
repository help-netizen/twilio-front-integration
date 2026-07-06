#!/usr/bin/env node
/**
 * EMAIL-QUOTE-STRIP-001 — headless quote-strip verification (TASK-EQS-004).
 *
 * WHY A STANDALONE SCRIPT (not jest): the frontend has NO unit-test runner and no
 * jsdom-jest env installed; `stripEmailQuote` parses via `new DOMParser()` which is
 * a browser global, so the pure transform cannot run under the node-env root jest.
 * This script constructs a jsdom `window`, assigns `global.DOMParser =
 * window.DOMParser`, and runs the ENTIRE detection/guard/near-empty/fail-safe
 * matrix HEADLESS. There is NO backend in this feature, so no backend jest.
 *
 * WHY A PORT (not a require of the shipped .ts): `frontend/src/lib/stripEmailQuote.ts`
 * is TS-ESM and no TS/ESM loader (ts-node/tsx/esbuild) is installed, so Node cannot
 * `require()` it. This script holds a *verbatim CJS port* of stripEmailQuote (same
 * ordered detectors, same attribution regexes mirroring emailTimelineBody.js
 * l.36-40, same near-empty <2+media predicate, same over-strip guard, same
 * fail-safe, idempotent). Because a port can silently drift from what ships, a
 * PARITY GUARD (section `parity`, TC-EQS-P01) reads the .ts source and asserts the
 * load-bearing bits still match (the ordered selectors, the attribution regex
 * family, the <2 threshold + media guard + zero-width set, the guard wording, the
 * fail-safe returns-input idiom). If the .ts drifts in a way the port did NOT
 * mirror, the run FAILs loudly. The port is ONLY a test aid.
 *
 * SABOTAGE (section `sab`, TC-EQS-SAB): the detect assertions are also run against
 * a `html => html` pass-through (no strip). The harness MUST record FAILUREs on the
 * four client cases (Gmail/Apple/Yahoo/Outlook — the quote survives). Then the real
 * port is restored → all green. This proves the matrix is load-bearing.
 *
 * RUNNING (jsdom is NOT in the repo — provide it via NODE_PATH; the scratchpad from
 * the EMAIL-HTML-RENDER-001 run already has jsdom@29.1.1):
 *   NODE_PATH=<scratchpad>/node_modules node scripts/verify-email-quote-strip-001.js
 *   optional: --section=detect|guard|nearempty|attribution|nested|idempotent|style|xss|failsafe|probe|parity|sab|all
 *
 * The script SHIPS in the repo; jsdom is dev/verify-only (never added to any
 * package.json, never bundled). Exit code 0 only when no case FAILs.
 */
'use strict';

const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const STRIP_TS = path.join(ROOT, 'frontend/src/lib/stripEmailQuote.ts');

// ─── jsdom (resolved via NODE_PATH; see header) ──────────────────────────────
let JSDOM;
try {
    ({ JSDOM } = require('jsdom'));
} catch (e) {
    console.error(
        'FATAL: could not load jsdom. It is dev/verify-only and is NOT in the repo.\n' +
        'The scratchpad from the EMAIL-HTML-RENDER-001 run already has jsdom@29.1.1.\n' +
        'Run from the repo root with NODE_PATH pointing at it, e.g.:\n' +
        '  NODE_PATH=<scratchpad>/node_modules node scripts/verify-email-quote-strip-001.js\n' +
        `Underlying error: ${e.message}`
    );
    process.exit(2);
}

// `stripEmailQuote` calls `new DOMParser()` (a browser global, NOT a Node global).
// Inject jsdom's DOMParser so the ported transform runs headless.
const { window: DOM_WINDOW } = new JSDOM('');
global.DOMParser = DOM_WINDOW.DOMParser;

function depVersion(mod) {
    try {
        const pkgPath = require.resolve(`${mod}/package.json`);
        return require(pkgPath).version;
    } catch {
        return 'unknown';
    }
}

// ═════════════════════════════════════════════════════════════════════════════
// CJS PORT of frontend/src/lib/stripEmailQuote.ts  (mirror EXACTLY; see parity)
// ═════════════════════════════════════════════════════════════════════════════

// ─── Attribution regexes — mirror emailTimelineBody.js l.36-40 verbatim. ──────
const RE_ON_WROTE = /^\s*On\s.+\swrote:\s*$/;
const RE_ON_START = /^\s*On\s.+$/;
const RE_WROTE_END = /wrote:\s*$/;

function isAttributionText(text) {
    // Collapse runs of whitespace (incl. newlines) to a single space so a
    // hard-wrapped attribution inside one node still matches the single-line RE.
    const t = text.replace(/\s+/g, ' ').trim();
    if (t === '') return false;
    if (RE_ON_WROTE.test(t)) return true;
    return RE_ON_START.test(t) && RE_WROTE_END.test(t);
}

/** Zero-width chars stripped by the near-empty normalizer (D5): ZWSP, ZWNJ, ZWJ, BOM. */
const ZERO_WIDTH_RE = /[​‌‍﻿]/g;

function elementHasLiveImage(root) {
    const imgs = root.querySelectorAll('img');
    for (let i = 0; i < imgs.length; i++) {
        const img = imgs[i];
        const src = img.getAttribute('src');
        if (src !== null && src.trim() !== '') return true;
        const blanc = img.getAttribute('data-blanc-src');
        if (blanc !== null && blanc.trim() !== '') return true;
    }
    return false;
}

function hasMeaningfulMedia(body) {
    if (elementHasLiveImage(body)) return true;
    if (body.querySelector('table') !== null) return true;
    if (body.querySelector('picture') !== null) return true;
    return false;
}

function normVisibleTextLength(body) {
    const raw = body.textContent == null ? '' : body.textContent;
    const collapsed = raw.replace(ZERO_WIDTH_RE, '').replace(/\s+/g, '');
    return collapsed.length;
}

function outermostMatch(el, selector, body) {
    let top = el;
    let cur = el.parentElement;
    while (cur !== null && cur !== body) {
        if (cur.matches(selector)) top = cur;
        cur = cur.parentElement;
    }
    return top;
}

function bodyLevelAncestor(node, body) {
    let cur = node;
    while (cur.parentNode !== null && cur.parentNode !== body) {
        cur = cur.parentNode;
    }
    return cur;
}

function isWhitespaceOnly(node) {
    if (node.nodeType === 8 /* COMMENT_NODE */) return true;
    if (node.nodeType === 3 /* TEXT_NODE */) {
        return (node.textContent == null ? '' : node.textContent).trim() === '';
    }
    return false;
}

function precedingMeaningfulSibling(node) {
    let prev = node.previousSibling;
    while (prev !== null && isWhitespaceOnly(prev)) {
        prev = prev.previousSibling;
    }
    return prev;
}

function isTrailingToBodyEnd(node, body) {
    let cur = node;
    while (cur !== null && cur !== body) {
        for (let sib = cur.nextSibling; sib !== null; sib = sib.nextSibling) {
            if (sib.nodeType === 3 /* TEXT_NODE */) {
                if ((sib.textContent == null ? '' : sib.textContent).trim() !== '') return false;
            } else if (sib.nodeType === 1 /* ELEMENT_NODE */) {
                const el = sib;
                if ((el.textContent == null ? '' : el.textContent).trim() !== '') return false;
                if (elementHasLiveImage(el)) return false;
                if (el.querySelector('table, picture') !== null) return false;
            }
        }
        cur = cur.parentNode;
    }
    return true;
}

function findBoundary(body) {
    // Row 1: .gmail_quote (Gmail) — HIGH. Outermost match, earliest in doc order.
    const gmail = body.querySelector('.gmail_quote');
    if (gmail !== null) {
        return { node: outermostMatch(gmail, '.gmail_quote', body), checkAttribution: true };
    }

    // Row 2: blockquote[type="cite"] (Apple Mail) — HIGH.
    const cite = body.querySelector('blockquote[type="cite"]');
    if (cite !== null) {
        return { node: outermostMatch(cite, 'blockquote[type="cite"]', body), checkAttribution: true };
    }

    // Row 3a: #appendonsend (Outlook) — HIGH.
    const appendOnSend = body.querySelector('#appendonsend');
    if (appendOnSend !== null) {
        return { node: appendOnSend, checkAttribution: true };
    }

    // Row 4: .yahoo_quoted (Yahoo) — HIGH.
    const yahoo = body.querySelector('.yahoo_quoted');
    if (yahoo !== null) {
        return { node: outermostMatch(yahoo, '.yahoo_quoted', body), checkAttribution: true };
    }

    // Row 3b: Outlook border-top separator — CONSERVATIVE.
    const borderTop = findOutlookBorderTopDiv(body);
    if (borderTop !== null) {
        return { node: borderTop, checkAttribution: false };
    }

    // Row 5: first top-level <blockquote> — LOW / GUARDED.
    const topBlockquote = firstTopLevelBlockquote(body);
    if (topBlockquote !== null) {
        const prev = precedingMeaningfulSibling(topBlockquote);
        const attributedBefore = prev !== null && isAttributionText(prev.textContent == null ? '' : prev.textContent);
        const trailing = isTrailingToBodyEnd(topBlockquote, body);
        if (attributedBefore || trailing) {
            return { node: topBlockquote, checkAttribution: true };
        }
        // guard fails → do NOT cut here; fall through to the text fallback.
    }

    // Row 6: text fallback — an attribution line ("On … wrote:") as a node.
    const attrBoundary = findAttributionTextBoundary(body);
    if (attrBoundary !== null) {
        return { node: attrBoundary, checkAttribution: false };
    }

    return null;
}

const RE_BORDER_TOP_SOLID = /border-top\s*:[^;]*solid/i;
const RE_OUTLOOK_HEADER_RUN = /^\s*(?:From|Sent|To|Subject)\s*:/i;

function findOutlookBorderTopDiv(body) {
    const divs = body.querySelectorAll('div[style]');
    for (let i = 0; i < divs.length; i++) {
        const div = divs[i];
        const style = div.getAttribute('style') == null ? '' : div.getAttribute('style');
        if (!RE_BORDER_TOP_SOLID.test(style)) continue;
        const prev = precedingMeaningfulSibling(div);
        if (prev === null) continue;
        const prevText = prev.textContent == null ? '' : prev.textContent;
        if (RE_OUTLOOK_HEADER_RUN.test(prevText)) {
            return div;
        }
    }
    return null;
}

function firstTopLevelBlockquote(body) {
    for (let child = body.firstElementChild; child !== null; child = child.nextElementSibling) {
        if (child.tagName === 'BLOCKQUOTE') return child;
    }
    return null;
}

function findAttributionTextBoundary(body) {
    const children = [];
    for (let n = body.firstChild; n !== null; n = n.nextSibling) {
        children.push(n);
    }
    for (let i = 0; i < children.length; i++) {
        const node = children[i];
        const text = (node.textContent == null ? '' : node.textContent);
        if (text.trim() === '') continue;

        if (isAttributionText(text)) return node;

        if (RE_ON_START.test(text.trim()) && !RE_WROTE_END.test(text.trim())) {
            for (let j = i + 1; j <= i + 2 && j < children.length; j++) {
                const jt = (children[j].textContent == null ? '' : children[j].textContent);
                if (jt.trim() === '') break;
                if (RE_WROTE_END.test(jt.trim())) return node;
            }
        }
    }
    return null;
}

function cutAtBoundary(boundary, body) {
    const cutNode = bodyLevelAncestor(boundary.node, body);

    if (boundary.checkAttribution) {
        removeAttributionSibling(boundary.node);
        if (cutNode !== boundary.node) {
            removeAttributionSibling(cutNode);
        }
    }

    const toRemove = [];
    let sawCut = false;
    for (let child = body.firstChild; child !== null; child = child.nextSibling) {
        if (child === cutNode) {
            sawCut = true;
            toRemove.push(child);
            continue;
        }
        if (sawCut) toRemove.push(child);
    }
    for (const n of toRemove) {
        if (n.parentNode !== null) n.parentNode.removeChild(n);
    }
}

function removeAttributionSibling(node) {
    const prev = precedingMeaningfulSibling(node);
    if (prev === null) return;
    const prevText = (prev.textContent == null ? '' : prev.textContent);

    if (isAttributionText(prevText)) {
        if (prev.parentNode !== null) prev.parentNode.removeChild(prev);
        return;
    }

    if (RE_WROTE_END.test(prevText.trim()) && !RE_ON_START.test(prevText.trim())) {
        const prev2 = precedingMeaningfulSibling(prev);
        if (prev2 !== null && RE_ON_START.test((prev2.textContent == null ? '' : prev2.textContent).trim())) {
            if (prev.parentNode !== null) prev.parentNode.removeChild(prev);
            if (prev2.parentNode !== null) prev2.parentNode.removeChild(prev2);
        }
    }
}

function reuniteHeadStyleIntoBody(doc) {
    const head = doc.head;
    const body = doc.body;
    if (head === null || body === null) return;
    const nodes = head.querySelectorAll('style, link[rel="stylesheet"]');
    for (let i = nodes.length - 1; i >= 0; i--) {
        body.insertBefore(nodes[i], body.firstChild);
    }
}

function stripEmailQuote(sanitizedHtml) {
    if (sanitizedHtml == null) return '';
    if (sanitizedHtml.trim() === '') return sanitizedHtml;

    try {
        const doc = new DOMParser().parseFromString(sanitizedHtml, 'text/html');
        const body = doc.body;
        if (body === null) return sanitizedHtml;

        reuniteHeadStyleIntoBody(doc);

        const boundary = findBoundary(body);
        if (boundary === null) return sanitizedHtml;

        cutAtBoundary(boundary, body);

        if (normVisibleTextLength(body) < 2 && !hasMeaningfulMedia(body)) {
            return sanitizedHtml;
        }

        return body.innerHTML;
    } catch {
        return sanitizedHtml;
    }
}

// ─── The "Show images" probe regex (OQ-QS-4) — the probe runs REMOTE_IMG_RE over
// the STRIPPED display HTML. Detects a blockable image: a remote/protorel/cid src
// or a neutralized data-blanc-src that awaits "Show images". ────────────────────
const REMOTE_IMG_RE = /<img\b[^>]*\b(?:src\s*=\s*["']?\s*(?:https?:)?\/\/|src\s*=\s*["']?\s*cid:|data-blanc-src\s*=)/i;

// ─── A minimal sanitize stand-in for the idempotent/allowImages case (TC-EQS-I02):
// only flips remote <img src> ↔ data-blanc-src per the allowImages flag. This is NOT
// the real sanitizer — it just supplies the image-state seam the case needs. ──────
function miniSanitize(html, opts) {
    const allow = !!(opts && opts.allowImages);
    if (allow) {
        return html.replace(/data-blanc-src=(["'])(.*?)\1/gi, 'src=$1$2$1');
    }
    return html.replace(/\bsrc=(["'])((?:https?:)?\/\/.*?)\1/gi, 'data-blanc-src=$1$2$1');
}

// ═════════════════════════════════════════════════════════════════════════════
// Assert kit (verbatim from verify-email-html-render-001.js)
// ═════════════════════════════════════════════════════════════════════════════

class CheckError extends Error {}
function check(cond, msg) {
    if (!cond) throw new CheckError(msg);
}
function eq(actual, expected, label) {
    check(String(actual) === String(expected), `${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

const results = [];
function record(id, status, note) {
    results.push({ id, status, note: note || '' });
    const pad = ' '.repeat(Math.max(1, 14 - id.length));
    console.log(`${status} ${id}${pad}${note || ''}`);
}

// Parse a transform output back into a jsdom fragment so we assert STRUCTURALLY
// (querySelector/textContent) rather than on brittle serialized-string order.
function frag(html) {
    const d = new JSDOM(`<!doctype html><body>${html}</body>`);
    return d.window.document.body;
}
function txt(body) {
    return (body.textContent == null ? '' : body.textContent);
}

// ═════════════════════════════════════════════════════════════════════════════
// Fixtures (crafted per spec shapes)
// ═════════════════════════════════════════════════════════════════════════════

const GMAIL = '<div>new reply here</div><div dir="ltr" class="gmail_attr">On Mon, Jul 6, 2026, Jane <j@x.io> wrote:</div><div class="gmail_quote"><blockquote type="cite">prior thread text</blockquote></div>';
const APPLE = '<div>my new answer</div><div>On Jul 6, 2026, at 09:00, Bob <b@x.io> wrote:</div><blockquote type="cite">quoted apple history</blockquote>';
const YAHOO = '<div>yahoo new reply</div><div class="yahoo_quoted">quoted yahoo history</div>';
const OUTLOOK = '<div>outlook new reply</div><div id="appendonsend"></div><div>From: Bob<br>Sent: today<br>quoted outlook history</div>';
const NOQUOTE = '<div>Fresh lead email. <a href="https://x.io">Reply</a></div>';
const MIDBLOCK = '<div>As you said:</div><blockquote>an inline quotation</blockquote><div>here is my actual reply after it</div>';
const TRAILBLOCK = '<div>new reply text</div><div>On Jul 6, 2026, Sam <s@x.io> wrote:</div><blockquote>trailing history block</blockquote>';
const ALLQUOTE = '<div class="gmail_quote"><blockquote>the entire forwarded thread, nothing new above</blockquote></div>';
const ATTRONLY = '<div>On Jul 6, 2026, Ann <a@x.io> wrote:</div><blockquote>quoted history only, no new text</blockquote>';
const IMGONLY = '<div><img data-blanc-src="https://cdn.x/screenshot.png"></div><div class="gmail_quote"><blockquote>quoted history</blockquote></div>';
const TEXTFALLBACK = '<div>my reply</div><div>On Jul 6, 2026, Kim <k@x.io> wrote:</div><div>bare quoted line 1</div><div>bare quoted line 2</div>';
const STYLED = '<style>.reply{color:#333}</style><div class="reply">new reply</div><div class="gmail_quote"><blockquote>history</blockquote></div>';
const NESTED = '<div>newest reply</div><div>On Mon, Jul 6, 2026, A <a@x.io> wrote:</div><div class="gmail_quote"><blockquote>level-1 <div>On Sun, Jul 5, 2026, B <b@x.io> wrote:</div><div class="gmail_quote"><blockquote>level-2 <div>On Sat, Jul 4, 2026, C <c@x.io> wrote:</div><blockquote type="cite">level-3</blockquote></blockquote></div></blockquote></div>';
// XSSQUOTE: an ALREADY-SANITIZED hostile shape (script neutralized to a text node,
// onerror stripped, form removed, javascript: href nulled, remote src→data-blanc-src)
// + a trailing .gmail_quote. Mirrors the parent AC-2 output posture. No live vectors.
const XSSQUOTE = '<div>reply body &lt;script&gt;alert(1)&lt;/script&gt;</div><img data-blanc-src="https://track/x.gif"><a>was javascript link</a><div class="gmail_quote"><blockquote>quoted history</blockquote></div>';

// ═════════════════════════════════════════════════════════════════════════════
// Section: detect  (the detection matrix — one case per client boundary)
// Parameterized on the strip fn so the SAME battery runs against the real port AND
// (in `sab`) against a pass-through.
// ═════════════════════════════════════════════════════════════════════════════

const DETECT = {
    D01(strip) { // Gmail .gmail_quote + gmail_attr attribution → both removed
        const b = frag(strip(GMAIL));
        check(b.querySelector('.gmail_quote') === null, 'D01: .gmail_quote must be removed');
        check(b.querySelector('.gmail_attr') === null, 'D01: preceding .gmail_attr attribution must be removed (OQ-QS-A)');
        check(/new reply here/.test(txt(b)), 'D01: new reply must survive');
        check(!/prior thread text/.test(txt(b)), 'D01: quoted history must be gone');
        check(!/wrote:/.test(txt(b)), 'D01: attribution "wrote:" must be gone');
    },
    D02(strip) { // Apple blockquote[type="cite"] + attribution → stripped
        const b = frag(strip(APPLE));
        check(b.querySelector('blockquote[type="cite"]') === null, 'D02: blockquote[type=cite] must be removed');
        check(/my new answer/.test(txt(b)), 'D02: new reply must survive');
        check(!/quoted apple history/.test(txt(b)), 'D02: quoted history must be gone');
        check(!/wrote:/.test(txt(b)), 'D02: attribution must be removed');
    },
    D03(strip) { // Yahoo .yahoo_quoted → stripped
        const b = frag(strip(YAHOO));
        check(b.querySelector('.yahoo_quoted') === null, 'D03: .yahoo_quoted must be removed');
        check(/yahoo new reply/.test(txt(b)), 'D03: new reply must survive');
        check(!/quoted yahoo history/.test(txt(b)), 'D03: quoted history must be gone');
    },
    D04(strip) { // Outlook #appendonsend → stripped
        const b = frag(strip(OUTLOOK));
        check(b.querySelector('#appendonsend') === null, 'D04: #appendonsend must be removed');
        check(/outlook new reply/.test(txt(b)), 'D04: new reply must survive');
        check(!/quoted outlook history/.test(txt(b)), 'D04: quoted history must be gone');
    },
    D05(strip) { // no boundary → passthrough byte-identical (no-op)
        const out = strip(NOQUOTE);
        eq(out, NOQUOTE, 'D05: no-boundary output must be byte-identical to input');
    },
    D06(strip) { // stray border-top div WITHOUT a From: header run → NOT cut
        const input = '<div>reply</div><div style="border-top:1px solid #ccc">not a header, just a rule</div><div>more reply</div>';
        const out = strip(input);
        eq(out, input, 'D06: stray border-top (no header run) must NOT be cut (output === input)');
    },
};

// ═════════════════════════════════════════════════════════════════════════════
// Section: guard  (over-strip guard — row 5)
// ═════════════════════════════════════════════════════════════════════════════

const GUARD = {
    G01() { // mid-body <blockquote> with content after → KEPT
        const out = stripEmailQuote(MIDBLOCK);
        const b = frag(out);
        check(b.querySelector('blockquote') !== null, 'G01: mid-body <blockquote> must be KEPT');
        check(/an inline quotation/.test(txt(b)), 'G01: the inline quotation text must survive');
        check(/here is my actual reply after it/.test(txt(b)), 'G01: the reply-after must survive');
        eq(out, MIDBLOCK, 'G01: output === input (nothing stripped)');
    },
    G02() { // bare trailing <blockquote> + preceding attribution → stripped
        const b = frag(stripEmailQuote(TRAILBLOCK));
        check(b.querySelector('blockquote') === null, 'G02: trailing <blockquote> must be removed');
        check(/new reply text/.test(txt(b)), 'G02: reply must survive');
        check(!/trailing history block/.test(txt(b)), 'G02: quoted history must be gone');
        check(!/wrote:/.test(txt(b)), 'G02: attribution removed');
    },
    G03() { // bare trailing <blockquote>, NO attribution → stripped via trailing arm
        const b = frag(stripEmailQuote('<div>reply</div><blockquote>trailing quoted history</blockquote>'));
        check(b.querySelector('blockquote') === null, 'G03: bare trailing <blockquote> must be removed (guard b)');
        check(/reply/.test(txt(b)), 'G03: reply must survive');
        check(!/trailing quoted history/.test(txt(b)), 'G03: quoted history must be gone');
    },
};

// ═════════════════════════════════════════════════════════════════════════════
// Section: nearempty  (D5 predicate)
// ═════════════════════════════════════════════════════════════════════════════

const NEAREMPTY = {
    N01() { // all-quote bare forward → near-empty → returns FULL input
        const out = stripEmailQuote(ALLQUOTE);
        eq(out, ALLQUOTE, 'N01: all-quote → near-empty → FULL input returned (=== input)');
        check(/the entire forwarded thread/.test(txt(frag(out))), 'N01: content still present (never blank)');
    },
    N02() { // attribution-only → near-empty → returns FULL
        const out = stripEmailQuote(ATTRONLY);
        eq(out, ATTRONLY, 'N02: attribution-only → near-empty → FULL input returned');
        check(/quoted history only/.test(txt(frag(out))), 'N02: content still present');
    },
    N03() { // image-only reply → KEPT (media guard, D5 cond 2 fails)
        const out = stripEmailQuote(IMGONLY);
        const b = frag(out);
        check(b.querySelector('.gmail_quote') === null, 'N03: quote removed');
        check(b.querySelector('img[data-blanc-src]') !== null, 'N03: image-only reply KEPT (media guard)');
        check(!/quoted history/.test(txt(b)), 'N03: quoted history gone');
        // data: variant kept the same way
        const dataVariant = '<div><img src="data:image/png;base64,iVBOR"></div><div class="gmail_quote"><blockquote>quoted history</blockquote></div>';
        const bd = frag(stripEmailQuote(dataVariant));
        check(bd.querySelector('img[src^="data:"]') !== null, 'N03: data: image reply KEPT too');
        check(bd.querySelector('.gmail_quote') === null, 'N03: quote gone in data: variant');
    },
    N04() { // zero-width-only text after strip → near-empty → FULL input
        const input = '<div>​‌﻿</div><div class="gmail_quote"><blockquote>all history</blockquote></div>';
        const out = stripEmailQuote(input);
        eq(out, input, 'N04: zero-width-only kept text → near-empty → FULL input returned');
    },
    N05() { // empty marker + real reply → marker removed, reply keeps bubble
        const v1 = stripEmailQuote('<div>real reply that stays</div><div class="gmail_quote"><blockquote></blockquote></div>');
        const b1 = frag(v1);
        check(b1.querySelector('.gmail_quote') === null, 'N05: empty marker removed');
        check(/real reply that stays/.test(txt(b1)), 'N05: reply text survives (D5 not triggered)');
        // variant 2: only the empty marker → near-empty → FULL input
        const onlyMarker = '<div class="gmail_quote"><blockquote></blockquote></div>';
        eq(stripEmailQuote(onlyMarker), onlyMarker, 'N05: only-empty-marker → near-empty → FULL input');
    },
};

// ═════════════════════════════════════════════════════════════════════════════
// Section: attribution  (text-fallback row 6 + OQ-QS-A shapes)
// ═════════════════════════════════════════════════════════════════════════════

const ATTRIBUTION = {
    A01() { // attribution line, no <blockquote> after → text-fallback cut
        const b = frag(stripEmailQuote(TEXTFALLBACK));
        check(/my reply/.test(txt(b)), 'A01: reply must survive');
        check(!/bare quoted line 1/.test(txt(b)), 'A01: quoted line 1 gone');
        check(!/bare quoted line 2/.test(txt(b)), 'A01: quoted line 2 gone');
        check(!/wrote:/.test(txt(b)), 'A01: attribution gone');
    },
    A02() { // bare `wrote:` WITHOUT `On …` → does NOT cut (negative)
        const input = '<div>He wrote: a great review, and here is the rest of my message.</div>';
        eq(stripEmailQuote(input), input, 'A02: bare "wrote:" (no On… shape) must NOT cut (=== input)');
    },
    A03() { // attribution as 1-2-line hard wrap inside ONE node → should be matched+removed (OQ-QS-A)
        // Email addr HTML-escaped (&lt;&gt;) = the realistic sanitized form, so the ONLY
        // thing that could defeat the match is the literal \n wrap (isolated cause).
        const input = '<div>reply</div><div class="gmail_attr">On Mon, Jul 6, 2026 at 9:00 AM\nJane Doe &lt;jane@x.io&gt; wrote:</div><div class="gmail_quote"><blockquote>history</blockquote></div>';
        const b = frag(stripEmailQuote(input));
        // The boundary (.gmail_quote) is cut AND the collapsed-wrap attribution is removed.
        check(b.querySelector('.gmail_quote') === null, 'A03: quote removed (boundary cut works)');
        check(/reply/.test(txt(b)), 'A03: reply survives');
        check(!/history/.test(txt(b)), 'A03: history gone');
        // FIXED (was A03 GAP): the collapsed-wrap attribution node is now removed.
        // isAttributionText previously fed the WHOLE node textContent (incl. the literal
        // \n) to /^\s*On\s.+$/ + /wrote:\s*$/ — `.` has no /s flag and `$` no /m flag, so
        // `.+` could not cross the newline. The fix normalizes internal whitespace
        // (`text.replace(/\s+/g,' ')`) BEFORE the single-line regexes, the DOM-side
        // equivalent of emailTimelineBody.js splitting on \n per line.
        check(b.querySelector('.gmail_attr') === null, 'A03: collapsed-wrap attribution node removed (internal \\n normalized before the single-line On…wrote: RE)');
    },
    A04() { // attribution split across two sibling nodes → both removed
        const input = '<div>reply</div><div>On Mon, Jul 6, 2026 at 9:00 AM</div><div>Jane Doe &lt;jane@x.io&gt; wrote:</div><blockquote>history</blockquote>';
        const b = frag(stripEmailQuote(input));
        check(b.querySelector('blockquote') === null, 'A04: blockquote removed');
        check(/reply/.test(txt(b)), 'A04: reply survives');
        check(!/On Mon, Jul 6/.test(txt(b)), 'A04: On… wrap line removed');
        check(!/wrote:/.test(txt(b)), 'A04: …wrote: wrap line removed');
        check(!/history/.test(txt(b)), 'A04: history gone');
    },
    A05() { // preceding sibling is NOT attribution → left in place (under-reach)
        const input = '<div>my genuine reply sentence that must survive</div><div class="gmail_quote"><blockquote>history</blockquote></div>';
        const b = frag(stripEmailQuote(input));
        check(b.querySelector('.gmail_quote') === null, 'A05: quote removed');
        check(/my genuine reply sentence that must survive/.test(txt(b)), 'A05: real reply sibling KEPT (not walked into)');
        check(!/history/.test(txt(b)), 'A05: history gone');
    },
};

// ═════════════════════════════════════════════════════════════════════════════
// Section: nested  (earliest/outermost cut)
// ═════════════════════════════════════════════════════════════════════════════

const NESTED_SEC = {
    NE01() { // 3-deep nested → single outermost cut, zero levels survive
        const b = frag(stripEmailQuote(NESTED));
        eq(b.querySelectorAll('.gmail_quote').length, 0, 'NE01: zero .gmail_quote survive');
        eq(b.querySelectorAll('blockquote').length, 0, 'NE01: zero <blockquote> survive');
        check(/newest reply/.test(txt(b)), 'NE01: newest reply survives');
        check(!/level-1/.test(txt(b)) && !/level-2/.test(txt(b)) && !/level-3/.test(txt(b)), 'NE01: no quoted level leaks');
    },
    NE02() { // .gmail_quote inside a top-level <blockquote> → outermost/earliest cut
        const input = '<div>reply</div><div>On Mon, Jul 6, 2026, X <x@x.io> wrote:</div><blockquote>outer <div class="gmail_quote"><blockquote>inner history</blockquote></div></blockquote>';
        const b = frag(stripEmailQuote(input));
        check(/reply/.test(txt(b)), 'NE02: reply survives');
        check(!/outer/.test(txt(b)), 'NE02: outer quote gone');
        check(!/inner history/.test(txt(b)), 'NE02: inner history gone');
    },
};

// ═════════════════════════════════════════════════════════════════════════════
// Section: idempotent
// ═════════════════════════════════════════════════════════════════════════════

const IDEMPOTENT = {
    I01() { // strip(strip(x)) === strip(x) for each shape
        const fixtures = { GMAIL, APPLE, YAHOO, OUTLOOK, NESTED, MIDBLOCK, NOQUOTE, ALLQUOTE };
        for (const [name, x] of Object.entries(fixtures)) {
            const once = stripEmailQuote(x);
            const twice = stripEmailQuote(once);
            eq(twice, once, `I01[${name}]: strip(strip(x)) must equal strip(x)`);
        }
    },
    I02() { // re-strip after allowImages re-sanitize keeps reply stripped
        const RAW = '<div>reply <img src="https://cdn/keep.png"></div><div class="gmail_quote"><blockquote><img src="https://track/x.gif">quoted</blockquote></div>';
        const s1 = stripEmailQuote(miniSanitize(RAW, { allowImages: false }));
        const s2 = stripEmailQuote(miniSanitize(RAW, { allowImages: true }));
        const b1 = frag(s1);
        const b2 = frag(s2);
        check(b1.querySelector('.gmail_quote') === null, 'I02: history gone with images OFF');
        check(b2.querySelector('.gmail_quote') === null, 'I02: history STILL gone with images ON');
        check(b1.querySelector('img[data-blanc-src]') !== null, 'I02: OFF state has neutralized kept-reply img');
        check(b2.querySelector('img[src="https://cdn/keep.png"]') !== null, 'I02: ON state reveals kept-reply img src');
        check(!/quoted/.test(txt(b2)), 'I02: quoted history does not reappear on image enable');
    },
};

// ═════════════════════════════════════════════════════════════════════════════
// Section: style  (OQ-QS-B serialize fidelity)
// ═════════════════════════════════════════════════════════════════════════════

const STYLE = {
    S01() { // body-level <style> preceding the quote should survive (AC-13 / OQ-QS-B)
        const out = stripEmailQuote(STYLED);
        const b = frag(out);
        // The quote is stripped AND the leading <style> is preserved.
        check(b.querySelector('.gmail_quote') === null, 'S01: quote removed (boundary cut works)');
        check(/new reply/.test(txt(b)), 'S01: reply survives');
        check(!/history/.test(txt(b)), 'S01: history gone');
        // FIXED (was S01 DEFECT): a leading body-level <style> that PRECEDES the quote
        // now survives. stripEmailQuote re-parses the sanitized string with its OWN
        // `new DOMParser().parseFromString(str,'text/html')`; the HTML5 tree builder
        // HOISTS a LEADING <style> into <head>, and the module serializes
        // `body.innerHTML` (head excluded). The fix (reuniteHeadStyleIntoBody) moves any
        // head <style>/<link rel=stylesheet> back to the TOP of <body> BEFORE the
        // cut/serialize, restoring the AC-13/OQ-QS-B fidelity promise.
        check(b.querySelector('style') !== null, `S01: leading <style> preserved through the cut/serialize (AC-13/OQ-QS-B). out=${JSON.stringify(out)}`);
    },
    S02() { // <style> INSIDE the removed quote goes away with the quote
        const input = '<div class="reply">reply</div><div class="gmail_quote"><style>.q{color:red}</style><blockquote>history</blockquote></div>';
        const b = frag(stripEmailQuote(input));
        check(b.querySelector('style') === null, 'S02: quote-embedded <style> removed with quote');
        check(/reply/.test(txt(b)), 'S02: reply survives');
        check(!/history/.test(txt(b)), 'S02: history gone');
    },
};

// ═════════════════════════════════════════════════════════════════════════════
// Section: xss  (XSS-neutrality — strip only removes, never adds)
// Parameterized on the strip fn (X01) so `sab` can prove the quote-removal half.
// ═════════════════════════════════════════════════════════════════════════════

function attrPairs(body) {
    // multiset of (tagName, attrName) pairs, order-independent, as a sorted list.
    const pairs = [];
    for (const el of body.querySelectorAll('*')) {
        for (const a of el.attributes) {
            pairs.push(`${el.tagName}|${a.name.toLowerCase()}`);
        }
    }
    return pairs.sort();
}

const XSS = {
    X01(strip) { // strip on already-sanitized hostile sample → quote gone AND nothing reintroduced
        const b = frag(strip(XSSQUOTE));
        check(b.querySelector('script') === null, 'X01: no <script> present');
        check(b.querySelector('form') === null, 'X01: no <form> present');
        check(b.querySelector('iframe') === null, 'X01: no <iframe> present');
        const noHandlers = [...b.querySelectorAll('*')].every(el => ![...el.attributes].some(a => /^on/i.test(a.name)));
        check(noHandlers, 'X01: no on* handler attribute present');
        const noBadHref = [...b.querySelectorAll('a')].every(a => {
            const h = a.getAttribute('href');
            return h === null || !/^\s*(?:javascript|data):/i.test(h);
        });
        check(noBadHref, 'X01: no javascript:/data: href present');
        check(b.querySelector('.gmail_quote') === null, 'X01: quote stripped');
    },
    X02() { // output (tag,attr) multiset ⊆ input multiset for each fixture
        for (const [name, x] of Object.entries({ GMAIL, MIDBLOCK, STYLED, XSSQUOTE })) {
            const inPairs = attrPairs(frag(x));
            const outPairs = attrPairs(frag(stripEmailQuote(x)));
            // every output pair must be accountable in the input multiset
            const inCounts = new Map();
            for (const p of inPairs) inCounts.set(p, (inCounts.get(p) || 0) + 1);
            for (const p of outPairs) {
                const c = inCounts.get(p) || 0;
                check(c > 0, `X02[${name}]: output introduced (tag,attr) not in input: ${p}`);
                inCounts.set(p, c - 1);
            }
        }
    },
};

// ═════════════════════════════════════════════════════════════════════════════
// Section: failsafe
// ═════════════════════════════════════════════════════════════════════════════

const FAILSAFE = {
    F01() { // forced throw inside transform → returns INPUT unchanged, never throws
        const realDOMParser = global.DOMParser;
        // Monkeypatch DOMParser to a ctor whose parseFromString throws.
        function ThrowingParser() {}
        ThrowingParser.prototype.parseFromString = function () { throw new Error('forced parse failure'); };
        global.DOMParser = ThrowingParser;
        let out;
        let threw = false;
        try {
            out = stripEmailQuote(GMAIL);
        } catch (e) {
            threw = true;
        } finally {
            global.DOMParser = realDOMParser; // restore
        }
        check(!threw, 'F01: stripEmailQuote must NOT throw on forced parse failure');
        eq(out, GMAIL, 'F01: fail-safe must return the INPUT unchanged (never "", never partial)');
    },
    F02() { // empty / degenerate input → returned as-is, no crash
        eq(stripEmailQuote(''), '', 'F02: "" → ""');
        eq(stripEmailQuote(null), '', 'F02: null → ""');
        eq(stripEmailQuote(undefined), '', 'F02: undefined → ""');
        eq(stripEmailQuote('   '), '   ', 'F02: whitespace-only → unchanged');
        eq(stripEmailQuote('<!-- only a comment -->'), '<!-- only a comment -->', 'F02: comment-only → unchanged (no boundary)');
    },
};

// ═════════════════════════════════════════════════════════════════════════════
// Section: probe  (OQ-QS-4 "Show images" probe logic on the stripped string)
// ═════════════════════════════════════════════════════════════════════════════

const PROBE = {
    PR01() { // remote image ONLY inside quoted history → probe string has no blockable image
        const stripped = stripEmailQuote('<div>text reply, no image</div><div class="gmail_quote"><blockquote><img data-blanc-src="https://track/x.gif"></blockquote></div>');
        eq(REMOTE_IMG_RE.test(stripped), false, 'PR01: probe FALSE — the only remote image was in the removed quote');
    },
    PR02() { // remote image inside the KEPT reply → probe string has a blockable image
        const stripped = stripEmailQuote('<div>reply <img data-blanc-src="https://cdn/keep.png"></div><div class="gmail_quote"><blockquote><img data-blanc-src="https://track/x.gif"></blockquote></div>');
        eq(REMOTE_IMG_RE.test(stripped), true, 'PR02: probe TRUE — kept-reply image remains blockable');
    },
};

// ═════════════════════════════════════════════════════════════════════════════
// PARITY GUARD (TC-EQS-P01): the CJS port must still mirror the shipped .ts on the
// load-bearing bits. Reads the TS source and asserts each token is present. If the
// TS drifted in a way the port did not mirror, FAIL loudly.
// ═════════════════════════════════════════════════════════════════════════════

function runParity() {
    const s = fs.readFileSync(STRIP_TS, 'utf8');
    const norm = (x) => x.replace(/\s+/g, '');

    // Ordered selector literals (rows 1-4 + the top-level blockquote scan).
    check(s.includes("'.gmail_quote'"), 'PARITY: .ts uses selector .gmail_quote (row 1)');
    check(s.includes('\'blockquote[type="cite"]\''), 'PARITY: .ts uses selector blockquote[type="cite"] (row 2)');
    check(s.includes("'#appendonsend'"), 'PARITY: .ts uses selector #appendonsend (row 3a)');
    check(s.includes("'.yahoo_quoted'"), 'PARITY: .ts uses selector .yahoo_quoted (row 4)');
    check(/tagName\s*===\s*'BLOCKQUOTE'/.test(s), 'PARITY: .ts scans top-level BLOCKQUOTE (row 5)');

    // Attribution regex family (mirrors emailTimelineBody.js l.36-40).
    check(norm(s).includes(norm('/^\\s*On\\s.+\\swrote:\\s*$/')), 'PARITY: .ts RE_ON_WROTE (single-line attribution) matches port');
    check(norm(s).includes(norm('/^\\s*On\\s.+$/')), 'PARITY: .ts RE_ON_START (wrap start) matches port');
    check(norm(s).includes(norm('/wrote:\\s*$/')), 'PARITY: .ts RE_WROTE_END (wrap end) matches port');

    // A03 fix: isAttributionText collapses internal whitespace (incl. \n) to a single
    // space BEFORE the single-line regexes, so a collapsed-wrap attribution matches.
    check(norm(s).includes(norm("text.replace(/\\s+/g, ' ')")), 'PARITY: .ts isAttributionText normalizes whitespace (A03 collapsed-wrap fix) matching port');

    // Near-empty rule: the < 2 threshold + the media guard + the zero-width set.
    check(/normVisibleTextLength\(\s*body\s*\)\s*<\s*2/.test(s), 'PARITY: .ts near-empty uses the < 2 visible-text threshold');
    check(/&&\s*!hasMeaningfulMedia\(\s*body\s*\)/.test(s), 'PARITY: .ts near-empty ANDs the media guard');
    check(s.includes("getAttribute('data-blanc-src')"), 'PARITY: .ts media guard checks data-blanc-src');
    check(/querySelector\('table'\)/.test(s), 'PARITY: .ts media guard checks <table>');
    check(/querySelector\('picture'\)/.test(s), 'PARITY: .ts media guard checks <picture>');
    check(s.includes('​') && s.includes('‌') && s.includes('‍') && s.includes('﻿'), 'PARITY: .ts zero-width set includes ZWSP/ZWNJ/ZWJ/BOM');

    // Over-strip guard wording (row 5 stripped only if attribution-preceded OR trailing).
    check(/attributedBefore\s*\|\|\s*trailing/.test(s), 'PARITY: .ts row-5 guard = attributedBefore || trailing');
    check(/isTrailingToBodyEnd/.test(s), 'PARITY: .ts has the trailing-block guard helper');

    // S01 fix: leading head-hoisted <style>/<link rel=stylesheet> reunited into body
    // BEFORE the cut/serialize so a leading author <style> survives (OQ-QS-B/AC-13).
    check(/reuniteHeadStyleIntoBody/.test(s), 'PARITY: .ts has the reuniteHeadStyleIntoBody helper (S01 leading-<style> fix)');
    check(norm(s).includes(norm('\'style, link[rel="stylesheet"]\'')), 'PARITY: .ts reunites <style> + stylesheet <link> from head matching port');
    check(/body\.insertBefore\(\s*nodes\[i\]\s*,\s*body\.firstChild\s*\)/.test(s), 'PARITY: .ts prepends reunited style to body top preserving order');

    // Fail-safe: try … catch … return the INPUT (sanitizedHtml), never "" / raw.
    check(/try\s*\{/.test(s) && /catch/.test(s), 'PARITY: .ts wraps the body in try/catch');
    check(/catch\s*\{[\s\S]*?return\s+sanitizedHtml\s*;[\s\S]*?\}/.test(s), 'PARITY: .ts fail-safe returns sanitizedHtml (the input)');
    check(/if\s*\(\s*sanitizedHtml\s*==\s*null\s*\)\s*return\s*''\s*;/.test(s), 'PARITY: .ts null/undefined → ""');

    // The near-empty and no-boundary arms return the INPUT, not '' — never a blank bubble.
    check((s.match(/return\s+sanitizedHtml\s*;/g) || []).length >= 3, 'PARITY: .ts returns the input on no-boundary AND near-empty AND fail-safe');
}

// ═════════════════════════════════════════════════════════════════════════════
// Case registry
// ═════════════════════════════════════════════════════════════════════════════

const CASES = [
    // detect
    { id: 'D01', section: 'detect', title: 'Gmail .gmail_quote + attribution → both removed', fn: () => DETECT.D01(stripEmailQuote) },
    { id: 'D02', section: 'detect', title: 'Apple blockquote[type=cite] + attribution → stripped', fn: () => DETECT.D02(stripEmailQuote) },
    { id: 'D03', section: 'detect', title: 'Yahoo .yahoo_quoted → stripped', fn: () => DETECT.D03(stripEmailQuote) },
    { id: 'D04', section: 'detect', title: 'Outlook #appendonsend → stripped', fn: () => DETECT.D04(stripEmailQuote) },
    { id: 'D05', section: 'detect', title: 'no boundary → passthrough byte-identical', fn: () => DETECT.D05(stripEmailQuote) },
    { id: 'D06', section: 'detect', title: 'stray border-top (no header run) → NOT cut', fn: () => DETECT.D06(stripEmailQuote) },
    // guard
    { id: 'G01', section: 'guard', title: 'mid-body <blockquote> + content-after → KEPT', fn: () => GUARD.G01() },
    { id: 'G02', section: 'guard', title: 'trailing <blockquote> + attribution → stripped', fn: () => GUARD.G02() },
    { id: 'G03', section: 'guard', title: 'bare trailing <blockquote> (no attr) → stripped', fn: () => GUARD.G03() },
    // nearempty
    { id: 'N01', section: 'nearempty', title: 'all-quote → near-empty → FULL input', fn: () => NEAREMPTY.N01() },
    { id: 'N02', section: 'nearempty', title: 'attribution-only → near-empty → FULL input', fn: () => NEAREMPTY.N02() },
    { id: 'N03', section: 'nearempty', title: 'image-only reply → KEPT (media guard)', fn: () => NEAREMPTY.N03() },
    { id: 'N04', section: 'nearempty', title: 'zero-width-only text → near-empty → FULL', fn: () => NEAREMPTY.N04() },
    { id: 'N05', section: 'nearempty', title: 'empty marker + reply KEPT / only-marker → FULL', fn: () => NEAREMPTY.N05() },
    // attribution
    { id: 'A01', section: 'attribution', title: 'attribution, no blockquote → text-fallback cut', fn: () => ATTRIBUTION.A01() },
    { id: 'A02', section: 'attribution', title: 'bare "wrote:" (no On…) → NOT cut', fn: () => ATTRIBUTION.A02() },
    { id: 'A03', section: 'attribution', title: 'attribution 1-2-line wrap in one node → removed', fn: () => ATTRIBUTION.A03() },
    { id: 'A04', section: 'attribution', title: 'attribution split across two siblings → both removed', fn: () => ATTRIBUTION.A04() },
    { id: 'A05', section: 'attribution', title: 'non-attribution sibling → KEPT (under-reach)', fn: () => ATTRIBUTION.A05() },
    // nested
    { id: 'NE01', section: 'nested', title: '3-deep nested → single outermost cut', fn: () => NESTED_SEC.NE01() },
    { id: 'NE02', section: 'nested', title: '.gmail_quote inside <blockquote> → outermost cut', fn: () => NESTED_SEC.NE02() },
    // idempotent
    { id: 'I01', section: 'idempotent', title: 'strip(strip(x)) === strip(x) per shape', fn: () => IDEMPOTENT.I01() },
    { id: 'I02', section: 'idempotent', title: 'allowImages toggle keeps reply stripped', fn: () => IDEMPOTENT.I02() },
    // style
    { id: 'S01', section: 'style', title: 'leading <style> preserved through round-trip', fn: () => STYLE.S01() },
    { id: 'S02', section: 'style', title: 'quote-embedded <style> removed with quote', fn: () => STYLE.S02() },
    // xss
    { id: 'X01', section: 'xss', title: 'strip hostile sample → quote gone, nothing added', fn: () => XSS.X01(stripEmailQuote) },
    { id: 'X02', section: 'xss', title: 'output (tag,attr) multiset ⊆ input', fn: () => XSS.X02() },
    // failsafe
    { id: 'F01', section: 'failsafe', title: 'forced throw → returns INPUT (never throws)', fn: () => FAILSAFE.F01() },
    { id: 'F02', section: 'failsafe', title: 'empty/degenerate input → as-is, no crash', fn: () => FAILSAFE.F02() },
    // probe
    { id: 'PR01', section: 'probe', title: 'remote img only in quote → probe FALSE', fn: () => PROBE.PR01() },
    { id: 'PR02', section: 'probe', title: 'remote img in kept reply → probe TRUE', fn: () => PROBE.PR02() },
    // parity guard
    { id: 'P01', section: 'parity', title: 'CJS port mirrors shipped .ts (load-bearing bits)', fn: () => runParity() },
];

// Sabotage: run the detect assertions against a `html => html` pass-through and
// assert the harness RECORDS FAILUREs on the four client cases (the quote survives).
// Then confirm the real path is green. This proves the matrix is load-bearing.
const SAB_EXPECT_FAIL = ['D01', 'D02', 'D03', 'D04'];

function runSabotage() {
    const passthrough = (html) => String(html == null ? '' : html);
    const probes = {
        D01: () => DETECT.D01(passthrough),
        D02: () => DETECT.D02(passthrough),
        D03: () => DETECT.D03(passthrough),
        D04: () => DETECT.D04(passthrough),
    };
    let allTripped = true;
    for (const id of SAB_EXPECT_FAIL) {
        let tripped = false;
        try {
            probes[id]();
        } catch (e) {
            tripped = e instanceof CheckError;
        }
        if (tripped) {
            record(`SAB:${id}`, 'PASS', 'pass-through correctly RECORDS FAIL (quote survives → matrix is load-bearing)');
        } else {
            record(`SAB:${id}`, 'FAIL', 'pass-through did NOT trip a failure — matrix is VACUOUS for this case!');
            allTripped = false;
        }
    }
    // Restore: the real strip must be green on EVERY client case the sabotage tripped.
    let restored = true;
    try {
        DETECT.D01(stripEmailQuote);
        DETECT.D02(stripEmailQuote);
        DETECT.D03(stripEmailQuote);
        DETECT.D04(stripEmailQuote);
    } catch (e) {
        restored = false;
        record('SAB:restore', 'FAIL', `real strip should be green after restore — ${e.message}`);
    }
    if (restored) record('SAB:restore', 'PASS', 'real strip green after restore (all four client boundaries cut)');
    return allTripped && restored;
}

// ═════════════════════════════════════════════════════════════════════════════
// Runner
// ═════════════════════════════════════════════════════════════════════════════

const SECTION_LIST = 'detect, guard, nearempty, attribution, nested, idempotent, style, xss, failsafe, probe, parity, sab, all';

function parseSectionArg() {
    const arg = process.argv.find(a => a.startsWith('--section='));
    const v = arg ? arg.split('=')[1] : (process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : 'all');
    return v || 'all';
}

function main() {
    const sel = parseSectionArg();
    const runSab = sel === 'all' || sel === 'sab';
    const selected = CASES.filter(c => sel === 'all' || c.section === sel || c.id === sel);

    if (selected.length === 0 && !runSab) {
        console.error(`No cases match --section=${sel}. Sections: ${SECTION_LIST}`);
        process.exit(2);
    }

    console.log('EMAIL-QUOTE-STRIP-001 verify — headless quote-strip matrix (jsdom DOMParser)');
    console.log(`jsdom=${depVersion('jsdom')} · unit-under-test: CJS port of frontend/src/lib/stripEmailQuote.ts`);
    console.log(`Section: ${sel} → ${selected.length} case(s)${runSab ? ' + sabotage control' : ''}\n`);

    for (const c of selected) {
        try {
            c.fn();
            record(c.id, 'PASS', c.title);
        } catch (e) {
            const note = `${c.title} — ${e instanceof CheckError ? e.message : (e.stack || e.message)}`;
            record(c.id, 'FAIL', note);
        }
    }

    if (runSab) {
        console.log('\n── sabotage negative-control (TC-EQS-SAB): pass-through MUST turn the detect matrix red ──');
        runSabotage();
    }

    const pass = results.filter(r => r.status === 'PASS').length;
    const fail = results.filter(r => r.status === 'FAIL').length;
    console.log('\n══════════════════════════════════════════════');
    console.log(`PASS ${pass} · FAIL ${fail} (of ${results.length})`);
    if (fail > 0) console.log(`FAILED: ${results.filter(r => r.status === 'FAIL').map(r => r.id).join(', ')}`);

    process.exit(fail > 0 ? 1 : 0);
}

main();
