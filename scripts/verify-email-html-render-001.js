#!/usr/bin/env node
/**
 * EMAIL-HTML-RENDER-001 — headless security + linkify verification (TASK-EHR-011).
 *
 * WHY A STANDALONE SCRIPT (not jest): the frontend has NO unit-test runner and no
 * jsdom-jest env installed; the DOM-needing sanitizer (DOMPurify) therefore cannot
 * run under the node-env root jest. This script constructs a jsdom `window`, hands
 * it to DOMPurify via `createDOMPurify(window)` (DOMPurify's supported headless
 * factory), and runs the hostile-HTML security matrix + the pure linkify contract
 * HEADLESS. This is the ONLY automated proof that each hostile payload from the
 * spec's strip-matrix is neutralized (AC-2/AC-4/AC-5/AC-10).
 *
 * WHY A PORT (not a require of the shipped .ts): `frontend/src/lib/sanitizeEmailHtml.ts`
 * and `linkifyText.ts` are TS-ESM and no TS/ESM loader (ts-node/tsx/esbuild) is
 * installed, so Node cannot `require()` them. This script holds a *verbatim CJS
 * port* of the sanitize config + `afterSanitizeAttributes` hook and of the linkify
 * escape-then-wrap logic. Because a port can silently drift from what ships, a
 * PARITY GUARD (section `parity`, TC-EHR-B03) reads the two TS source files and
 * asserts the load-bearing bits still match (the `^\s*(javascript|data):`i block,
 * the `data-blanc-src` move, `rel="noopener noreferrer"`, `target="_blank"`, the
 * escape set `& < > " '`, the image-src protocol regexes). If the TS changed in a
 * way the port did NOT mirror, the run FAILs loudly. The port is ONLY a test aid.
 *
 * SABOTAGE (section `sab`, TC-EHR-SAB): the security assertions are also run
 * against a `html => html` pass-through (no sanitize). The harness MUST record
 * FAILUREs on H01/H02/H04/H06/H08/H10 — proving the matrix is load-bearing (a
 * removed sanitize call turns it red). Then the real path is restored → all green.
 *
 * RUNNING (deps are NOT in the repo — provide them via NODE_PATH):
 *   in a scratch dir:  npm init -y && npm install jsdom dompurify@3.2.7
 *   from the repo root: NODE_PATH=<scratch>/node_modules node scripts/verify-email-html-render-001.js
 *   optional: --section=security|images|links|failsafe|linkify|sab|parity|all
 *
 * The script SHIPS in the repo; jsdom/dompurify are dev/verify-only (never added to
 * package.json, never bundled). Exit code 0 only when no case FAILs.
 */
'use strict';

const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const SANITIZE_TS = path.join(ROOT, 'frontend/src/lib/sanitizeEmailHtml.ts');
const LINKIFY_TS = path.join(ROOT, 'frontend/src/lib/linkifyText.ts');

// ─── jsdom + DOMPurify (resolved via NODE_PATH; see header) ──────────────────
let JSDOM;
let createDOMPurify;
try {
    ({ JSDOM } = require('jsdom'));
    createDOMPurify = require('dompurify');
} catch (e) {
    console.error(
        'FATAL: could not load jsdom/dompurify. They are dev/verify-only and are NOT in\n' +
        'the repo. Install them in a scratch dir and pass NODE_PATH, e.g.:\n' +
        '  (cd /tmp/ehr && npm init -y && npm install jsdom dompurify@3.2.7)\n' +
        '  NODE_PATH=/tmp/ehr/node_modules node scripts/verify-email-html-render-001.js\n' +
        `Underlying error: ${e.message}`
    );
    process.exit(2);
}

const { window } = new JSDOM('');
const DOMPurify = createDOMPurify(window);

// DOMPurify exposes its version on the instance; jsdom's package.json is readable
// via require.resolve without tripping an `exports` restriction.
function depVersion(mod) {
    try {
        const pkgPath = require.resolve(`${mod}/package.json`);
        return require(pkgPath).version;
    } catch {
        return 'unknown';
    }
}
const DOMPURIFY_VERSION = (DOMPurify && DOMPurify.version) || depVersion('dompurify');

// ═════════════════════════════════════════════════════════════════════════════
// CJS PORT of frontend/src/lib/sanitizeEmailHtml.ts  (mirror EXACTLY; see parity)
// ═════════════════════════════════════════════════════════════════════════════

let allowImagesFlag = false;

const JS_OR_DATA_HREF = /^\s*(?:javascript|data):/i;
const REMOTE_IMG_SRC = /^\s*(?:https?:)?\/\//i; // http:, https:, or protocol-relative //
const CID_IMG_SRC = /^\s*cid:/i;

function afterSanitizeAttributes(node) {
    const tag = node.tagName;

    if (tag === 'A') {
        node.setAttribute('target', '_blank');
        node.setAttribute('rel', 'noopener noreferrer');
        const href = node.getAttribute('href');
        if (href !== null && JS_OR_DATA_HREF.test(href)) {
            node.removeAttribute('href');
        }
        return;
    }

    if (tag === 'IMG') {
        const src = node.getAttribute('src');
        // cid: ALWAYS neutralized (both image states); remote/protorel only when OFF.
        if (src !== null && (CID_IMG_SRC.test(src) || (!allowImagesFlag && REMOTE_IMG_SRC.test(src)))) {
            node.setAttribute('data-blanc-src', src);
            node.removeAttribute('src');
        }
        if (!allowImagesFlag) {
            if (node.hasAttribute('srcset')) {
                node.removeAttribute('srcset');
            }
            if (node.hasAttribute('background')) {
                node.removeAttribute('background');
            }
        }
        return;
    }
}

function sanitizeEmailHtml(html, opts) {
    if (html == null) return '';
    if (String(html).trim() === '') return '';

    const allowImages = (opts && opts.allowImages) != null ? opts.allowImages : false;

    try {
        allowImagesFlag = allowImages;
        DOMPurify.addHook('afterSanitizeAttributes', afterSanitizeAttributes);
        try {
            const clean = DOMPurify.sanitize(html, {
                FORBID_TAGS: ['form', 'input', 'button', 'select', 'textarea', 'option', 'optgroup', 'label', 'fieldset', 'legend'],
                ADD_TAGS: ['style'],
                FORCE_BODY: true,
                RETURN_TRUSTED_TYPE: false,
            });
            return typeof clean === 'string' ? clean : String(clean);
        } finally {
            DOMPurify.removeHook('afterSanitizeAttributes');
            allowImagesFlag = false;
        }
    } catch {
        return '';
    }
}

// ═════════════════════════════════════════════════════════════════════════════
// CJS PORT of frontend/src/lib/linkifyText.ts  (mirror EXACTLY; see parity)
// ═════════════════════════════════════════════════════════════════════════════

// formatPhone port (frontend/src/lib/formatPhone.ts) — display only.
function formatPhone(phone) {
    if (!phone) return '-';
    const digits = phone.replace(/\D/g, '');
    if (digits.length === 10) {
        return `+1 (${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
    }
    if (digits.length === 11 && digits[0] === '1') {
        return `+1 (${digits.slice(1, 4)}) ${digits.slice(4, 7)}-${digits.slice(7)}`;
    }
    return phone;
}

function escapeHtml(input) {
    return input
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function attrEscape(url) {
    return url.replace(/"/g, '&quot;');
}

function anchor(href, label) {
    return `<a href="${attrEscape(href)}" target="_blank" rel="noopener noreferrer">${label}</a>`;
}

const TOKEN_RE = new RegExp(
    [
        '(https?:\\/\\/[^\\s<]+)',
        '(www\\.[^\\s<]+)',
        '([A-Za-z0-9._%+\\-]+@[A-Za-z0-9.\\-]+\\.[A-Za-z]{2,})',
        '(\\+?\\d[\\d\\s().\\-]{8,}\\d)',
    ].join('|'),
    'g'
);

const TRAILING_PUNCT = /[.,;:!?)\]'"]+$/;

function splitTrailing(token, keepBalancedParen) {
    const m = TRAILING_PUNCT.exec(token);
    if (!m) return { core: token, tail: '' };
    let tail = m[0];
    let core = token.slice(0, token.length - tail.length);
    if (keepBalancedParen && tail.startsWith(')')) {
        const opens = (core.match(/\(/g) || []).length;
        const closes = (core.match(/\)/g) || []).length;
        if (opens > closes) {
            core += ')';
            tail = tail.slice(1);
        }
    }
    return { core, tail };
}

function linkifyLine(escapedLine) {
    return escapedLine.replace(TOKEN_RE, (match, urlAbs, urlWww, email, phone) => {
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
            const digits = phone.replace(/\D/g, '');
            if (digits.length < 10 || digits.length > 15) return match;
            const display = formatPhone(phone);
            const label = display && display !== '-' ? display : phone;
            return anchor(`tel:${digits}`, label);
        }
        return match;
    });
}

function linkifyToHtml(text) {
    if (text == null || text === '') return '';
    return text
        .split('\n')
        .map((line) => linkifyLine(escapeHtml(line)))
        .join('\n');
}

// ═════════════════════════════════════════════════════════════════════════════
// tiny assert / report kit (mirrors verify-contact-email-merge-001.js)
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
    const pad = ' '.repeat(Math.max(1, 12 - id.length));
    console.log(`${status} ${id}${pad}${note || ''}`);
}

// Parse a sanitized/linkified HTML string back into a jsdom fragment so we assert
// STRUCTURALLY (querySelector) rather than on brittle serialized-string order.
function frag(html) {
    const d = new JSDOM(`<!doctype html><body>${html}</body>`);
    return d.window.document.body;
}

// ═════════════════════════════════════════════════════════════════════════════
// The strip-matrix security assertions, parameterized on the sanitize fn so the
// SAME battery runs against the real port AND (in `sab`) against a pass-through.
// Each returns nothing / throws CheckError on failure.
// ═════════════════════════════════════════════════════════════════════════════

const SECURITY = {
    H01(san) {
        const out = san('<div>a<script>alert(1)</script>b</div>', { allowImages: false });
        const b = frag(out);
        check(b.querySelector('script') === null, 'H01: <script> must be removed');
        check(/a/.test(b.textContent) && /b/.test(b.textContent), 'H01: surrounding text a…b must survive');
    },
    H02(san) {
        // NOTE: use a REMOTE src so the neutralize branch is exercised. A bare
        // relative `src="x"` is intentionally NOT matched by the shipped
        // remote/`//`/`cid:` regex (it can't beacon), so it stays put — asserting
        // that here would be a false expectation vs. the shipped hook.
        const out = san('<img src="https://track.example/x.gif" onerror="alert(1)">', { allowImages: false });
        const img = frag(out).querySelector('img');
        check(img !== null, 'H02: <img> element should remain');
        eq(img.getAttribute('onerror'), null, 'H02: onerror stripped');
        eq(img.getAttribute('src'), null, 'H02: remote src moved off (neutralized)');
        eq(img.getAttribute('data-blanc-src'), 'https://track.example/x.gif', 'H02: neutralized src parked in data-blanc-src');
        // sub-assert: onerror stripped EVEN with allowImages:true
        const out2 = san('<img src="https://ok.io/a.png" onerror="alert(1)">', { allowImages: true });
        const img2 = frag(out2).querySelector('img');
        eq(img2 && img2.getAttribute('onerror'), null, 'H02: onerror stripped even when allowImages:true');
    },
    // Bare relative src (harmless, no beacon) is left intact by the shipped hook —
    // documents the boundary of the remote/cid neutralize (NOT a defect).
    H02b(san) {
        const img = frag(san('<img src="x" onerror="alert(1)">', { allowImages: false })).querySelector('img');
        check(img !== null, 'H02b: <img> remains');
        eq(img.getAttribute('onerror'), null, 'H02b: onerror still stripped');
        eq(img.getAttribute('src'), 'x', 'H02b: bare relative src left intact (not remote/cid → no beacon possible)');
        eq(img.getAttribute('data-blanc-src'), null, 'H02b: relative src NOT parked');
    },
    H03(san) {
        const cases = [
            ['<div onclick="x()">c</div>', 'div', 'onclick'],
            ['<a href="https://x.io" onmouseover="x()">l</a>', 'a', 'onmouseover'],
            ['<p onload="x()">d</p>', 'p', 'onload'],
        ];
        for (const [input, sel, attr] of cases) {
            const el = frag(san(input, { allowImages: false })).querySelector(sel);
            check(el !== null, `H03: ${sel} should survive (${attr})`);
            eq(el.getAttribute(attr), null, `H03: ${attr} stripped`);
        }
        // the surviving <a> still gets forced target/rel (cross-check with H10)
        const a = frag(san('<a href="https://x.io" onmouseover="x()">l</a>', {})).querySelector('a');
        eq(a.getAttribute('target'), '_blank', 'H03: <a> still forced target=_blank');
        eq(a.getAttribute('rel'), 'noopener noreferrer', 'H03: <a> still forced rel');
    },
    // P0 SECURITY GATE (AC-2 / US-5 / strip-matrix row 4): a phishing form must
    // NOT survive sanitize. This assertion is DELIBERATELY strict. DOMPurify does
    // NOT strip <form>/<input>/<button>/<select>/<textarea> by DEFAULT, so the
    // shipped config carries an explicit FORBID_TAGS listing every form control;
    // if this FAILs that FORBID_TAGS is missing/loosened (real credential-capture hole).
    H04(san) {
        const out = san('<form action="https://evil"><input name="pw"><button type="submit">Login</button></form>', { allowImages: false });
        const b = frag(out);
        check(b.querySelector('form') === null, 'H04: <form> removed (via FORBID_TAGS; DOMPurify keeps <form> by default)');
        check(b.querySelector('input') === null, 'H04: <input> removed');
        check(b.querySelector('button[type="submit"]') === null, 'H04: submit <button> removed');
        check(b.querySelector('select') === null && b.querySelector('textarea') === null, 'H04: other form controls removed');
    },
    H05(san) {
        const b = frag(san('<iframe src="https://evil"></iframe><p>ok</p>', { allowImages: false }));
        check(b.querySelector('iframe') === null, 'H05: <iframe> removed');
        check(b.querySelector('p') !== null && /ok/.test(b.textContent), 'H05: sibling <p>ok</p> survives');
    },
    // H13 — the `class` attribute is retained (load-bearing for shadow-scoped author
    // styling) AND the author `<style>` element survives. DOMPurify DROPS a top-level
    // `<style>` by default in this fragment/`sanitize()` path (3.2.7), so the shipped
    // config re-admits it via `ADD_TAGS: ['style']` for render fidelity — DOMPurify
    // still sanitizes its CSS, and SafeEmailHtml renders it inside an isolated shadow
    // root so it cannot affect the host app. Live shadow-render fidelity = Group D manual.
    H13(san) {
        const b = frag(san('<style>.card{color:red}</style><div class="card">x</div>', {}));
        const div = b.querySelector('div');
        eq(div && div.getAttribute('class'), 'card', 'H13: class="card" kept (author-class survives for shadow-scoped styling)');
        const style = b.querySelector('style');
        check(style !== null, 'H13: author <style> retained via ADD_TAGS (shadow-scoped by SafeEmailHtml)');
        check(/\.card/.test(style.textContent), 'H13: <style> CSS body preserved');
    },
    H16(san) {
        // global-leak guard: after an email sanitize, a BARE DOMPurify.sanitize must
        // NOT carry the forced target/rel (only meaningful for the real port).
        san('<a href="https://x.io">l</a>', {});
        const bare = DOMPurify.sanitize('<a href="https://x.io">l</a>');
        const a = frag(bare).querySelector('a');
        check(a !== null, 'H16: bare anchor present');
        eq(a.getAttribute('target'), null, 'H16: bare DOMPurify.sanitize NOT forced target (hook removed)');
        eq(a.getAttribute('rel'), null, 'H16: bare DOMPurify.sanitize NOT forced rel (hook removed)');
    },
};

const LINKS = {
    H06(san) {
        const a = frag(san('<a href="javascript:alert(1)">x</a>', {})).querySelector('a');
        const href = a ? a.getAttribute('href') : null;
        check(href === null || !/^\s*javascript:/i.test(href), 'H06: javascript: href nulled');
        if (a) {
            eq(a.getAttribute('target'), '_blank', 'H06: anchor (if kept) still target=_blank');
            eq(a.getAttribute('rel'), 'noopener noreferrer', 'H06: anchor (if kept) still rel');
        }
    },
    H07(san) {
        const a = frag(san('<a href="data:text/html,<script>alert(1)</script>">x</a>', {})).querySelector('a');
        const href = a ? a.getAttribute('href') : null;
        check(href === null || !/^\s*data:/i.test(href), 'H07: data: href on LINK nulled (distinct from data: IMAGE)');
    },
    H10(san) {
        const b = frag(san('<a href="https://ok.io">a</a><a href="https://ok.io" target="_self" rel="opener">b</a>', {}));
        const as = b.querySelectorAll('a');
        eq(as.length, 2, 'H10: both anchors present');
        for (const a of as) {
            eq(a.getAttribute('target'), '_blank', 'H10: target overwritten to _blank');
            eq(a.getAttribute('rel'), 'noopener noreferrer', 'H10: rel overwritten to noopener noreferrer');
        }
        // mailto:/tel:/protocol-relative also survive + get target/rel
        const b2 = frag(san('<a href="mailto:a@b.io">m</a><a href="tel:+16175559001">t</a><a href="//ok.io/x">p</a>', {}));
        for (const a of b2.querySelectorAll('a')) {
            eq(a.getAttribute('target'), '_blank', 'H10: mailto/tel/protorel forced target');
            eq(a.getAttribute('rel'), 'noopener noreferrer', 'H10: mailto/tel/protorel forced rel');
        }
        eq(b2.querySelectorAll('a').length, 3, 'H10: mailto/tel/protorel anchors all survive');
    },
};

const IMAGES = {
    H08(san) {
        const img = frag(san('<img src="https://track.example/pixel.gif" srcset="https://track.example/2x.gif 2x">', { allowImages: false })).querySelector('img');
        check(img !== null, 'H08: <img> remains');
        eq(img.getAttribute('src'), null, 'H08: remote src removed (no live fetch)');
        eq(img.getAttribute('data-blanc-src'), 'https://track.example/pixel.gif', 'H08: remote src parked in data-blanc-src');
        eq(img.getAttribute('srcset'), null, 'H08: srcset stripped');
    },
    H09(san) {
        const DATA = 'data:image/png;base64,iVBORw0KGgo=';
        const img = frag(san(`<img src="${DATA}">`, { allowImages: false })).querySelector('img');
        check(img !== null, 'H09: data: <img> kept');
        eq(img.getAttribute('src'), DATA, 'H09: data: src left intact (self-contained, no beacon)');
        eq(img.getAttribute('data-blanc-src'), null, 'H09: data: src NOT moved');
    },
    H11(san) {
        const off = frag(san('<img src="//evil/x.png">', { allowImages: false })).querySelector('img');
        eq(off.getAttribute('src'), null, 'H11: protocol-relative src neutralized when !allowImages');
        eq(off.getAttribute('data-blanc-src'), '//evil/x.png', 'H11: protorel parked in data-blanc-src');
        const on = frag(san('<img src="//evil/x.png">', { allowImages: true })).querySelector('img');
        eq(on.getAttribute('src'), '//evil/x.png', 'H11: protorel src survives when allowImages:true');
    },
    // H12 — cid: neutralized when images OFF. The shipped hook ALWAYS neutralizes a
    // cid: src (both image states), since a cid: cannot resolve on the timeline path
    // (no attachment plumbing in v1) and would otherwise be a broken live src.
    H12(san) {
        const off = frag(san('<img src="cid:abc123">', { allowImages: false })).querySelector('img');
        check(off !== null, 'H12: cid: <img> present (images OFF)');
        check(off.getAttribute('src') !== 'cid:abc123', 'H12: cid: src moved off src when images OFF');
        eq(off.getAttribute('data-blanc-src'), 'cid:abc123', 'H12: cid: parked in data-blanc-src when images OFF');
    },
    // cid: is neutralized EVEN when images ON (matches spec "both states"): a cid: can
    // never resolve here, so it is always parked rather than left as a broken live src.
    H12b(san) {
        const on = frag(san('<img src="cid:abc123">', { allowImages: true })).querySelector('img');
        check(on !== null, 'H12b: cid: <img> present (images ON)');
        check(on.getAttribute('src') !== 'cid:abc123', 'H12b: cid: src moved off src when images ON');
        eq(on.getAttribute('data-blanc-src'), 'cid:abc123', 'H12b: cid: neutralized when images ON (always-neutralize; both states)');
    },
};

const FAILSAFE = {
    H14() {
        // Force a throw INSIDE the sanitize body by monkeypatching the instance sanitize.
        const realSanitize = DOMPurify.sanitize;
        DOMPurify.sanitize = () => { throw new Error('boom'); };
        try {
            const out = sanitizeEmailHtml('<div>whatever</div>', { allowImages: false });
            eq(out, '', 'H14: throw inside sanitize → returns "" (never raw, never throws out)');
        } finally {
            DOMPurify.sanitize = realSanitize;
        }
    },
    H15() {
        for (const input of ['', '   ', undefined, '<!-- only a comment -->']) {
            const out = sanitizeEmailHtml(input, { allowImages: false });
            check(out.trim() === '', `H15: empty/whitespace/undefined/comment-only → "" (got ${JSON.stringify(out)})`);
        }
    },
};

const LINKIFY = {
    H17() {
        const out = linkifyToHtml('<img src=x onerror="alert(1)"> & <script>alert(2)</script> "q" \'p\'');
        // Structural: parsed back, NO live tag was created from body_text.
        const b = frag(out);
        check(b.querySelector('img') === null, 'H17: no live <img> injected from text');
        check(b.querySelector('script') === null, 'H17: no live <script> injected from text');
        // Entities present as visible text.
        check(/&lt;img/.test(out), 'H17: <img escaped to &lt;img');
        check(/&lt;script&gt;/.test(out), 'H17: <script> escaped to &lt;script&gt;');
        check(/&amp;/.test(out), 'H17: & escaped to &amp;');
        check(/&quot;/.test(out) && /&#39;/.test(out), 'H17: " and \' escaped');
    },
    H18() {
        const b = frag(linkifyToHtml('see https://ex.com/a?b=1 and www.ex.org now'));
        const as = b.querySelectorAll('a');
        eq(as.length, 2, 'H18: exactly two anchors (URL + www.)');
        const abs = [...as].find(a => a.getAttribute('href') === 'https://ex.com/a?b=1');
        check(abs, 'H18: absolute URL href preserved incl. ?b=1 query');
        const www = [...as].find(a => a.getAttribute('href') === 'https://www.ex.org');
        check(www, 'H18: www. normalized to https://www.ex.org');
        for (const a of as) {
            eq(a.getAttribute('target'), '_blank', 'H18: linkified anchor target');
            eq(a.getAttribute('rel'), 'noopener noreferrer', 'H18: linkified anchor rel');
        }
        check(/see/.test(b.textContent) && /now/.test(b.textContent), 'H18: surrounding words stay plain text');
    },
    H19() {
        const b = frag(linkifyToHtml('reach me at jane.doe@relyhome.com or +1 (617) 555-9001'));
        const mail = b.querySelector('a[href="mailto:jane.doe@relyhome.com"]');
        check(mail, 'H19: email → mailto: anchor');
        // Shipped code builds `tel:${digits}` where digits is `phone.replace(/\D/g,'')`
        // → NO leading '+'. (The spec example wrote `tel:+16175559001`; the shipped
        // href is `tel:16175559001`. Asserting the shipped reality.)
        const tel = b.querySelector('a[href="tel:16175559001"]');
        check(tel, 'H19: phone → tel:16175559001 anchor (digits normalized, no leading +)');
        for (const a of b.querySelectorAll('a')) {
            eq(a.getAttribute('target'), '_blank', 'H19: target');
            eq(a.getAttribute('rel'), 'noopener noreferrer', 'H19: rel');
        }
        // malformed `a@` fragment NOT wrapped
        const b2 = frag(linkifyToHtml('write a@ here'));
        eq(b2.querySelectorAll('a').length, 0, 'H19: malformed a@ not linkified');
    },
    H20() {
        const out = linkifyToHtml('line1\nline2 https://x.io\nline3');
        eq(out.split('\n').length, 3, 'H20: \\n line-breaks preserved (3 lines)');
        const b = frag(out);
        eq(b.querySelectorAll('a').length, 1, 'H20: the URL on line 2 linkified, lines not merged');
        check(b.querySelector('a').getAttribute('href') === 'https://x.io', 'H20: line-2 URL href correct');
    },
    H21() {
        const out = linkifyToHtml('just a plain sentence, no links here.');
        const b = frag(out);
        eq(b.querySelectorAll('a').length, 0, 'H21: no spurious <a> for plain text');
        check(/just a plain sentence, no links here\./.test(b.textContent), 'H21: sentence verbatim (only escaped)');
    },
};

// ═════════════════════════════════════════════════════════════════════════════
// PARITY GUARD (TC-EHR-B03): the CJS port must still mirror the shipped .ts on the
// load-bearing bits. Reads the TS source and asserts each token is present. If the
// TS drifted in a way the port did not mirror, FAIL loudly.
// ═════════════════════════════════════════════════════════════════════════════

function runParity() {
    const s = fs.readFileSync(SANITIZE_TS, 'utf8');
    const l = fs.readFileSync(LINKIFY_TS, 'utf8');
    const norm = (x) => x.replace(/\s+/g, '');

    // sanitize.ts load-bearing tokens
    check(norm(s).includes(norm('/^\\s*(?:javascript|data):/i')), 'PARITY: sanitize.ts JS_OR_DATA_HREF regex matches port');
    check(norm(s).includes(norm('/^\\s*(?:https?:)?\\/\\//i')), 'PARITY: sanitize.ts REMOTE_IMG_SRC regex matches port');
    check(norm(s).includes(norm('/^\\s*cid:/i')), 'PARITY: sanitize.ts CID_IMG_SRC regex matches port');
    check(/setAttribute\(\s*'target'\s*,\s*'_blank'\s*\)/.test(s), 'PARITY: sanitize.ts forces target="_blank"');
    check(/setAttribute\(\s*'rel'\s*,\s*'noopener noreferrer'\s*\)/.test(s), 'PARITY: sanitize.ts forces rel="noopener noreferrer"');
    check(/setAttribute\(\s*'data-blanc-src'\s*,\s*src\s*\)/.test(s), 'PARITY: sanitize.ts moves src → data-blanc-src');
    check(/removeAttribute\(\s*'srcset'\s*\)/.test(s), 'PARITY: sanitize.ts strips srcset');
    check(/RETURN_TRUSTED_TYPE:\s*false/.test(s), 'PARITY: sanitize.ts uses RETURN_TRUSTED_TYPE:false');
    check(/addHook\(\s*'afterSanitizeAttributes'/.test(s) && /removeHook\(\s*'afterSanitizeAttributes'/.test(s), 'PARITY: sanitize.ts add/removes the hook (global-leak guard)');
    check(/return\s*''/.test(s), 'PARITY: sanitize.ts fail-safe returns ""');
    // Config check: assert the ACTUAL DOMPurify.sanitize(...) call's options object
    // (now multi-line) carries the anti-phishing FORBID_TAGS + the <style> ADD_TAGS,
    // and does NOT loosen ATTRIBUTES via ADD_ATTR (the real risk — ADD_TAGS:['style']
    // is the only intentional tag re-admit). Scope to the call args (the doc comment
    // also mentions these names). Captures from the html arg up to the closing `})`.
    const callM = s.match(/DOMPurify\.sanitize\(\s*html\s*,\s*(\{[\s\S]*?\})\s*\)/);
    check(callM !== null, 'PARITY: sanitize.ts calls DOMPurify.sanitize(html, {…})');
    const cfg = callM[1];
    check(/RETURN_TRUSTED_TYPE:\s*false/.test(cfg), 'PARITY: sanitize() call passes RETURN_TRUSTED_TYPE:false');
    check(!/ADD_ATTR/.test(cfg), 'PARITY: the sanitize() call passes no ADD_ATTR (no attribute loosening)');
    // FORBID_TAGS must list every form/credential-capture control (anti-phishing, H04).
    for (const t of ['form', 'input', 'button', 'select', 'textarea', 'option', 'optgroup', 'label', 'fieldset', 'legend']) {
        check(new RegExp(`FORBID_TAGS[\\s\\S]*['"]${t}['"]`).test(cfg), `PARITY: FORBID_TAGS lists '${t}'`);
    }
    // ADD_TAGS re-admits ONLY <style> (shadow-scoped fidelity) and nothing else,
    // and FORCE_BODY keeps a leading <style> from being hoisted out of the fragment.
    check(norm(cfg).includes(norm("ADD_TAGS:['style']")), "PARITY: ADD_TAGS re-admits exactly ['style'] (shadow-scoped author <style>)");
    check(/FORCE_BODY:\s*true/.test(cfg), 'PARITY: sanitize() call passes FORCE_BODY:true (preserves leading <style>)');

    // linkify.ts load-bearing tokens: the exact escape set & order
    check(/replace\(\/&\/g,\s*'&amp;'\)/.test(l), 'PARITY: linkify.ts escapes & first → &amp;');
    check(/replace\(\/<\/g,\s*'&lt;'\)/.test(l), 'PARITY: linkify.ts escapes < → &lt;');
    check(/replace\(\/>\/g,\s*'&gt;'\)/.test(l), 'PARITY: linkify.ts escapes > → &gt;');
    check(/replace\(\/"\/g,\s*'&quot;'\)/.test(l), 'PARITY: linkify.ts escapes " → &quot;');
    check(/replace\(\/'\/g,\s*'&#39;'\)/.test(l), "PARITY: linkify.ts escapes ' → &#39;");
    check(/target="_blank"\s*rel="noopener noreferrer"/.test(l), 'PARITY: linkify.ts anchor carries target/rel');
    check(/mailto:/.test(l) && /tel:/.test(l), 'PARITY: linkify.ts wraps mailto:/tel:');
    // The escape-FIRST ordering: split('\n') → map(linkifyLine(escapeHtml(line)))
    check(norm(l).includes(norm('linkifyLine(escapeHtml(line))')), 'PARITY: linkify.ts escapes BEFORE linkifying (escape-first)');
}

// ═════════════════════════════════════════════════════════════════════════════
// Case registry
// ═════════════════════════════════════════════════════════════════════════════

const CASES = [
    // security
    { id: 'H01', section: 'security', title: '<script> removed, text survives', fn: () => SECURITY.H01(sanitizeEmailHtml) },
    { id: 'H02', section: 'security', title: '<img onerror> stripped, remote src neutralized', fn: () => SECURITY.H02(sanitizeEmailHtml) },
    { id: 'H02b', section: 'security', title: 'bare relative <img src=x> left intact (boundary doc)', fn: () => SECURITY.H02b(sanitizeEmailHtml) },
    { id: 'H03', section: 'security', title: 'on* handlers stripped (onclick/onmouseover/onload)', fn: () => SECURITY.H03(sanitizeEmailHtml) },
    { id: 'H04', section: 'security', title: '<form>/<input>/submit-<button> removed', fn: () => SECURITY.H04(sanitizeEmailHtml) },
    { id: 'H05', section: 'security', title: '<iframe> removed, sibling survives', fn: () => SECURITY.H05(sanitizeEmailHtml) },
    { id: 'H13', section: 'security', title: '<style> + class RETAINED (shadow-scoped at render)', fn: () => SECURITY.H13(sanitizeEmailHtml) },
    { id: 'H16', section: 'security', title: 'no global DOMPurify leak (hook removed after)', fn: () => SECURITY.H16(sanitizeEmailHtml) },
    // links
    { id: 'H06', section: 'links', title: 'javascript: link href nulled', fn: () => LINKS.H06(sanitizeEmailHtml) },
    { id: 'H07', section: 'links', title: 'data: link href nulled (distinct from data: image)', fn: () => LINKS.H07(sanitizeEmailHtml) },
    { id: 'H10', section: 'links', title: 'every <a> forced target=_blank + rel', fn: () => LINKS.H10(sanitizeEmailHtml) },
    // images
    { id: 'H08', section: 'images', title: 'remote <img> src→data-blanc-src, srcset stripped', fn: () => IMAGES.H08(sanitizeEmailHtml) },
    { id: 'H09', section: 'images', title: 'data: <img> kept, src intact', fn: () => IMAGES.H09(sanitizeEmailHtml) },
    { id: 'H11', section: 'images', title: 'protocol-relative <img> neutralized (on toggle survives)', fn: () => IMAGES.H11(sanitizeEmailHtml) },
    { id: 'H12', section: 'images', title: 'cid: <img> neutralized when images OFF', fn: () => IMAGES.H12(sanitizeEmailHtml) },
    { id: 'H12b', section: 'images', title: 'cid: <img> neutralized when images ON (both states)', fn: () => IMAGES.H12b(sanitizeEmailHtml) },
    // failsafe
    { id: 'H14', section: 'failsafe', title: 'sanitize throw → "" (never raw)', fn: () => FAILSAFE.H14() },
    { id: 'H15', section: 'failsafe', title: 'empty/whitespace/undefined → ""', fn: () => FAILSAFE.H15() },
    // linkify
    { id: 'H17', section: 'linkify', title: 'escape-first → no injection from body_text', fn: () => LINKIFY.H17() },
    { id: 'H18', section: 'linkify', title: 'URL + www. wrapped w/ target+rel', fn: () => LINKIFY.H18() },
    { id: 'H19', section: 'linkify', title: 'email→mailto:, phone→tel:', fn: () => LINKIFY.H19() },
    { id: 'H20', section: 'linkify', title: '\\n line-breaks preserved', fn: () => LINKIFY.H20() },
    { id: 'H21', section: 'linkify', title: 'plain text → no spurious <a>', fn: () => LINKIFY.H21() },
    // parity guard
    { id: 'B03', section: 'parity', title: 'CJS port mirrors shipped .ts (load-bearing bits)', fn: () => runParity() },
];

// Sabotage: run the neutralize assertions against a pass-through (no sanitize) and
// assert the harness RECORDS FAILUREs on the load-bearing cases. Then confirm the
// real path is green. This proves the matrix is load-bearing.
const SAB_EXPECT_FAIL = ['H01', 'H02', 'H04', 'H06', 'H08', 'H10'];

function runSabotage() {
    const passthrough = (html /*, opts */) => String(html == null ? '' : html);
    const probes = {
        H01: () => SECURITY.H01(passthrough),
        H02: () => SECURITY.H02(passthrough),
        H04: () => SECURITY.H04(passthrough),
        H06: () => LINKS.H06(passthrough),
        H08: () => IMAGES.H08(passthrough),
        H10: () => LINKS.H10(passthrough),
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
            record(`SAB:${id}`, 'PASS', 'pass-through correctly RECORDS FAIL (matrix is load-bearing)');
        } else {
            record(`SAB:${id}`, 'FAIL', 'pass-through did NOT trip a failure — matrix is VACUOUS for this case!');
            allTripped = false;
        }
    }
    // Restore: the real sanitize must be green on EVERY case the sabotage probe
    // turns red. H04 (form-strip) is now included — the shipped config strips forms
    // via FORBID_TAGS, so the real path passes it. H03 (on* strip) rides along too.
    let restored = true;
    try {
        SECURITY.H01(sanitizeEmailHtml);
        SECURITY.H02(sanitizeEmailHtml);
        SECURITY.H03(sanitizeEmailHtml);
        SECURITY.H04(sanitizeEmailHtml);
        LINKS.H06(sanitizeEmailHtml);
        IMAGES.H08(sanitizeEmailHtml);
        LINKS.H10(sanitizeEmailHtml);
    } catch (e) {
        restored = false;
        record('SAB:restore', 'FAIL', `real sanitize should be green after restore — ${e.message}`);
    }
    if (restored) record('SAB:restore', 'PASS', 'real sanitize green after restore (incl. H04 form-strip via FORBID_TAGS)');
    return allTripped && restored;
}

// ═════════════════════════════════════════════════════════════════════════════
// Runner
// ═════════════════════════════════════════════════════════════════════════════

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
        console.error(`No cases match --section=${sel}. Sections: security, links, images, failsafe, linkify, parity, sab, all`);
        process.exit(2);
    }

    console.log('EMAIL-HTML-RENDER-001 verify — headless security + linkify matrix (jsdom + DOMPurify 3.2.7)');
    console.log(`dompurify=${DOMPURIFY_VERSION} · jsdom=${depVersion('jsdom')}`);
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
        console.log('\n── sabotage negative-control (TC-EHR-SAB): pass-through MUST turn the matrix red ──');
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
