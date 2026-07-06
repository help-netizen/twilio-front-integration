import DOMPurify from 'dompurify';

/**
 * EMAIL-HTML-RENDER-001 — TASK-EHR-001
 *
 * The SINGLE source of the email-HTML sanitization config for the whole app.
 * Pure module (no React) so it is unit-testable in isolation.
 *
 * `sanitizeEmailHtml(html, { allowImages })` runs `DOMPurify.sanitize` under one
 * app-wide config. DOMPurify defaults strip `<script>`, inline `on*` handlers, and
 * `<iframe>` — but NOT `<form>`/`<input>`/`<button>`/`<select>`/`<textarea>` (those
 * survive the default fragment sanitize). So we EXPLICITLY strip every form /
 * credential-capture control via `FORBID_TAGS` (closes the phishing-form hole).
 * `<style>` is likewise NOT kept by the default fragment sanitize, so we re-admit
 * it with `ADD_TAGS: ['style']` + `FORCE_BODY: true` on purpose (a leading `<style>`
 * in a bare fragment is otherwise hoisted away by the HTML parser; `FORCE_BODY`
 * wraps parsing in an explicit `<body>` so the element is preserved without adding
 * an `<html>/<head>` wrapper). DOMPurify still sanitizes the CSS, and the caller
 * (`SafeEmailHtml`) renders it inside an isolated shadow root, so a surviving author
 * `<style>` gives fidelity yet cannot affect the host app.
 *
 * An `afterSanitizeAttributes` hook then, per surviving node:
 *   (a) forces every `<a>` to `target="_blank" rel="noopener noreferrer"`, and
 *       nulls any `href` matching `^\s*(javascript|data):`i (block js:/data: on
 *       LINKS; mailto:/tel:/http(s)/protocol-relative survive);
 *   (b) neutralizes `cid:` `<img>` sources in BOTH image states — a `cid:` can
 *       never resolve on the timeline path (no attachment plumbing in v1), so it
 *       is ALWAYS moved to `data-blanc-src` regardless of `allowImages` rather
 *       than left as a broken live `src`. Remote / protocol-relative `<img>`
 *       sources are neutralized only when `!allowImages` (`src` -> `data-blanc-src`,
 *       strip `srcset`, strip inline `background`) so no read-beacon fires on first
 *       render. `data:` image `src` is ALLOWED in both states.
 *
 * Passing `allowImages` to the hook:
 *   DOMPurify hooks fire SYNCHRONOUSLY inside the `sanitize` call, so a
 *   module-scoped `allowImagesFlag` set immediately before `sanitize(...)` and
 *   read inside the hook is race-free. There is no re-entrancy (one sanitize at a
 *   time on this singleton).
 *
 * Global-leak guard: the hook is registered with `addHook` right before the
 * sanitize call and torn down with `removeHook` right after (in a `finally`), so
 * an unrelated bare `DOMPurify.sanitize(x)` elsewhere never inherits the forced
 * target/rel or the image neutralize.
 *
 * Fail-safe: the whole body is wrapped in try/catch; on ANY throw (and on
 * null/undefined/empty input) it returns the sentinel empty string `''`, never
 * raw HTML. Callers treat `''` as "sanitize failed / nothing to render" and fall
 * back to the linkify plain-text path.
 */

// Set immediately before each `DOMPurify.sanitize(...)` call, read inside the
// (synchronous) hook. See module doc for why this is safe.
let allowImagesFlag = false;

const JS_OR_DATA_HREF = /^\s*(?:javascript|data):/i;
const REMOTE_IMG_SRC = /^\s*(?:https?:)?\/\//i; // http:, https:, or protocol-relative //
const CID_IMG_SRC = /^\s*cid:/i;

/**
 * `afterSanitizeAttributes` hook. `node` is the element DOMPurify just sanitized.
 * Guarded lazily via `hookInstalled` so it is only ever added once per call and
 * removed after (global-leak guard).
 */
function afterSanitizeAttributes(node: Element): void {
    const tag = node.tagName;

    if (tag === 'A') {
        // (a) Force safe link behavior on EVERY surviving anchor (overwrite, not fill).
        node.setAttribute('target', '_blank');
        node.setAttribute('rel', 'noopener noreferrer');

        // (b) Block javascript:/data: on links (data: images are handled separately below).
        const href = node.getAttribute('href');
        if (href !== null && JS_OR_DATA_HREF.test(href)) {
            node.removeAttribute('href');
        }
        return;
    }

    if (tag === 'IMG') {
        const src = node.getAttribute('src');
        // cid: can never resolve on the timeline path (no attachment plumbing in
        // v1) -> ALWAYS neutralize it, regardless of allowImages, so it is never a
        // live broken src. Remote / protocol-relative sources are neutralized only
        // when images are OFF. data: image src is intentionally NOT matched here,
        // so it stays live in both states.
        if (src !== null && (CID_IMG_SRC.test(src) || (!allowImagesFlag && REMOTE_IMG_SRC.test(src)))) {
            node.setAttribute('data-blanc-src', src);
            node.removeAttribute('src');
        }
        if (!allowImagesFlag) {
            // srcset can also fetch remote images regardless of the primary src -> strip it.
            if (node.hasAttribute('srcset')) {
                node.removeAttribute('srcset');
            }
            // Legacy/HTML `background` attribute can point at a remote asset -> strip it.
            if (node.hasAttribute('background')) {
                node.removeAttribute('background');
            }
        }
        return;
    }
}

export interface SanitizeEmailHtmlOptions {
    allowImages?: boolean;
}

/**
 * Sanitize attacker-controlled email HTML. See module doc for the full contract.
 *
 * @param html        raw email HTML (may be null/undefined/empty)
 * @param opts        `{ allowImages }` — default false (remote images neutralized)
 * @returns           sanitized HTML string, or `''` on empty input / any failure
 */
export function sanitizeEmailHtml(
    html: string | null | undefined,
    opts?: SanitizeEmailHtmlOptions
): string {
    if (html == null) return '';
    if (html.trim() === '') return '';

    const allowImages = opts?.allowImages ?? false;

    try {
        allowImagesFlag = allowImages;
        DOMPurify.addHook('afterSanitizeAttributes', afterSanitizeAttributes);
        try {
            // DOMPurify defaults strip <script>/on*/<iframe> but NOT <form>+controls
            // -> FORBID_TAGS strips every form/credential-capture control (anti-phishing).
            // ADD_TAGS re-admits <style> (still CSS-sanitized) so the caller can shadow-scope
            // it; FORCE_BODY keeps a leading <style> from being hoisted out of the fragment.
            // RETURN_TRUSTED_TYPE:false guarantees a plain string return type.
            const clean = DOMPurify.sanitize(html, {
                FORBID_TAGS: ['form', 'input', 'button', 'select', 'textarea', 'option', 'optgroup', 'label', 'fieldset', 'legend'],
                ADD_TAGS: ['style'],
                FORCE_BODY: true,
                RETURN_TRUSTED_TYPE: false,
            });
            return typeof clean === 'string' ? clean : String(clean);
        } finally {
            // Global-leak guard: tear the hook down so other DOMPurify callers are unaffected.
            DOMPurify.removeHook('afterSanitizeAttributes');
            allowImagesFlag = false;
        }
    } catch {
        // Fail-safe: never surface raw HTML, never let a throw reach React.
        return '';
    }
}
