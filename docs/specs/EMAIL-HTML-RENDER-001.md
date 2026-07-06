# EMAIL-HTML-RENDER-001 — render inbound email bodies in the Pulse timeline as sanitized HTML (shared sanitizer; outbound & no-HTML fall back to escape-then-linkify)

**Status:** Spec (ready for TestCases/Planner) · **Priority:** P1 · **Date:** 2026-07-06
**Area:** Pulse timeline email bubble (`EmailListItem`) · shared email sanitizer (`SafeEmailHtml` + `sanitizeEmailHtml`) · plain-text linkifier · `/email` workspace parity · timeline email projection (backend read + type)
**Type:** feature — frontend-primary + small backend read/type change. **No migration. No new endpoint. No new settings field.**
**Depends on:** EMAIL-TIMELINE-001 (email as a first-class Pulse citizen; `getTimelineEmailByContact`, `PulseTimeline` bubble render, `EmailTimelineItem` type), EMAIL-001 / EMAIL-OUTBOUND-001 (Gmail sync populates `email_messages.body_html`; `/email` workspace + `EmailMessageItem`), CONTACT-EMAIL-MERGE-001 / EMAIL-LEAD-ORIGIN-001 (company+contact scoping of the email link path).
**Follows precedent:** the app's DOMPurify-as-sanitizer posture (no CSP/helmet/sandboxed-iframe — sanitization is the only XSS control; not changed here); LIST-PAGINATION-001 / created_by-FK lessons (verify against a **real prod-DB copy** + a real browser, not only mocked Jest); ONBOARD-FIX-001 / ZB-ISO-001 (company scoping is P0).

Binding customer decisions **D1–D6** (requirements §EMAIL-HTML-RENDER-001) and the three architecture decisions **OQ-1/2/3** (architecture.md §EMAIL-HTML-RENDER-001) are **inputs**, encoded faithfully below — not re-litigated. This spec resolves the residual **OQ-HR-A/B/C** the Architect routed here.

---

## Problem

Inbound emails in the Pulse timeline (`frontend/src/components/pulse/EmailListItem.tsx`, l.81–88) render as **plain text only** — `email.body_text` inside a `<p class="whitespace-pre-wrap">`, with the standing comment *"Text-only — no HTML render (v1)."* Rich emails collapse into a wall of text with **non-clickable links**. The canonical case is Google Local Services lead emails (`customer-request-…@awexpress.google.com`) at `/pulse/timeline/3044`: ~39 KB of HTML with buttons and links the agent currently cannot click, on exactly the highest-intent inbound (new leads).

The HTML is already synced and already rendered safely elsewhere: `email_messages.body_html` (TEXT, mig 079) is populated for 499/500 recent inbound, and the separate `/email` workspace renders it via `DOMPurify.sanitize(...)` in `EmailMessageItem.tsx` (l.87–92). This feature brings that sanitized-HTML render into the **timeline bubble for inbound emails only**, behind **one shared sanitizer** (reused by the workspace), with the security posture made explicit, **remote images blocked by default**, and **true style isolation via Shadow DOM** so a ~600 px marketing email cannot break or re-style the app. **Outbound** emails and the rare **no-HTML inbound** fall back to **escape-then-linkify** plain text.

---

## Binding design (from the Architect — this spec encodes it faithfully)

- **Containment = Shadow DOM (OQ-3).** `SafeEmailHtml` renders a host `<div>`, attaches an **open shadow root once**, and sets `shadowRoot.innerHTML = DOMPurify.sanitize(html, config)`. A shadow root is the only non-iframe mechanism giving **two-way** style isolation: the email's `<style>`/class rules cannot restyle the app chrome, **and** the app's global CSS cannot distort the email. No CSP/iframe posture change — DOMPurify stays the security control; the shadow root is purely the layout/style boundary.
- **Base sheet inside the shadow (OQ-HR-A, resolved below).** A minimal reset `<style>` node is injected into the shadow root so **bare/unstyled** HTML emails stay legible without fighting a styled email's own CSS. App Tailwind is **not** imported into the shadow.
- **Sanitizer config + hooks live in a pure module** `frontend/src/lib/sanitizeEmailHtml.ts` (`sanitizeEmailHtml(html, { allowImages }): string`) — testable without React. `SafeEmailHtml.tsx` is the shadow-root wrapper around it.
- **Containment mechanics (D2 = inline, NO `max-height`, NO expand):** the **host** carries `max-width:100%; overflow-x:auto` (the horizontal-scroll cage); the base sheet sets `:host{display:block}` + `img{max-width:100%}`. Wide content scrolls **inside the bubble**; no height cap, no collapse. `contain:content` on the host is optional (paint/layout perf only).
- **OQ-1 images:** `data:` images = **ALLOW** (self-contained, no beacon); remote `http(s)` (and protocol-relative `//`) images = **BLOCKED by default** + per-email **"Show images"**; `cid:` images = **HIDE** in v1 (no attachment-fetch plumbing on the timeline path).
- **OQ-2 quote-collapse:** render `body_html` **RAW / full** in v1 (no HTML quote-collapse). `body_text` stays quote-stripped via `toTimelineBody`; the HTML bubble intentionally shows the full thread (EC-8). Future work (OQ-HR-B).
- **Backend (D6):** add `body_html` to the timeline email projection (read SELECT + route mapping + service mapping + TS type). **No migration** (column exists). Company+contact scoping **unchanged**. `body_text` and the `body_text ILIKE` search path are **untouched**.

### OQ-HR resolutions (routed to this spec)

- **OQ-HR-A — RESOLVED (shadow base sheet).** Pinned to **8 declarations**, spec §"Shadow base stylesheet" below. Scoped `:host` + a handful of element rules; no app Tailwind, no aggressive reset that would flatten a styled email.
- **OQ-HR-B — NOTED as future.** HTML quote-collapse is **out of scope v1**; the bubble renders the full raw HTML. If Product later wants parity with the trimmed text preview, it is a separate feature (client-side DOM heuristics vs a server-side `body_html`-stripping pass). Tracked at EC-8.
- **OQ-HR-C — TURNED INTO an implementer requirement (see §Implementer notes).** DOMPurify `3.2.7` is in `frontend/package-lock.json` (l.7773) and imported by `EmailMessageItem`, but is **NOT** an explicit `dependencies` entry in `frontend/package.json` (verified). The Implementer **MUST** add the explicit pinned entry `"dompurify": "3.2.7"` in the same PR. This is **still "no new package"** (already resolved & installed) — it only closes a fresh-install/`npm ci` gap where the hoisted dep could drop. Add `@types/dompurify` **only if** the build (`npm run build` = `tsc -b`, stricter than `--noEmit`) demands types not already bundled by dompurify 3.x.

---

## Contracts (no new HTTP endpoint)

There is **no new API route** and **no change to request shape or middleware**. `GET /api/pulse/timeline*` keeps its `authenticate` + `requireCompanyAccess` chain and its `pulse.view` gate; the email items in its response gain **one additive field** (`body_html`). Three internal/frontend contracts are added or changed.

### Contract 1 — `sanitizeEmailHtml(html, { allowImages }): string` — NEW (pure module `frontend/src/lib/sanitizeEmailHtml.ts`)

- **Input:** `html: string` (raw, attacker-controlled), `{ allowImages?: boolean }` (default `false`).
- **Behavior:** runs `DOMPurify.sanitize(html, cfg)` under the **single** app-wide config (§"The single DOMPurify config"), with an `afterSanitizeAttributes` hook that (a) forces every surviving `<a>` → `target="_blank" rel="noopener noreferrer"`; (b) blocks `javascript:` and `data:` on link `href`; (c) when `!allowImages`, neutralizes remote images (`src`→`data-blanc-src`, strip `srcset` + inline `background`/`background-image` url()s), leaving `data:` `src` intact. Returns the sanitized HTML **string**.
- **Fail-safe (NFR-SEC-6):** the whole body is wrapped in try/catch. On any throw it returns the sentinel **empty string `''`** (never raw HTML). Callers treat `''` as "sanitize failed / nothing to render" → fall back to the linkify plain-text path.
- **Determinism:** for a given `(html, allowImages)` the output is stable (enables caller-side memoization). Hooks are **added once at module load and namespaced/removed per call** so a concurrent non-email `DOMPurify.sanitize` elsewhere is not affected (use `DOMPurify.sanitize(html, {...cfg, /* per-call hooks via a fresh instance or add/removeHook around the call */})` — implementer's exact mechanism, but the config MUST NOT leak globally onto other sanitize callers).
- **Returns:** sanitized HTML string, or `''` on empty input / failure.

### Contract 2 — `<SafeEmailHtml html allowImages? messageId? className? style? />` — NEW (`frontend/src/components/email/SafeEmailHtml.tsx`)

- **Props:** `{ html: string; allowImages?: boolean; messageId?: string | number; className?: string; style?: CSSProperties }`.
- **Behavior:** renders a host `<div>` (with `className`/`style`, plus the built-in `max-width:100%; overflow-x:auto`), attaches an **open** shadow root **once** (ref-callback/`useEffect`), injects the base stylesheet `<style>` node once, and sets `shadowRoot.innerHTML = sanitizeEmailHtml(html, { allowImages })`. Re-sets `innerHTML` **only** when the memo key `(messageId ?? hash(html), allowImages)` changes. Sanitize is `useMemo`'d by that key (NFR-PERF-1 — once per message per images-state, not per scroll/re-render).
- **"Show images" is NOT owned here.** `SafeEmailHtml` is a **controlled, dumb renderer**: the caller holds `allowImages` state and renders its own "Show images" button; toggling to `true` re-sanitizes and re-sets the shadow `innerHTML` (clean, no stale DOM, no beacon race — the remote-strip happens **inside** the sanitize pass, so a remote `src` is never live in the DOM before being neutralized).
- **Sentinel/empty:** if `sanitizeEmailHtml` returns `''`, `SafeEmailHtml` leaves the shadow root empty (renders nothing) — the caller's render branch is responsible for the linkify fallback (see decision matrix).

### Contract 3 — `linkifyToHtml(text): string` — NEW (pure module `frontend/src/lib/linkifyText.ts`)

- **Input:** `text: string` (plain text; may contain `\n`).
- **Behavior:** **escape FIRST** (`& < > " '` → entities) so the plain-text path can never inject HTML, THEN regex-wrap URLs (`https?://…` and bare `www.`), email addresses, and phone numbers into `<a target="_blank" rel="noopener noreferrer" href="…">` (`mailto:` for email, `tel:` for phone; phone display may reuse `lib/formatPhone.ts`). Preserves `whitespace-pre-wrap` line-break semantics (operate per-line / do not collapse `\n`). **No new dependency.**
- **Output usage:** injected via `dangerouslySetInnerHTML` on a **normal** (non-shadow) `<p class="whitespace-pre-wrap break-words">` — safe because the input was escaped before any `<a>` was wrapped around it.
- **Returns:** an HTML string of the escaped text with safe `<a>` wrappers.

### Contract 4 — `EmailTimelineItem` gains `body_html: string | null` — CHANGED (`frontend/src/types/pulse.ts`, ~l.39)

- Additive field. Older cached clients that ignore it keep working (they fall back to `body_text`) — COMPAT-2.

### Backend read contract (additive; shape only)

`GET /api/pulse/timeline*` email items gain `body_html` (RAW, un-quote-stripped). No new params, no new endpoint, no status-code change; response is a superset of today's. `body_text` is still present (quote-stripped, drives the fallback + outbound render).

---

## Frontend render decision matrix (`EmailListItem` — the primary change)

`EmailListItem` gains a `body_html` read, an `allowImages` `useState(false)`, and the branch below. The existing eyebrow/subject/timestamp chrome is untouched (D2 keeps it inline; the bubble's `max-w-[75%]` cage stays, and `SafeEmailHtml`'s host adds the horizontal-scroll cage inside it).

| # | direction | `body_html` non-empty | render |
|---|---|---|---|
| M1 | inbound | yes | `SafeEmailHtml(body_html, {allowImages})` **+ "Show images" control** (FR-1/5) |
| M2 | inbound | no/empty | `linkifyToHtml(body_text)` (FR-6, EC-1) |
| M3 | outbound | any (even if `body_html` present) | `linkifyToHtml(body_text)` (FR-7, EC-6) — sanitized-HTML **never** used |
| M4 | empty body (no html AND no text) | — | render nothing for the body; subject/timestamp still show (EC-7, existing `hasBody` guard) |
| M5 | inbound + `body_html` present but `sanitizeEmailHtml`→`''` (fail-safe) | — | fall through to `linkifyToHtml(body_text)` (AC-10) |

"Show images" appears **only** in the M1 branch (inbound HTML). It is a real focusable `<button>` with a visible label (NFR-A11Y-1); once clicked (`allowImages` → true) it may hide itself or offer re-collapse (re-collapse is **optional** in v1).

---

## Shadow base stylesheet (OQ-HR-A — RESOLVED, pinned)

A single `<style>` node injected once into the shadow root. **Goal:** a *bare* `<html>`-less unstyled email (plain `<p>`/`<a>`/`<table>` with no author CSS) is legible and matches Albusto typography, **without** overriding a *styled* email's own inline/`<style>` rules (author styles are more specific / later, so element-selector defaults yield). Keep to ~8 declarations; do **not** import app Tailwind.

```css
:host { display: block; }
* { box-sizing: border-box; }
body, div, p, span, td, li { font-family: inherit; color: inherit; line-height: 1.5; }
a { color: var(--blanc-info); }               /* bridged literal; see note */
img { max-width: 100%; height: auto; }        /* never overflow the bubble cage */
table { max-width: 100%; border-collapse: collapse; }  /* wide tables scroll via host overflow-x */
pre, code { white-space: pre-wrap; word-break: break-word; }  /* long tokens wrap, don't force page-width */
p { margin: 0 0 0.5em; }                        /* minimal vertical rhythm for bare text */
```

**Notes / rationale:**
- `font-family: inherit; color: inherit` — the host `<div>` sits in Albusto chrome, so a bare email inherits IBM Plex + `--blanc-ink-1`. A styled email that sets its own `font-family`/`color` (inline or in its `<style>`) wins by specificity/order — we don't fight it.
- **`a { color: var(--blanc-info) }`** — CSS custom properties **do** pierce the shadow boundary (they inherit), so `--blanc-info` resolves inside the shadow from the app `:root`. If a future concern arises, substitute the literal hex; either is acceptable. This is the ONE app-token bridge; nothing else is imported.
- `img{max-width:100%}` + host `overflow-x:auto` = the D2/FR-4 cage: a 600 px image or table scrolls **inside** the bubble; it cannot widen the app.
- **What is deliberately NOT in the sheet:** no CSS reset that zeroes margins/padding globally, no `all:initial`, no font-size override — those would flatten a styled marketing email. This sheet only supplies *defaults* that any author rule overrides.
- **Confirm during implementation** against the 3044 Google-LSA mail (styled) AND a hand-crafted bare `<p>Hello <a href>link</a></p>` (unstyled): the styled one looks native; the bare one is legible.

---

## The single DOMPurify config (the ONLY one in the app — D5/FR-2/FR-3)

- **Strip (DOMPurify defaults):** `<script>`, inline `on*` handlers, `<form>` + form controls (`<input>/<button type=submit>/<select>/<textarea>`), `<iframe>`. No `ADD_TAGS`/`ADD_ATTR` that would re-admit them (NFR-SEC-2).
- **Forced safe links** — `afterSanitizeAttributes`: for every `<a>`, set `target="_blank"` and `rel="noopener noreferrer"` (NFR-SEC-3, AC-2). Applied even to `<a>` that had no `target`/`rel`.
- **Blocked URL schemes** — keep DOMPurify's default URI policy (drops `javascript:`); **additionally null the `href`** when it matches `^\s*(javascript|data):`i (so `data:` on **links** is blocked — an XSS vector — while `data:` on **images** is allowed, OQ-1/FR-3). Protocol-relative and `mailto:`/`tel:`/`https:`/`http:` links survive (then get forced `target`/`rel`).
- **Remote-image neutralize** (the toggle) — in the same hook, when `!allowImages` and `node` is `<img>` with `http(s)` or protocol-relative `//` `src`: move `src`→`data-blanc-src`, strip `srcset`, strip inline `background`/`background-image: url(...)` (best-effort). A `data:` `src` is left intact. When `allowImages` is true this branch is a **no-op** → `src` survives → images load. `cid:` `src` is neutralized/hidden (no plumbing) — treat like remote (moved off `src`) so it never emits a broken/looks-remote fetch.
- **Fail-safe** — try/catch returns `''` (Contract 1). Never raw HTML, never a throw that reaches React.
- **Global-leak guard** — the config/hooks MUST NOT permanently alter the shared `DOMPurify` singleton's behavior for any non-email caller (add/remove hooks around the call, or use a dedicated instance).

---

## Behavior scenarios

Each scenario lists **Preconditions → Steps → Expected / side-effects** and maps to acceptance criteria (AC-n) and functional requirements (FR-n). Scenario IDs are stable for the TestCases agent.

### S1 — Happy path: inbound Google-LSA HTML renders formatted, links/buttons clickable, shadow-isolated
- **Preconditions:** `/pulse/timeline/3044`; an **inbound** email whose `body_html` is the ~39 KB Google Local Services HTML (buttons + links + author `<style>`).
- **Steps:** (1) timeline REST projection returns the email item **including `body_html`** (backend change points #1+#2+#4); (2) `EmailListItem` takes branch **M1**: renders `SafeEmailHtml(body_html, {allowImages:false})` + a "Show images" button; (3) `SafeEmailHtml` attaches an open shadow root, injects the base sheet, sets `shadowRoot.innerHTML = sanitizeEmailHtml(...)`.
- **Expected / side-effects:** the email renders with its real formatting; links **and** buttons-styled-as-links are **clickable**, each opening in a **new tab** with `rel="noopener noreferrer"`; the render is **style-isolated** (the email's `<style>` does not touch app chrome; app CSS does not distort the email). No network image request yet (S2). (FR-1, D1/D2/D5; **AC-1**)

### S2 — Remote images blocked by default → "Show images" reveals them (re-collapse optional)
- **Preconditions:** an inbound HTML email containing a remote tracking-pixel `<img src="https://track…">` and/or content images.
- **Steps:** (1) initial render (M1, `allowImages:false`) — the neutralize hook moved `src`→`data-blanc-src`, stripped `srcset`/`background`; (2) agent clicks **"Show images"** → caller sets `allowImages:true` → `SafeEmailHtml` re-sanitizes (`allowImages:true`, no-op branch) and re-sets `shadowRoot.innerHTML`.
- **Expected:** on first render **no outbound image request fires** (sender gets no read-beacon, NFR-SEC-4); after the click, images load. `data:` images load on first render (allowed, no beacon). Re-collapse is optional v1. (FR-5, D3; **AC-4**)

### S3 — Inbound without `body_html` → linkified text
- **Preconditions:** the ~1/500 inbound email with empty/absent `body_html` but non-empty `body_text` containing a URL, an email address, and a phone number.
- **Steps:** `EmailListItem` takes branch **M2**: `linkifyToHtml(body_text)` → injected on a non-shadow `<p class="whitespace-pre-wrap break-words">`.
- **Expected:** plain-text render with the URL/email/phone turned into working `target="_blank" rel="noopener noreferrer"` links (`mailto:`/`tel:` for email/phone); line breaks preserved; **no new npm dependency**. (FR-6, D4, EC-1; **AC-5**)

### S4 — Outbound → linkified text, never HTML (even if `body_html` present)
- **Preconditions:** an **outbound** email in the same timeline that happens to carry a `body_html`.
- **Steps:** `EmailListItem` takes branch **M3** (direction=outbound short-circuits before any HTML check): `linkifyToHtml(body_text)`.
- **Expected:** outbound renders as plain text (links clickable per FR-6); sanitized-HTML is **never** invoked for outbound. In the 3044 timeline, an inbound renders HTML (S1) while an outbound renders plain text — side by side. (FR-7, D1/D4, EC-6; **AC-1**)

### S5 — Hostile HTML is neutralized (the security matrix) — assert exactly what remains
- **Preconditions:** an inbound email whose `body_html` contains every payload in the strip matrix below.
- **Steps:** M1 render → `sanitizeEmailHtml` runs.
- **Expected:** per the **Security strip matrix** (next section) — no script executes (no `alert`), no `onerror`/`onclick` survives, no `<form>`/`<iframe>` in the DOM, `javascript:` and `data:` **link** hrefs are nulled/dropped, the remote tracking-pixel `<img>` does not fetch; and **every surviving `<a>`** has `target="_blank"` + `rel="noopener noreferrer"`. (NFR-SEC-1/2/3/4, FR-3, EC-4/EC-5; **AC-2**)

### S6 — Style isolation both directions (email `<style>`/classes vs app CSS)
- **Preconditions:** an inbound email whose `<style>` sets `body{background:#000;color:#0f0} .btn{...}` and uses classes that collide with app class names (e.g. `.card`, `.header`).
- **Steps:** M1 render inside the shadow root.
- **Expected:** the email's `<style>`/classes style **only** content inside the bubble; the Pulse app chrome (sidebar, list, other bubbles) is **unchanged** and **un-restyled**; conversely the app's global CSS does not leak in to distort the email (fidelity preserved). No class-name collision crosses the shadow boundary. (FR-4, D2, EC-3; **AC-3**)

### S7 — Huge (~39 KB) HTML + wide table: no scroll jank, horizontal scroll stays in the bubble
- **Preconditions:** the 3044 mail (~39 KB) plus a ~600 px-wide `<table>`; a long timeline with several such emails.
- **Steps:** render + scroll the timeline; toggle "Show images" on one item.
- **Expected:** sanitize runs **once per message per images-state** (memoized by `(messageId, allowImages)`), **not** on scroll/re-render → no visible list jank (NFR-PERF-1); the wide table scrolls **horizontally inside its own bubble** (host `overflow-x:auto` + `img/table max-width:100%`), the app layout never breaks; there is **no `max-height`** and **no expand control** (D2); toggling one item does not force a synchronous reflow of the whole timeline (NFR-PERF-2). (FR-4, D2; **AC-3, AC-9**)

### S8 — Sanitizer throw → fail-safe to linkified text (never blank/crash)
- **Preconditions:** an inbound email with `body_html` present; `sanitizeEmailHtml` is forced to throw (or returns `''`).
- **Steps:** M1 attempted → `sanitizeEmailHtml` returns `''` → branch **M5** falls through to `linkifyToHtml(body_text)`.
- **Expected:** the bubble shows the linkified plain-text render (from `body_text`); the timeline **does not crash** and does **not** render raw HTML; other bubbles are unaffected. (NFR-SEC-6, EC-2; **AC-10**)

### S9 — Multi-tenant isolation: `body_html` only from the same company+contact projection (leak = P0)
- **Preconditions:** company A's contact timeline vs company B; both have email traffic.
- **Steps:** `GET /api/pulse/timeline*` → `getTimelineEmailByContact(companyId, contactId)` with `WHERE company_id = $1 AND contact_id = $2 AND on_timeline = true` **unchanged**; `body_html` is added to the SELECT column list only.
- **Expected:** `body_html` is surfaced **only** through the already company- + contact-scoped read; a cross-tenant fetch returns nothing; no new cross-tenant surface is introduced. **A cross-tenant leak here is P0.** (NFR-SEC-5; **AC-8**)

### S10 — Workspace parity: `/email` (`EmailMessageItem`) still renders correctly after adopting `SafeEmailHtml` (COMPAT)
- **Preconditions:** `/email` workspace; a benign HTML email and a hostile one; note `@tailwindcss/typography` is **not installed** (verified) so today's `prose prose-sm` classes are **no-ops** — the workspace already renders via the email's own inline styles.
- **Steps:** `EmailMessageItem` (l.87–92) is refactored to `<SafeEmailHtml html={message.body_html} allowImages={…} />` + a "Show images" control; the `<pre>` `body_text` fallback (l.93–97) and the attachments gallery are kept.
- **Expected:** benign mail renders **unchanged** (dropping the no-op `prose` loses nothing; the base sheet keeps bare-HTML at least as readable), hostile mail renders **strictly safer** (forced link `rel`/`target`, remote-image blocking, `data:`/`javascript:` link block now applied in the workspace too); no visual regression. (FR-10, NFR-COMPAT-1, US-6; **AC-6**)

### S11 — Empty body (no HTML AND no text)
- **Preconditions:** an email item with neither `body_html` nor `body_text`.
- **Steps:** branch **M4** (existing `hasBody` guard).
- **Expected:** the body renders nothing; the subject + timestamp chrome still show. (EC-7)

### S12 — Backend payload parity for a future SSE append (`toEmailItem`)
- **Preconditions:** the SSE `message.added` path (`emailTimelineService.toEmailItem`, l.54–74) and the REST projection (`pulse.js`, l.304–318) must produce **identical** email item shapes (the service file's own l.44–46 invariant).
- **Steps:** add `body_html: row.body_html || null` to `toEmailItem`.
- **Expected:** although today's bubble is built from the **REST** projection (SSE `message.added` **refetches** the timeline rather than appending `toEmailItem` — see data-flow note), the two shapes stay in parity so a future append-from-SSE renders the same. This change point is **payload-parity hygiene, NOT required for AC-1**. (FR-8; consistency)

---

## Security strip matrix (what is stripped / neutralized vs what remains) — S5 / AC-2

| Input in `body_html` | After `sanitizeEmailHtml` | Reason |
|---|---|---|
| `<script>alert(1)</script>` | **removed** (no node, no execution) | DOMPurify default (NFR-SEC-2) |
| `<img src=x onerror="alert(1)">` | `onerror` **stripped**; `<img>` kept but remote/`x` `src` neutralized to `data-blanc-src` (no fetch, no handler) | default strips `on*`; remote-image neutralize (FR-5) |
| `<div onclick="…">`, any `on*=` | attribute **stripped** | DOMPurify default (NFR-SEC-2) |
| `<form action="https://evil">…<input>…<button>Login</button></form>` | `<form>`/`<input>`/submit-`<button>` **removed** | DOMPurify default — no phishing form (US-5) |
| `<iframe src="…">` | **removed** | DOMPurify default |
| `<a href="javascript:alert(1)">x</a>` | `href` **nulled/dropped** (`<a>` may remain inert); if it survives it still gets `target=_blank rel=noopener noreferrer` | default URI policy + explicit `^(javascript):`i block (FR-3, NFR-SEC-3) |
| `<a href="data:text/html,<script>…">x</a>` | `href` **nulled** (`data:` blocked on **links**) | explicit `^(data):`i block on links (FR-3) |
| `<img src="data:image/png;base64,…">` | **kept, loads** (self-contained, no beacon) | `data:` on **images** allowed (OQ-1) |
| `<img src="https://track.example/pixel.gif">` (tracking pixel) | `src`→`data-blanc-src`, `srcset` stripped → **no fetch** until "Show images" | remote-image block by default (D3/FR-5, NFR-SEC-4) |
| `<img src="cid:abc123">` (inline attachment ref) | **hidden/neutralized** (moved off `src`), no fetch | no attachment plumbing on timeline (OQ-1) |
| any surviving `<a href="https://…">` | **kept** + forced `target="_blank" rel="noopener noreferrer"` | NFR-SEC-3, AC-2 |
| `<style>body{…}</style>`, class rules | **kept but shadow-scoped** — styles only inside the bubble | Shadow DOM isolation (OQ-3, FR-4) |
| malformed / unclosed / ~39 KB+ HTML | **normalized** by DOMPurify; contained by host `overflow-x` | EC-2; fail-safe (NFR-SEC-6) covers hard failure |
| protocol-relative image `//host/x.png` | treated as remote → neutralized until "Show images" | FR-5 |

**Plain-text path (linkify) safety:** `linkifyToHtml` **escapes `& < > " '` FIRST**, then wraps only URL/email/phone matches → the plain-text branch cannot inject HTML even if `body_text` contains `<script>` (it becomes visible text). (FR-6)

---

## Backend change points (D6 / FR-8/9) — NO migration

Column already exists (mig 079 `body_html TEXT`; `emailSyncService.extractBody` stores it). Ordered, concrete:

1. **`backend/src/db/emailQueries.js` — `getTimelineEmailByContact` SELECT (l.594–597):** add `body_html` to the explicit column list. **This is THE load-bearing read** for the timeline bubble. `WHERE company_id = $1 AND contact_id = $2 AND on_timeline = true` is **unchanged** (NFR-SEC-5, P0).
2. **`backend/src/routes/pulse.js` — timeline email mapping (l.304–318):** add `body_html: row.body_html` to the mapped item. `body_text` stays `toTimelineBody(row.body_text, { snippet })` (quote-stripped); `body_html` is passed **RAW** (OQ-2, FR-9).
3. **`backend/src/services/email/emailTimelineService.js` — `toEmailItem` (l.54–74):** add `body_html: row.body_html || null`. **Consistency/SSE-parity only, NOT required for AC-1** (data-flow note).
4. **`frontend/src/types/pulse.ts` — `EmailTimelineItem` (l.39–52):** add `body_html: string | null;` (additive; COMPAT-2).

**Deliberately NOT touched** (verified, anti-over-scope):
- The two `msg`-builds in `ingestPolledForCompany` (l.472–480 inbound, l.494–500 outbound) — they only drive the **linking** step; `linkMessageToContact` does `RETURNING *`, so `body_html` is already on the row `toEmailItem(linked)` receives (change point #3 alone surfaces it there).
- The `body_text ILIKE` free-text **search** (`emailQueries.js` ~l.158) — **untouched** (FR-9, AC-7). Search stays on `body_text`.
- `toTimelineBody`/`emailTimelineBody` quote-stripping — **untouched** (`body_html` bypasses it by design).

**Data-flow note (why the bubble only needs #1+#2+#4):** the bubble's `item.data` is built **client-side** in `PulseTimeline.tsx` (l.73–79) from `timelineData.email_messages`, which comes **only** from the REST projection (`usePulsePage.ts` l.66 → `pulseApi.getTimeline*` → `pulse.js` → `getTimelineEmailByContact`). The SSE `message.added` handler **refetches** the timeline; it does **not** append the `toEmailItem` payload. So **AC-1 = #1+#2 (backend) + #4 (type) + the FE work**; #3 is parity hygiene.

---

## Files to change (summary)

- **NEW (FE):** `frontend/src/lib/sanitizeEmailHtml.ts` (single DOMPurify config + hooks + fail-safe), `frontend/src/components/email/SafeEmailHtml.tsx` (shadow-root wrapper + base sheet + image-toggle), `frontend/src/lib/linkifyText.ts` (escape-then-linkify).
- **CHANGE (FE):** `frontend/src/components/pulse/EmailListItem.tsx` (render matrix M1–M5 + `allowImages`), `frontend/src/components/email/EmailMessageItem.tsx` (adopt `SafeEmailHtml`, l.87–97), `frontend/src/types/pulse.ts` (`body_html` on `EmailTimelineItem`).
- **CHANGE (BE):** `backend/src/db/emailQueries.js` (SELECT l.594–597), `backend/src/routes/pulse.js` (mapping l.304–318), `backend/src/services/email/emailTimelineService.js` (`toEmailItem` l.54–74).
- **CHANGE (deps):** `frontend/package.json` — add explicit `"dompurify": "3.2.7"` (OQ-HR-C; still "no new package").
- **REUSED unchanged:** DOMPurify 3.2.7 (already in `package-lock.json` l.7773), `emailSyncService.extractBody` (stores `body_html`), `lib/formatPhone.ts` (phone display in linkify), all EMAIL-TIMELINE-001 sync/OAuth/send paths.
- **Migration: NO.** **Protected files untouched:** `backend/src/server.js`, `frontend/src/lib/authedFetch.ts`, `frontend/src/hooks/useRealtimeEvents.ts`.

---

## Middleware / tenancy

- **No new API route/endpoint.** The timeline read reuses `GET /api/pulse/timeline*` (`pulse.js`) with its existing `authenticate` + `requireCompanyAccess` chain and `pulse.view` gate; `company_id` via `req.companyFilter?.company_id` (already enforced). `body_html` is surfaced **only** through the already company- + contact-scoped `getTimelineEmailByContact` — no new cross-tenant surface (NFR-SEC-5, P0; AC-8).

---

## Acceptance criteria (mapped) — testability tagged

`[unit]` = unit-testable on a pure fn (`sanitizeEmailHtml` / `linkifyToHtml`) with jsdom-parsed assertions. `[build]` = TypeScript build (`npm run build` = `tsc -b`) / static assertion. `[manual]` = browser verification against a real prod-DB copy (shadow render, image loading, layout, no-jank) — **cannot** be asserted in mocked Jest.

- **AC-1 (S1/S4, FR-1/D1):** At `/pulse/timeline/3044`, an inbound Google-LSA email renders with formatting and **clickable** links/buttons; an outbound email in the same timeline still renders plain text. `[manual]` (+ `[unit]` that `sanitizeEmailHtml` preserves anchors/formatting and that the M3 branch never calls sanitize for outbound).
- **AC-2 (S5, NFR-SEC-1/2/3):** An inbound test email with `<script>`, `<img onerror>`, `<form>`, and a `javascript:` link renders with all neutralized; every rendered `<a>` has `target="_blank"` + `rel="noopener noreferrer"`. `[unit]` (full security strip matrix on `sanitizeEmailHtml`, jsdom).
- **AC-3 (S6/S7, D2/FR-4):** A ~600 px marketing email renders inline with **no** max-height and **no** expand; scrolls horizontally **inside its own bubble**; app chrome unaffected/un-restyled by the email's `<style>`. `[manual]` (shadow isolation + host overflow are DOM/runtime; assert `overflow-x:auto`, absence of `max-height`, and shadowRoot presence).
- **AC-4 (S2, D3/FR-5):** On first render remote images do **not** load (no outbound image request); "Show images" loads them. `[unit]` that `sanitizeEmailHtml(html,{allowImages:false})` moves remote `src`→`data-blanc-src`/strips `srcset` and that `{allowImages:true}` leaves `src`; `[manual]` that no network request fires until the click.
- **AC-5 (S3, D4/FR-6):** Inbound with no `body_html` renders plain text with URLs/emails/phones as working `target=_blank rel=noopener noreferrer` links; **no new npm dependency**. `[unit]` on `linkifyToHtml` (escape-first + URL/email/phone wrapping + line breaks); `[build]` diff of `frontend/package.json` shows only the pinned `dompurify` add, no new package.
- **AC-6 (S10, D5/FR-2/FR-10):** Exactly ONE DOMPurify config exists in the frontend, used by BOTH `EmailListItem` and `EmailMessageItem`; `/email` shows no regression on benign mail. `[build]`/`[unit]` (grep/import assertion that no second `DOMPurify.sanitize` config remains; `EmailMessageItem` imports `SafeEmailHtml`) + `[manual]` (workspace benign render).
- **AC-7 (S9, D6/FR-8/9):** The timeline API email item includes `body_html`; `EmailTimelineItem` carries it; `body_text` is still present and `body_text ILIKE` search still works; **no DB migration**. `[build]` (type) + `[unit]`/integration (mapping surfaces `body_html`; search query unchanged) + repo check (no new migration file).
- **AC-8 (S9, NFR-SEC-5):** Timeline reads remain company-scoped; a cross-tenant fetch returns nothing. `[unit]`/integration on `getTimelineEmailByContact` WHERE clause unchanged; **P0**.
- **AC-9 (S7, NFR-PERF-1):** Sanitization is memoized per message (not re-run on scroll/re-render); a long timeline with several large HTML emails scrolls without visible jank. `[unit]` (memo key `(messageId, allowImages)` → sanitize called once per key; a re-render with same key does not re-invoke) + `[manual]` (no visible jank).
- **AC-10 (S8, NFR-SEC-6):** A forced sanitizer failure falls back to plain-text render; the timeline does not crash. `[unit]` (`sanitizeEmailHtml` throw → `''`; `EmailListItem` M5 falls through to linkify) + `[manual]`.

**Unit-testable (pure, mock-friendly):** the entire **`sanitizeEmailHtml`** security strip matrix, forced link `rel`/`target`, `data:`-link block vs `data:`-image allow, remote-image neutralize/allow toggle, fail-safe→`''`; the entire **`linkifyText`** contract (escape-first, URL/email/phone, line-break preservation, no-injection); the **memoization** key behavior; the backend **mapping/type/scoping** (surface `body_html`, unchanged WHERE, unchanged `ILIKE`).
**Build-only:** TS type add, single-config assertion, `package.json` dep diff, no-migration check.
**Manual / browser (not mocked Jest):** shadow-root **render fidelity** of the 3044 mail, **style isolation** both directions, **remote-image network suppression** until opt-in, **horizontal scroll inside the bubble** / no-`max-height`, **no scroll jank** on a long timeline, `/email` **workspace parity**. (House lesson: don't trust mocked Jest for render — verify in a real browser on a prod-DB copy before any deploy; **prod deploy is owner-consent-gated**.)

---

## Implementer notes

- **OQ-HR-C (required):** add `"dompurify": "3.2.7"` to `frontend/package.json` `dependencies` in this PR (it is only in the lockfile today — verified — so `npm ci`/fresh install could drop it). Add `@types/dompurify` **only if** `npm run build` (`tsc -b`) requires types not bundled by dompurify 3.x.
- **Verify with `npm run build`**, not just `tsc --noEmit` (prod Docker build is stricter — `noUnusedLocals`).
- **Global-leak guard:** ensure the email DOMPurify config/hooks do not permanently mutate the shared `DOMPurify` singleton for other callers (add/remove hooks around the call or use a dedicated instance).
- **Base sheet:** keep to the 8 declarations above; confirm the styled 3044 mail looks native AND a bare `<p>…<a>…</a></p>` is legible; do not import app Tailwind into the shadow.
- **No beacon race:** remote-image neutralize happens **inside** the sanitize pass and the toggle re-sets `innerHTML` wholesale — never set a live remote `src` then strip it.

---

## Out of scope (v1)

- Inbound-email **attachments** in the timeline bubble (workspace-only; EMAIL-TIMELINE-001 kept them out).
- Outbound rich composition (no HTML/WYSIWYG compose).
- Gmail OAuth/sync/`users.watch`/Pub/Sub/send/reply or `email_*` schema changes (**no migration**).
- Persisting "images shown" server-side or per-sender image-allowlisting (v1 is per-view only).
- Server-side sanitization / CSP / sandboxed-iframe rearchitecture (DOMPurify remains the control).
- **HTML quote-collapsing** of `body_html` (OQ-HR-B — future; v1 renders full raw HTML, EC-8).

---

## Residual open question (deferred, non-blocking)

- **OQ-HR-B (future):** HTML quote/signature collapse for parity with the quote-stripped `body_text` preview — client-side DOM heuristics (fragile) vs a server-side `body_html`-stripping pass. Not required for v1; tracked at EC-8.
