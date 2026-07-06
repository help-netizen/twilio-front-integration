/**
 * EMAIL-QUOTE-STRIP-001 — TASK-EQS-001
 *
 * `stripEmailQuote(sanitizedHtml)` — the DOM analogue of `toTimelineBody`
 * (`backend/src/services/email/emailTimelineBody.js`, the plain-text quote
 * stripper). Given the ALREADY-DOMPurify-sanitized HTML of an inbound email, it
 * removes the quoted thread history so only the NEW reply remains, and returns
 * the transformed HTML string.
 *
 * Pure: no React, no app singletons, no network. It parses via the built-in
 * `new DOMParser().parseFromString(html, 'text/html')`, mutates `doc.body`, and
 * re-serializes `doc.body.innerHTML`. `DOMParser` is a browser global; in the
 * headless verify harness it is injected as `global.DOMParser`, so this module
 * references `DOMParser` directly with no import. No new dependency (built-in).
 *
 * INPUT IS ALREADY SANITIZED — this transform runs on the OUTPUT of
 * `sanitizeEmailHtml(...)`, never on raw `body_html`. Removing nodes from an
 * already-sanitized tree can only reduce capability, so the XSS pipeline is
 * unaffected (`sanitizeEmailHtml.ts` is NOT modified). See spec D4/NFR-SEC-1.
 *
 * Design (spec EMAIL-QUOTE-STRIP-001, decision table + OQ-QS-A/B/C, D5):
 *   - ORDERED detection, first match wins, cut at the EARLIEST/OUTERMOST
 *     boundary. HIGH markers (rows 1–4) strip directly; LOW markers (rows 5–6)
 *     strip ONLY when corroborated. Bias: UNDER-strip (keep content) beats
 *     OVER-strip (lose the new reply).
 *   - CUT semantics: remove the boundary node and every node AFTER it in
 *     document order within <body> (the reply precedes the quote). Mirrors
 *     `toTimelineBody`'s "keep everything before the earliest boundary".
 *   - ATTRIBUTION removal (OQ-QS-A): also drop the single immediately-preceding
 *     sibling when it is an attribution line ("On … wrote:").
 *   - NEAR-EMPTY fallback (D5): if the stripped result has < 2 chars of visible
 *     text AND no meaningful media, return the ORIGINAL input unchanged.
 *   - SERIALIZE fidelity (OQ-QS-B): a body-level <style> that PRECEDES the quote
 *     survives (serialize from `document.body.innerHTML`).
 *   - FAIL-SAFE (NFR-SEC-2): the whole body is try/catch; on ANY error return
 *     the input unchanged (never raw, never '', never throw). null/undefined → ''.
 *   - IDEMPOTENT (NFR-COMPAT-2): a second pass finds no boundary → returns input.
 *
 * @module stripEmailQuote
 */

// ─── Attribution regexes — mirror emailTimelineBody.js l.36–40 verbatim so the
// verify-script CJS port (TASK-EQS-004) can parity-check them. ────────────────
/** Single-line Gmail/Apple attribution: `On <date>, <name> … wrote:`. */
const RE_ON_WROTE = /^\s*On\s.+\swrote:\s*$/;
/** First line of a wrapped attribution: `On <date>, <name> <addr>` (no `wrote:` yet). */
const RE_ON_START = /^\s*On\s.+$/;
/** Continuation line that ends a wrapped attribution: `… wrote:`. */
const RE_WROTE_END = /wrote:\s*$/;

/**
 * Whole-node attribution match: the node's collapsed text is a single-line
 * `On … wrote:` OR a hard-wrap where it starts `On …` and ends `… wrote:`
 * (the wrap collapsed inside one node). Used for the immediately-preceding
 * attribution sibling (OQ-QS-A).
 *
 * Internal whitespace — INCLUDING real newlines from a hard-wrapped
 * "On <date>,\n<name> wrote:" held in ONE node — is collapsed to a single space
 * before the single-line regexes run, because those regexes use `.` (no `s`
 * flag) and `$` (no `m` flag), so `.+` cannot cross a literal `\n`. This mirrors
 * the intent of `emailTimelineBody.js`, which splits the plain text on `\n` per
 * line; collapsing to one space is the DOM-side equivalent.
 */
function isAttributionText(text: string): boolean {
    // Collapse runs of whitespace (incl. newlines) to a single space so a
    // hard-wrapped attribution inside one node still matches the single-line RE.
    const t = text.replace(/\s+/g, ' ').trim();
    if (t === '') return false;
    if (RE_ON_WROTE.test(t)) return true;
    // 1–2-line hard wrap collapsed inside one node: starts `On …`, ends `… wrote:`.
    return RE_ON_START.test(t) && RE_WROTE_END.test(t);
}

/** Zero-width characters stripped by the near-empty normalizer (D5): ZWSP, ZWNJ, ZWJ, BOM. */
const ZERO_WIDTH_RE = /[​‌‍﻿]/g;

/** Remote/neutralized image detector for the media guard (mirrors REMOTE image state). */
function elementHasLiveImage(root: ParentNode): boolean {
    // An <img> counts as content if it has a live `src` OR a `data-blanc-src`
    // (a to-be-revealed remote image awaiting "Show images" still counts).
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

/**
 * A stripped body carries "meaningful media" iff it has a live/neutralized <img>,
 * a <table>, or a <picture> (D5 condition 2). An image-only reply must be KEPT.
 */
function hasMeaningfulMedia(body: HTMLElement): boolean {
    if (elementHasLiveImage(body)) return true;
    if (body.querySelector('table') !== null) return true;
    if (body.querySelector('picture') !== null) return true;
    return false;
}

/**
 * Normalized visible text = `textContent` with whitespace + zero-width chars
 * removed and trimmed. Used by the near-empty predicate (D5): length < 2 means
 * effectively empty (empty or a single stray glyph).
 */
function normVisibleTextLength(body: HTMLElement): number {
    const raw = body.textContent ?? '';
    const collapsed = raw.replace(ZERO_WIDTH_RE, '').replace(/\s+/g, '');
    return collapsed.length;
}

/**
 * The "outermost" matching ancestor for an element found by a selector: if the
 * hit is nested inside another element that ALSO matches the same selector, walk
 * up to the highest matching ancestor within <body>. This makes detectors 1–4
 * cut at the OUTERMOST boundary so no inner quote level survives (FR-6/S5).
 */
function outermostMatch(el: Element, selector: string, body: HTMLElement): Element {
    let top = el;
    let cur: Element | null = el.parentElement;
    while (cur !== null && cur !== body) {
        if (cur.matches(selector)) top = cur;
        cur = cur.parentElement;
    }
    return top;
}

/**
 * The boundary is some node inside <body>; we must cut at the top-level ancestor
 * that contains it (a direct child of <body>), because "everything after the
 * boundary" is defined at body level. Returns the body-child ancestor of `node`
 * (or `node` itself if it is already a body child).
 */
function bodyLevelAncestor(node: Node, body: HTMLElement): Node {
    let cur: Node = node;
    while (cur.parentNode !== null && cur.parentNode !== body) {
        cur = cur.parentNode;
    }
    return cur;
}

/**
 * Skippable when scanning for the "immediately-preceding meaningful sibling":
 * whitespace-only text nodes and comment nodes. DOMPurify strips comments by
 * default, but skipping them keeps the sibling scan robust if one survives.
 */
function isWhitespaceOnly(node: Node): boolean {
    if (node.nodeType === 8 /* COMMENT_NODE */) return true;
    if (node.nodeType === 3 /* TEXT_NODE */) {
        return (node.textContent ?? '').trim() === '';
    }
    return false;
}

/**
 * The immediately-preceding sibling of `node`, skipping whitespace-only text
 * nodes (OQ-QS-A inspects only this single sibling).
 */
function precedingMeaningfulSibling(node: Node): Node | null {
    let prev = node.previousSibling;
    while (prev !== null && isWhitespaceOnly(prev)) {
        prev = prev.previousSibling;
    }
    return prev;
}

/**
 * True iff nothing but whitespace/empty nodes follows `node` to the end of its
 * parent chain up to <body> — i.e. `node` is the TRAILING block (guard (b) for
 * row 5). Any following non-empty element or non-whitespace text → false.
 */
function isTrailingToBodyEnd(node: Node, body: HTMLElement): boolean {
    let cur: Node | null = node;
    while (cur !== null && cur !== body) {
        for (let sib = cur.nextSibling; sib !== null; sib = sib.nextSibling) {
            if (sib.nodeType === 3 /* TEXT_NODE */) {
                if ((sib.textContent ?? '').trim() !== '') return false;
            } else if (sib.nodeType === 1 /* ELEMENT_NODE */) {
                const el = sib as Element;
                // A following element with any text or media is real trailing content.
                if ((el.textContent ?? '').trim() !== '') return false;
                if (elementHasLiveImage(el)) return false;
                if (el.querySelector('table, picture') !== null) return false;
                // otherwise an empty following element (e.g. <br>) is ignorable.
            }
        }
        cur = cur.parentNode;
    }
    return true;
}

/**
 * A boundary decision: the node to cut at (its body-level ancestor is removed
 * along with all following body children) and whether to also try removing a
 * preceding attribution sibling of the ORIGINAL boundary element.
 */
interface Boundary {
    /** The detected boundary node (element or text node). */
    node: Node;
    /**
     * For element boundaries (rows 1–5) inspect/remove the immediately-preceding
     * attribution sibling (OQ-QS-A). For the text-fallback (row 6) the attribution
     * node itself IS the boundary, so this is false.
     */
    checkAttribution: boolean;
}

/**
 * Find the earliest/outermost quote boundary per the ordered decision table.
 * Returns null when nothing qualifies (→ passthrough). Rows are evaluated in
 * table order; the first matching row wins. HIGH rows strip directly; LOW rows
 * (5–6) only when their guard holds.
 */
function findBoundary(body: HTMLElement): Boundary | null {
    // ── Row 1: .gmail_quote (Gmail) — HIGH. Outermost match, earliest in doc order.
    const gmail = body.querySelector('.gmail_quote');
    if (gmail !== null) {
        return { node: outermostMatch(gmail, '.gmail_quote', body), checkAttribution: true };
    }

    // ── Row 2: blockquote[type="cite"] (Apple Mail) — HIGH.
    const cite = body.querySelector('blockquote[type="cite"]');
    if (cite !== null) {
        return { node: outermostMatch(cite, 'blockquote[type="cite"]', body), checkAttribution: true };
    }

    // ── Row 3a: #appendonsend (Outlook) — HIGH. Outlook puts the quote AFTER this
    // anchor div; cutting at its body-level ancestor removes it + following siblings.
    const appendOnSend = body.querySelector('#appendonsend');
    if (appendOnSend !== null) {
        return { node: appendOnSend, checkAttribution: true };
    }

    // ── Row 4: .yahoo_quoted (Yahoo) — HIGH.
    const yahoo = body.querySelector('.yahoo_quoted');
    if (yahoo !== null) {
        return { node: outermostMatch(yahoo, '.yahoo_quoted', body), checkAttribution: true };
    }

    // ── Row 3b: Outlook border-top separator — CONSERVATIVE. A <div> whose inline
    // style has `border-top:...solid...`, immediately preceded (skipping whitespace)
    // by a From:/Sent:/To:/Subject: header run. Only on that exact shape (OQ-QS-C).
    const borderTop = findOutlookBorderTopDiv(body);
    if (borderTop !== null) {
        // Attribution sibling check is redundant here (the header run is the marker),
        // but harmless to leave off — the header run itself is inside the cut region
        // when the div is a body child? No: the header run precedes the div. We keep
        // checkAttribution false since the header run is not an "On … wrote:" line.
        return { node: borderTop, checkAttribution: false };
    }

    // ── Row 5: first top-level <blockquote> — LOW / GUARDED. Strip ONLY IF
    // (a) immediately preceded by an attribution line, OR (b) it is the trailing
    // block. A mid-body <blockquote> with real content after it → KEEP.
    const topBlockquote = firstTopLevelBlockquote(body);
    if (topBlockquote !== null) {
        const prev = precedingMeaningfulSibling(topBlockquote);
        // `textContent` exists on any Node (element or text), so no cast is needed.
        const attributedBefore = prev !== null && isAttributionText(prev.textContent ?? '');
        const trailing = isTrailingToBodyEnd(topBlockquote, body);
        if (attributedBefore || trailing) {
            return { node: topBlockquote, checkAttribution: true };
        }
        // guard fails → do NOT cut here; fall through to the text fallback.
    }

    // ── Row 6: text fallback — an attribution line ("On … wrote:") as a node,
    // possibly a 1–2-line hard-wrap split across sibling nodes. Cut FROM it.
    const attrBoundary = findAttributionTextBoundary(body);
    if (attrBoundary !== null) {
        return { node: attrBoundary, checkAttribution: false };
    }

    return null;
}

/**
 * Row 3b helper — a <div> with inline `border-top:…solid…` immediately following
 * a From:/Sent:/To:/Subject: header run. Very conservative: the div must be a
 * body-level child (or become one via its ancestor) and its preceding meaningful
 * sibling text must look like an Outlook header line.
 */
const RE_BORDER_TOP_SOLID = /border-top\s*:[^;]*solid/i;
const RE_OUTLOOK_HEADER_RUN = /^\s*(?:From|Sent|To|Subject)\s*:/i;

function findOutlookBorderTopDiv(body: HTMLElement): Element | null {
    const divs = body.querySelectorAll('div[style]');
    for (let i = 0; i < divs.length; i++) {
        const div = divs[i];
        const style = div.getAttribute('style') ?? '';
        if (!RE_BORDER_TOP_SOLID.test(style)) continue;
        const prev = precedingMeaningfulSibling(div);
        if (prev === null) continue;
        const prevText = prev.textContent ?? '';
        if (RE_OUTLOOK_HEADER_RUN.test(prevText)) {
            return div;
        }
    }
    return null;
}

/**
 * The first top-level <blockquote> (a direct child of <body>, or whose body-level
 * ancestor is itself a <blockquote> — i.e. an outermost blockquote). We only treat
 * a blockquote that is a body child as "top-level" to avoid selecting a blockquote
 * nested inside real reply markup.
 */
function firstTopLevelBlockquote(body: HTMLElement): Element | null {
    for (let child = body.firstElementChild; child !== null; child = child.nextElementSibling) {
        if (child.tagName === 'BLOCKQUOTE') return child;
    }
    return null;
}

/**
 * Row 6 — locate an attribution text boundary. Walks the body-level children in
 * document order; returns the first node whose collapsed text is an attribution
 * line, OR the first node beginning a 1–2-line hard-wrap that a following sibling
 * (within 2, no blank break) ends with `… wrote:`. The returned node is the cut
 * point (it + everything after is removed).
 */
function findAttributionTextBoundary(body: HTMLElement): Node | null {
    const children: Node[] = [];
    for (let n = body.firstChild; n !== null; n = n.nextSibling) {
        children.push(n);
    }
    for (let i = 0; i < children.length; i++) {
        const node = children[i];
        const text = (node.textContent ?? '');
        if (text.trim() === '') continue;

        // Whole-node single-line or collapsed-wrap attribution.
        if (isAttributionText(text)) return node;

        // Wrap split across sibling nodes: this node starts `On …` (no `wrote:` yet),
        // and a following non-blank sibling within 2 ends `… wrote:`.
        if (RE_ON_START.test(text.trim()) && !RE_WROTE_END.test(text.trim())) {
            for (let j = i + 1; j <= i + 2 && j < children.length; j++) {
                const jt = (children[j].textContent ?? '');
                if (jt.trim() === '') break; // blank breaks the wrapped attribution
                if (RE_WROTE_END.test(jt.trim())) return node; // cut from the `On …` start
            }
        }
    }
    return null;
}

/**
 * Remove `boundary` (via its body-level ancestor) and every body child after it.
 * The reply precedes the quote, so this keeps only the pre-boundary content.
 * When `checkAttribution` is set, also remove the immediately-preceding
 * attribution sibling of the ORIGINAL boundary element (OQ-QS-A), including a
 * two-node wrap (the `On …` node + the `… wrote:` node).
 */
function cutAtBoundary(boundary: Boundary, body: HTMLElement): void {
    const cutNode = bodyLevelAncestor(boundary.node, body);

    // OQ-QS-A: remove a preceding attribution sibling of the boundary element.
    if (boundary.checkAttribution) {
        removeAttributionSibling(boundary.node);
        // Also handle an attribution whose wrap sits at body level just before the
        // body-level ancestor (when the boundary element is nested and its attribution
        // was a sibling of the ancestor).
        if (cutNode !== boundary.node) {
            removeAttributionSibling(cutNode);
        }
    }

    // Remove all body children AFTER cutNode (document order), then cutNode itself.
    const toRemove: Node[] = [];
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

/**
 * Inspect the single immediately-preceding sibling of `node` (skipping
 * whitespace-only text nodes). Remove it iff it matches the attribution shape.
 * Handles a two-node hard wrap: if the nearest sibling ends `… wrote:` but does
 * not itself start `On …`, look one sibling further back for the `On …` start and
 * remove BOTH. If it does not match, leave it (under-reach beats over-reach).
 */
function removeAttributionSibling(node: Node): void {
    const prev = precedingMeaningfulSibling(node);
    if (prev === null) return;
    const prevText = (prev.textContent ?? '');

    // Case 1: the sibling by itself is a (single-line or collapsed-wrap) attribution.
    if (isAttributionText(prevText)) {
        if (prev.parentNode !== null) prev.parentNode.removeChild(prev);
        return;
    }

    // Case 2: two-node hard wrap — this sibling ends `… wrote:` but doesn't start
    // `On …`; the node before it starts `On …`. Remove both (no blank break).
    if (RE_WROTE_END.test(prevText.trim()) && !RE_ON_START.test(prevText.trim())) {
        const prev2 = precedingMeaningfulSibling(prev);
        if (prev2 !== null && RE_ON_START.test((prev2.textContent ?? '').trim())) {
            if (prev.parentNode !== null) prev.parentNode.removeChild(prev);
            if (prev2.parentNode !== null) prev2.parentNode.removeChild(prev2);
        }
    }
}

/**
 * Reunite head-hoisted style into body (OQ-QS-B / AC-13 fidelity). When this
 * module re-parses the sanitized string via `new DOMParser().parseFromString`,
 * the HTML5 tree builder HOISTS a LEADING body-level `<style>` (and
 * `<link rel="stylesheet">`) into `<head>`. Since we serialize `doc.body.innerHTML`
 * (head excluded), such a leading `<style>` would VANISH whenever a boundary is
 * cut. These nodes were body-level in the sanitized input (DOMPurify FORCE_BODY);
 * only this re-parse hoisted them. Move each `<head>` `<style>`/stylesheet `<link>`
 * back to the TOP of `<body>`, preserving their relative order, so the existing
 * `body.innerHTML` serialize keeps them.
 */
function reuniteHeadStyleIntoBody(doc: Document): void {
    const head = doc.head;
    const body = doc.body;
    if (head === null || body === null) return;
    const nodes = head.querySelectorAll('style, link[rel="stylesheet"]');
    // Insert at the top of body. Iterate in REVERSE and always insert before the
    // current first child so the original relative order is preserved.
    for (let i = nodes.length - 1; i >= 0; i--) {
        body.insertBefore(nodes[i], body.firstChild);
    }
}

/**
 * Strip quoted thread history from already-sanitized inbound-email HTML, keeping
 * only the new reply. Pure, never throws. See module doc for the full contract.
 *
 * @param sanitizedHtml  the OUTPUT of `sanitizeEmailHtml(...)` (already
 *                       DOMPurify-sanitized). May be null/undefined/''.
 * @returns              the stripped HTML string, or the input unchanged
 *                       (no boundary / near-empty fallback / any failure).
 */
export function stripEmailQuote(sanitizedHtml: string | null | undefined): string {
    // null/undefined → '' (matches the sanitizer's empty sentinel).
    if (sanitizedHtml == null) return '';
    // Empty/whitespace → return as-is (nothing to strip).
    if (sanitizedHtml.trim() === '') return sanitizedHtml;

    try {
        const doc = new DOMParser().parseFromString(sanitizedHtml, 'text/html');
        const body = doc.body;
        if (body === null) return sanitizedHtml;

        // Reunite any head-hoisted body-level <style>/<link> back into <body> BEFORE
        // the cut/serialize so a leading author <style> is not dropped (OQ-QS-B).
        reuniteHeadStyleIntoBody(doc);

        const boundary = findBoundary(body);
        // No boundary → passthrough unchanged (byte-identical no-op → idempotent).
        if (boundary === null) return sanitizedHtml;

        cutAtBoundary(boundary, body);

        // Near-empty fallback (D5): if the stripped body has < 2 chars of visible
        // text AND no meaningful media, return the ORIGINAL input unchanged.
        if (normVisibleTextLength(body) < 2 && !hasMeaningfulMedia(body)) {
            return sanitizedHtml;
        }

        return body.innerHTML;
    } catch {
        // Fail-safe: on ANY error return the input unchanged — never raw (it is
        // already sanitized), never '', never a throw reaching React.
        return sanitizedHtml;
    }
}
