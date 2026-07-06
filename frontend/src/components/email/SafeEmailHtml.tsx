import { useEffect, useMemo, useRef } from 'react';
import type { CSSProperties } from 'react';
import { sanitizeEmailHtml } from '../../lib/sanitizeEmailHtml';
import { stripEmailQuote } from '../../lib/stripEmailQuote';

/**
 * EMAIL-HTML-RENDER-001 — TASK-EHR-008 (Contract 2 / OQ-3)
 *
 * A **controlled, dumb** renderer for sanitized email HTML. It mounts a host
 * `<div>` and, inside it, an **open Shadow DOM** so email `<style>`/class rules
 * and the app's global CSS are isolated from each other in BOTH directions
 * (the email can't restyle Pulse chrome; app Tailwind can't distort the email).
 *
 * Ownership boundary (per spec §Contract 2):
 *   - "Show images" is **NOT owned here**. The caller (EmailListItem /
 *     EmailMessageItem) holds `allowImages` state and renders its own button;
 *     flipping it to `true` re-sanitizes (with `allowImages:true`) and wholesale
 *     re-sets the shadow `innerHTML` — no stale DOM, no beacon race (the
 *     remote-image strip happens INSIDE the sanitize pass, so a remote `src` is
 *     never live in the DOM before neutralization).
 *   - Fallback on empty/failed sanitize is the CALLER's job. If
 *     `sanitizeEmailHtml` returns `''`, the shadow root is left empty and this
 *     component renders nothing (no linkify here). See render matrix M5.
 *
 * Perf (NFR-PERF-1): `sanitizeEmailHtml` is memoized by the key
 * `(messageId ?? hash(html), allowImages)`, and the shadow `innerHTML` is
 * re-set ONLY when that sanitized string changes — once per message per
 * images-state, not per scroll/re-render. The shadow root is attached ONCE
 * (attaching twice throws).
 */

/**
 * Base stylesheet injected once into the shadow root (OQ-HR-A — RESOLVED).
 *
 * Exactly 8 declarations. This supplies *defaults* for a BARE, `<html>`-less
 * unstyled email so it stays legible and matches Albusto typography — WITHOUT
 * overriding a *styled* email (author inline/`<style>` rules are more specific
 * or later in order, so these element-selector defaults yield). Deliberately NO
 * global reset, NO `all:initial`, NO font-size override — those would flatten a
 * styled marketing email.
 *
 * `font-family:inherit; color:inherit` pull IBM Plex + `--blanc-ink-1` in from
 * the host; `a{color:var(--blanc-info)}` is the ONE app-token bridge — CSS
 * custom properties inherit through the shadow boundary, so `--blanc-info`
 * resolves from the app `:root`. `img/table max-width:100%` + the host's
 * `overflow-x:auto` form the D2/FR-4 cage: wide content scrolls INSIDE the
 * bubble instead of widening the app.
 */
const BASE_SHEET = [
    ':host { display: block; }',
    '* { box-sizing: border-box; }',
    'body, div, p, span, td, li { font-family: inherit; color: inherit; line-height: 1.5; }',
    'a { color: var(--blanc-info); }',
    'img { max-width: 100%; height: auto; }',
    'table { max-width: 100%; border-collapse: collapse; }',
    'pre, code { white-space: pre-wrap; word-break: break-word; }',
    'p { margin: 0 0 0.5em; }',
].join('\n');

/**
 * Tiny, stable string hash (djb2) used ONLY to derive a memo key when no
 * `messageId` is supplied. Not security-sensitive — just a cheap, deterministic
 * cache key so identical `html` re-uses the same sanitize result.
 */
function hashString(input: string): number {
    let h = 5381;
    for (let i = 0; i < input.length; i++) {
        // h * 33 + charCode, kept in 32-bit range via `| 0`.
        h = ((h << 5) + h + input.charCodeAt(i)) | 0;
    }
    return h;
}

export interface SafeEmailHtmlProps {
    /** Raw, attacker-controlled email HTML. Sanitized before it touches the DOM. */
    html: string;
    /** Controlled by the caller. When true, remote images are allowed through. */
    allowImages?: boolean;
    /**
     * Opt-in (EMAIL-QUOTE-STRIP-001). When true, the sanitized HTML is passed
     * through `stripEmailQuote(...)` inside the memo so quoted thread history is
     * removed and only the new reply renders (Pulse timeline bubble, M1). When
     * false (default) the sanitized string is returned unchanged — the `/email`
     * workspace path stays byte-for-behavior identical to today.
     */
    stripQuotedHistory?: boolean;
    /** Stable per-message id; anchors the sanitize memo. Falls back to hash(html). */
    messageId?: string | number;
    /** Applied to the host `<div>` (merged with the built-in overflow cage). */
    className?: string;
    /** Applied to the host `<div>` (merged AFTER the built-in cage styles). */
    style?: CSSProperties;
}

/**
 * Renders sanitized email HTML inside an open Shadow DOM. Controlled/dumb: the
 * caller owns `allowImages` (+ any "Show images" button) and the empty-body
 * fallback. Renders nothing when the sanitizer yields `''`.
 */
export default function SafeEmailHtml({
    html,
    allowImages = false,
    stripQuotedHistory = false,
    messageId,
    className,
    style,
}: SafeEmailHtmlProps) {
    const hostRef = useRef<HTMLDivElement | null>(null);
    // Cache the attached shadow root; attaching twice on the same host throws.
    const shadowRef = useRef<ShadowRoot | null>(null);

    // NFR-PERF-1: sanitize once per (message, images-state). Key includes
    // messageId (or a hash of html when absent) + allowImages so a scroll or
    // an unrelated re-render with the same inputs does NOT re-sanitize.
    const memoKey = messageId ?? hashString(html);
    const sanitized = useMemo(
        () => {
            const clean = sanitizeEmailHtml(html, { allowImages });
            // Opt-in quote strip (EMAIL-QUOTE-STRIP-001): applied to the
            // ALREADY-sanitized string, never raw html. No-op when the flag is
            // false, so the workspace path is unchanged.
            return stripQuotedHistory ? stripEmailQuote(clean) : clean;
        },
        // memoKey stands in for `html`; both are derived from it. allowImages
        // flips the image-neutralize branch; stripQuotedHistory flips the strip
        // step — both must be in the key so it runs once per (message, images,
        // strip-state), not per scroll/re-render.
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [memoKey, allowImages, stripQuotedHistory],
    );

    useEffect(() => {
        const host = hostRef.current;
        if (!host) return;

        // Attach the OPEN shadow root exactly once, then reuse it. Guard against
        // re-attach (double-attach throws) — covers StrictMode double-invoke and
        // any host that already carries a shadow root.
        if (!shadowRef.current) {
            shadowRef.current = host.shadowRoot ?? host.attachShadow({ mode: 'open' });
        }
        const root = shadowRef.current;

        // Sentinel: sanitize failed or empty → leave the shadow empty (render
        // nothing). The caller's branch handles the linkify fallback (M5).
        if (!sanitized) {
            root.innerHTML = '';
            return;
        }

        // Wholesale re-set: base sheet first (so author rules override the
        // defaults), then the sanitized email. Re-runs only when `sanitized`
        // changes (i.e. the memo key moved), not on every render.
        root.innerHTML = `<style>${BASE_SHEET}</style>${sanitized}`;
    }, [sanitized]);

    // Host = the horizontal-scroll cage (D2): no max-height, no expand/collapse.
    // Wide emails scroll horizontally INSIDE this host; they can't widen the app.
    // Caller `style` is spread last so it can extend (not fight) the cage.
    const hostStyle: CSSProperties = {
        maxWidth: '100%',
        overflowX: 'auto',
        ...style,
    };

    return <div ref={hostRef} className={className} style={hostStyle} />;
}
