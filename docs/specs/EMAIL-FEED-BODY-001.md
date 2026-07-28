# EMAIL-FEED-BODY-001 — Pulse feed shows only the new email body

**STATUS: IMPLEMENTED (tandem: Codex backend T1–T2, Claude frontend T3 + gates).**

Owner (2026-07-28, /pulse/timeline/3966): the quoted thread inside emails floods the feed — show only
the new message. Store threads in full; the backend returns only the message to the feed. Must NOT
break the Yelp convo agent (its replies embed the full thread).

## Root cause

Feed email HTML was sent RAW to the client; the frontend belt `stripEmailQuote.ts`
(EMAIL-QUOTE-STRIP-001) missed the Outlook-desktop shape: the `From:/Sent:/To:/Subject:` run lives
**inside** the `border-top:solid` div (itself wrapped in a styleless div), while the old detector
expected the run **before** it; the text fallback scanned only body-level children. Repro: prod email
79436 — 4-line reply + 169KB quoted chain.

## Decision (meeting, final)

- Raw `email_messages.body_html/body_text` stay untouched (full thread preserved).
- Strip server-side at the **shared Pulse projector** `emailTimelineItem.js` →
  `projectEmailTimelineItem(row)`, used by paged REST, legacy REST, SSE (`message.added`), Yelp
  timeline events and the send-response DTO.
- New contract field **`display_html: string | null`** (required key); **`body_html` is REMOVED from
  every Pulse DTO**. `null` → the client renders quote-stripped `body_text` (M2). After a recognized
  cut the projector never falls back to raw HTML.
- `display_html` remains **untrusted** — the client still runs `sanitizeEmailHtml` + Shadow-DOM
  `SafeEmailHtml`; the frontend `stripEmailQuote` stays as an idempotent second belt (NOT extended
  with the new detectors in v1 — the backend is authoritative; avoids port/parity churn in
  `scripts/verify-email-quote-strip-001.js`).
- HTML stripper `emailTimelineHtml.js` (`stripTimelineHtml`): linkedom DOMParser (dep pinned
  **linkedom@0.18.12**; 0.18.13 is ESM-only-transitive and breaks CJS/Jest), earliest-of-all
  high-confidence boundaries (gmail_quote / blockquote[type=cite] / #appendonsend / yahoo_quoted /
  Outlook), Outlook detector covers **header-run-inside-border-div** AND the older
  run-before-div shape, deep attribution scan at every nesting level, **path-preserving cut**
  (removes the boundary branch + later siblings per ancestor level, prunes emptied wrappers — the
  reply sharing a wrapper with the quote survives), under-strip bias + near-empty→null, 1 MiB
  ceiling→null, parse-failure→null.
- `emailTimelineBody.js` (text) extended: collapsed single-line Outlook header runs.
- **No persisted cache in v1** (Codex position, accepted over the lazy-cache lean): benchmark on the
  real 169KB email = single median 1.8ms / p95 3.6ms; 20-email batch ≈ 32ms — under the 100ms/page
  budget. Revisit only if prod p95 breaks the budget.
- No "show quoted" expander: the `/email` workspace remains the full-thread surface.

## Untouched consumers (verified map)

Raw ingestion; `/email` workspace (`/api/email/threads/:id` → raw `body_html`); normal reply
threading (RFC headers); Mail Secretary; Yelp detection/routing; **Yelp reply MIME** (raw scoped
lookup → full original embedded in both MIME alternatives — byte-identical, sabotage-proved); Yelp
LLM history (own `toTimelineBody` call — benefits from the text detector, MIME unaffected);
Inspector; workspace search.

## Verification

Backend: 220/220 across 9 suites (independent re-run), incl. new `emailTimelineHtml.test.js` (15)
with structurally-exact 79436 fixtures; benchmark in `tests/benchmarks/`. Sabotages red→restored:
Outlook detector disabled → 3 red; Yelp raw-quote removed → red; `/email` raw removed → red;
(Codex also: deep-cut→body-level red, DTO shape asserts `display_html` present / `body_html` absent).
Frontend: tsc build green; vitest 324/327 (3 fails = pre-existing Settings/Marketplace, unrelated);
`verify-email-quote-strip-001.js` 37/37. E2E on the REAL prod 79436 body: 170,423 → 5,759 bytes,
reply preserved, `From: Assistance Team` boundary and deep chain gone.

## Known limits / debt

- Heuristic detection: unknown client quote formats can still under-strip (bias is deliberate).
- FE belt detectors not extended to the new Outlook shape (backend authoritative; revisit only if a
  raw-passthrough format shows up flooding the feed again).
- linkedom pinned 0.18.12 until its CJS transitive issue is resolved.
