# EMAIL-QUOTE-STRIP-001 — strip quoted thread history from inbound-HTML emails in the Pulse timeline (timeline-only)

**Status:** Spec (ready for TestCases/Planner) · **Priority:** P1 · **Date:** 2026-07-06
**Area:** Pulse timeline email bubble (`EmailListItem`, render-matrix M1) · new pure transform (`stripEmailQuote`) · shared renderer (`SafeEmailHtml`, opt-in prop) · `/email` workspace stays full (`EmailMessageItem`)
**Type:** feature — **frontend-only**. **No backend. No migration. No new endpoint. No new dependency. No DOMPurify/sanitizer change.**
**Depends on:** EMAIL-HTML-RENDER-001 (`SafeEmailHtml` + shadow render, `sanitizeEmailHtml`, render matrix M1–M5, `body_html` on the timeline item; master 62260f4). **Resolves** that feature's residual **OQ-HR-B / OQ-2** ("HTML quote-collapse — future"). Sits **downstream** of EMAIL-TIMELINE-001 (`body_html` sync) and touches none of its OAuth/sync/send/schema paths.
**Follows precedent:** `backend/src/services/email/emailTimelineBody.js` `toTimelineBody` — the **plain-text** quote-stripper this feature is the **DOM analogue of** (cut at the earliest boundary, keep the signature, fall back rather than blank, never throw). Same house lessons as the parent: verify against a **real prod-DB copy** (the **2599** thread) and a **real browser**, not only mocked Jest (LIST-PAGINATION-001 / created_by-FK); **prod deploy is owner-consent-gated**.

Binding customer decisions **D1–D6** (requirements §EMAIL-QUOTE-STRIP-001) and the Architect's decisions (architecture.md §EMAIL-QUOTE-STRIP-001: seam OQ-QS-2, detection+guard OQ-QS-3, near-empty OQ-QS-1, image-probe OQ-QS-4, Outlook deferral OQ-QS-5) are **inputs**, encoded faithfully below — not re-litigated. This spec resolves the residual **OQ-QS-A/B/C** the Architect routed here.

---

## Problem

After EMAIL-HTML-RENDER-001 shipped, inbound emails carrying a `body_html` render their **full** sanitized HTML in the Pulse timeline bubble (`frontend/src/components/pulse/EmailListItem.tsx`, render-matrix branch **M1** → `SafeEmailHtml`, l.107–137). Real reply threads (e.g. `/pulse/timeline/2599`) embed the **entire quoted conversation** inside `body_html`: each reply appends an `On … wrote:` attribution line plus a `.gmail_quote` / `<blockquote>` subtree containing every prior message. The bubble balloons into a wall of repeated history, burying the one thing the agent needs — the **new** reply.

This is an **INBOUND-HTML-ONLY** parity gap. Outbound (matrix M3) and inbound-plain-text (M2) already render `body_text`, which is quote-stripped server-side by `toTimelineBody` (`emailTimelineBody.js`, EMAIL-TIMELINE-001 §3c). Only **inbound + `body_html`** (M1) shows the raw full thread, because EMAIL-HTML-RENDER-001 deliberately passes `body_html` **un-quote-stripped** to the sanitizer (its FR-9) and deferred HTML quote-collapse to OQ-2.

**Ground truth (prod-verified, given):** the 2599 emails mark quotes with `class="gmail_quote"` + `<blockquote>` + an "On … wrote:" attribution; **none** use `#appendonsend` or `.yahoo_quoted`. This feature closes the gap by stripping the quoted-history subtree from the **inbound-HTML timeline render only**, restoring the only-new-reply view the plain-text path always gave — aligning M1 with M2/M3.

---

## Binding design (from the Architect — this spec encodes it faithfully)

- **New pure module `frontend/src/lib/stripEmailQuote.ts`** exporting **`stripEmailQuote(sanitizedHtml: string): string`**. It parses the **already-sanitized** string via `new DOMParser().parseFromString(html, 'text/html')`, locates the earliest/outermost quote boundary, removes the boundary subtree **plus** the immediately-preceding attribution line, applies the near-empty guard, and re-serializes (`document.body.innerHTML`). **DOM traversal — never string/regex splicing of tag soup.** Pure `string → string`; no React, no app singletons, no network; jsdom supplies `DOMParser` so it runs headless.
- **Post-sanitize (D4/FR-7).** The transform runs on the **output** of `sanitizeEmailHtml(...)`, never on raw `body_html`. `frontend/src/lib/sanitizeEmailHtml.ts` (DOMPurify config, `afterSanitizeAttributes` hook) is **not modified** — no config edit, no new hook. Removing nodes from an already-sanitized tree can only *reduce* capability; XSS pipeline is unaffected (NFR-SEC-1).
- **Opt-in seam (OQ-QS-2, D2/FR-3).** Wired into `SafeEmailHtml` via a **new prop `stripQuotedHistory?: boolean` (default `false`)**. When `true`, `stripEmailQuote(...)` is applied to the sanitized string **inside** the existing `useMemo` (l.106–112), **AFTER** `sanitizeEmailHtml(...)` and **BEFORE** the shadow `innerHTML` is set (l.136). The memo key gains the flag → **`[memoKey, allowImages, stripQuotedHistory]`**, so strip runs **once per (message, images-state)** — no second parse per scroll/re-render (NFR-PERF-1). `EmailListItem` passes `stripQuotedHistory` (M1). `EmailMessageItem` (`/email` workspace) does **NOT** → default `false` → full thread, byte-for-byte as today (NFR-COMPAT-1/AC-2).
- **Ordered detection + over-strip guard (D3 / OQ-QS-3).** Earliest/outermost boundary; markers split by confidence. **HIGH-confidence markers strip directly; LOW-confidence markers strip only when corroborated.** Explicit bias: **prefer UNDER-strip (keep content) over OVER-strip (lose the new reply).** Full decision table below.
- **Near-empty fallback (D5 / OQ-QS-1).** After a candidate strip, fall back to the **FULL sanitized HTML** iff **BOTH**: (1) normalized visible `textContent` (whitespace + zero-width stripped, trimmed) is **< 2 chars**, **AND** (2) **no meaningful media remains** (no `<img>` with a live `src` **or** a `data-blanc-src`; no `<table>`/`<picture>`). If either fails, keep the stripped result. Never a blank bubble.
- **Image-probe repoint (OQ-QS-4).** `EmailListItem`'s "Show images" probe (l.56) runs on the **stripped** display HTML (memoized on `email.id`), so the button reflects images in the **kept** reply.
- **Fail-safe (NFR-SEC-2).** The whole transform is `try/catch`; on **any** parse/serialize error it returns the **input string unchanged** (the full sanitized HTML) — never raw, never empty, never throws.
- **Idempotent (NFR-COMPAT-2).** `stripEmailQuote(stripEmailQuote(x)) === stripEmailQuote(x)` — the boundary markers were removed on pass 1, so pass 2 matches nothing and returns its input unchanged.
- **Frontend-only (D6).** `body_html` already flows to the timeline item (EMAIL-HTML-RENDER-001 FR-8). No backend, no query field, no migration, no new npm package (uses built-in `DOMParser`).

### OQ-QS resolutions (routed to this spec)

- **OQ-QS-A — RESOLVED (attribution-line DOM shape).** On any element-boundary match (table rows 1–5), also remove the boundary's **immediately-preceding sibling** when that sibling is an **attribution line**: its `textContent` matches the attribution regex family (`On … wrote:` single-line, OR the 1–2-line hard-wrap where line 1 is `On …` and a following line within 2 ends `… wrote:`). The sibling may be a **bare text node**, a `<div>` (Gmail commonly wraps it as `<div dir="ltr" class="gmail_attr">` or a bare `<div>` immediately above `.gmail_quote`), a `<p>`, or a `<span>`. **Only the single immediately-preceding sibling is inspected** (skipping intervening empty/whitespace-only text nodes). **Bias:** if the preceding sibling does not match the attribution shape, **leave it** — do not walk further up or reach into real content. See §"Attribution-line removal (OQ-QS-A)".
- **OQ-QS-B — RESOLVED (serialize fidelity of a kept author `<style>`).** `sanitizeEmailHtml` re-admits `<style>` (its config), and a real email may carry a body-level `<style>` **before** the quote that styles the kept reply. `stripEmailQuote`'s parse → serialize round-trip **MUST preserve** any body-level `<style>` that is **not inside the removed subtree**. `DOMParser` retains `<style>` under `<body>`; serializing from `document.body.innerHTML` keeps it. The transform removes **only** the boundary subtree (+ its attribution sibling) — it must **not** drop, hoist, or reorder a preceding `<style>`. See §"Serialize fidelity (OQ-QS-B)".
- **OQ-QS-C — RESOLVED (Outlook precision deferred; conservative under-strip acceptable).** v1 guarantees only the **narrow, high-precision** Outlook cases — `#appendonsend` (HIGH) and a `border-top`-styled `<div>` **immediately following a `From:`/`Sent:`/`To:` header run** (CONSERVATIVE). Absent that exact structure, Outlook history is **deliberately not stripped** (under-strip). This is explicitly acceptable: **2599 is Gmail**, there is no prod Outlook sample to tune against, and under-strip degrades to "shows a bit of history" (harmless) rather than "loses the new reply" (harmful). Broader Outlook coverage is **out of scope v1** (tracked as a follow-up).

---

## Contracts

There is **no new HTTP endpoint, no request-shape change, no middleware change, no query change.** `GET /api/pulse/timeline*` is untouched (`body_html` already surfaced by EMAIL-HTML-RENDER-001). Two frontend contracts are added/changed.

### Contract 1 — `stripEmailQuote(sanitizedHtml: string): string` — NEW (pure module `frontend/src/lib/stripEmailQuote.ts`)

- **Input:** `sanitizedHtml: string` — the **output of `sanitizeEmailHtml(...)`** (already DOMPurify-sanitized; NOT raw `body_html`). May be `''`.
- **Behavior:** parse via `new DOMParser().parseFromString(sanitizedHtml, 'text/html')` → run **ordered/guarded boundary detection** (§decision table) → on match, remove the boundary subtree **and** the immediately-preceding attribution sibling (OQ-QS-A) → compute the **near-empty predicate** (§D5 rule): if it holds, **return the original input unchanged** (full render); else re-serialize `document.body.innerHTML` and return it. On **no boundary**, return the input **unchanged** (passthrough, FR-9). Preserve a kept body-level `<style>` (OQ-QS-B).
- **Fail-safe (NFR-SEC-2):** the whole body is wrapped in `try/catch`. On **any** throw (parse/serialize/DOM error) it returns **`sanitizedHtml` unchanged** — **never** raw HTML (the input is already sanitized), **never** `''`, **never** a throw that reaches React.
- **Idempotence (NFR-COMPAT-2):** `stripEmailQuote(stripEmailQuote(x)) === stripEmailQuote(x)` for all `x`.
- **Determinism:** for a given input string the output is stable (enables caller-side memoization).
- **Empty input:** `stripEmailQuote('')` returns `''` (nothing to strip; caller already handles `''` via the M5 fallback in the parent feature).
- **Returns:** the stripped HTML string, or the input unchanged (no boundary / near-empty fallback / failure).

### Contract 2 — `SafeEmailHtml` gains `stripQuotedHistory?: boolean` (default `false`) — CHANGED (`frontend/src/components/email/SafeEmailHtml.tsx`)

- **New prop** on `SafeEmailHtmlProps`: `stripQuotedHistory?: boolean` (default `false`).
- **Behavior:** inside the existing `useMemo` (l.106–112), when `stripQuotedHistory === true`, apply `stripEmailQuote(...)` to the sanitized string **after** `sanitizeEmailHtml(html, { allowImages })` and **before** it is returned from the memo. Memo dep array becomes **`[memoKey, allowImages, stripQuotedHistory]`**. When `false`, the memo returns the sanitized string **unchanged** (today's behavior — the workspace path). Everything else (host `<div>`, shadow attach, base sheet, wholesale `innerHTML` re-set at l.114–137) is **unchanged**.
- **Default preserves the workspace (D2/FR-3):** absent the prop, output is byte-for-byte identical to today (NFR-COMPAT-1/AC-2).

### Not a contract change (asserted UNCHANGED)

- **`frontend/src/lib/sanitizeEmailHtml.ts`** — NOT modified (D4/FR-7/NFR-SEC-1/AC-8). The single DOMPurify authority stays the sole XSS control; strip is strictly downstream.
- **`frontend/src/components/email/EmailMessageItem.tsx`** — does **NOT** pass `stripQuotedHistory` → renders the full thread (D2/FR-3/AC-2).
- **`frontend/src/lib/linkifyText.ts`** and the M2/M3 text paths — untouched (FR-12/AC-11).
- **Backend / query / type / migration** — none (D6/AC-12). `body_html` already flows to the timeline item.

---

## Frontend wiring (`EmailListItem` — the primary change)

`EmailListItem` already computes `renderHtml` (inbound + non-empty `body_html`, l.49) and drives the M1 branch (l.107–137). Two edits:

1. **Pass the flag** on the M1 `<SafeEmailHtml>` (l.117–122): add `stripQuotedHistory` (always `true` at this call-site — M1 is inbound-HTML timeline). Outbound never reaches M1 (short-circuited by `renderHtml` gating on `!isOutgoing`), so outbound is structurally untouched (FR-12).
2. **Repoint the image probe (OQ-QS-4).** Today `showImagesButton` tests `REMOTE_IMG_RE.test(email.body_html || '')` (raw, l.56). Change it to test the **stripped display HTML** = `stripEmailQuote(sanitizeEmailHtml(email.body_html || '', { allowImages: false }))`, computed **once** and **memoized on `email.id`** (a `useMemo`, so it is not recomputed per scroll/render). Because the neutralized markers (`data-blanc-src`, and a remote `src` while `allowImages:false`) still satisfy `REMOTE_IMG_RE`, the probe accurately reflects remote/cid images **in the kept reply** — the button appears only when "Show images" would actually reveal something.

> **Perf note.** The probe's `stripEmailQuote(sanitizeEmailHtml(...))` and the shadow render's memo both call the same pure fns on the same input; both are memoized on the message identity, so the strip work is small and bounded (not per-frame). The probe pass fixes `allowImages:false` deliberately (it only needs to know "is there a blockable image in the kept reply", independent of the current toggle).

The eyebrow/subject/timestamp chrome, the `max-w-[75%]` bubble cage, and the "Show images" button mechanics are **unchanged**.

---

## Ordered detection + over-strip guard (D3 / FR-4/5/6 · OQ-QS-3) — the decision table

`stripEmailQuote` scans for the **earliest/outermost** boundary (document order; top-level preferred) and discards it **plus everything after it**. It stops at the **first** matching row. HIGH rows strip directly; LOW rows strip only when their guard condition holds. **Bias: UNDER-strip over OVER-strip.**

| # | Detector | Confidence | Strip condition | Notes |
|---|---|---|---|---|
| 1 | `.gmail_quote` (element with class `gmail_quote`) | **HIGH** | Strip directly | Primary for the prod-verified 2599 thread (AC-1/AC-3). |
| 2 | `blockquote[type="cite"]` | **HIGH** | Strip directly | Apple Mail. |
| 3a | `#appendonsend` (element with id `appendonsend`) | **HIGH** | Strip directly | Outlook. |
| 3b | `<div>` with an inline-`style` `border-top` **immediately following** a `From:`/`Sent:`/`To:` header run | **CONSERVATIVE** | Strip **only** on that exact structural shape | Outlook (OQ-QS-5/OQ-QS-C). Absent the header-run-then-border-top shape → **do not cut** (deliberate under-strip). |
| 4 | `.yahoo_quoted` (element with class `yahoo_quoted`) | **HIGH** | Strip directly | Yahoo. |
| 5 | First **top-level** `<blockquote>` | **LOW / GUARDED** | Strip **only if** corroborated: (a) **immediately preceded by an attribution line** (`On … wrote:` in the sibling above), **OR** (b) it is the **trailing block** (nothing but whitespace/empty nodes follows it to end-of-body). | A mid-body `<blockquote>` with **real content after it** is treated as an in-message quotation and **KEPT** (AC-6 over-strip guard, EC-6). |
| 6 | Text fallback: attribution line `On … wrote:` / `… wrote:` | **LOW / GUARDED** | Fires **only** on the attribution shape (regex family below, incl. 1–2-line wrap). On match, remove the attribution line **and everything after it** to end-of-body. | A bare `wrote:` without the `On …` shape does **NOT** cut. Handles attribution-without-blockquote (FR-10/EC-4). |

**"Earliest/outermost" (FR-6):** when several detectors could match (e.g. nested `.gmail_quote` inside a `<blockquote>`, or two quote levels), cut at the **highest-in-the-DOM / earliest-in-document-order** boundary so **no** quoted level survives (AC-4/EC-2). Detectors 1–4 that select an element take that element's **outermost** matching ancestor if nested. Rows are evaluated in table order, but the chosen cut is the one **earliest in document order** among the first-matching row's hits (a single cut removes all history).

### Attribution-line removal (OQ-QS-A)

On an **element-boundary** match (rows 1–5), before removing the boundary subtree, inspect the boundary's **immediately-preceding sibling** (skip intervening whitespace-only / empty text nodes):

- Remove that sibling **iff** its `textContent`, trimmed, matches the **attribution shape**:
  - **Single line:** `^\s*On\s.+\swrote:\s*$` (mirrors `RE_ON_WROTE` in `emailTimelineBody.js`), **or**
  - **1–2-line hard wrap:** the sibling's text starts `^\s*On\s.+` (mirrors `RE_ON_START`) **and** ends with `wrote:\s*$` within its own text (a wrapped `On …\n… wrote:` collapsed inside one node). For a wrap **split across two sibling nodes**, the node bearing the `On …` start and the node ending `… wrote:` (within 2 siblings, no blank break) are both removed.
- The sibling may be a **bare text node**, `<div>` (incl. Gmail's `<div dir="ltr" class="gmail_attr">`), `<p>`, or `<span>`.
- **Only the single immediately-preceding sibling** (plus the paired wrap node) is inspected. **If it does not match, leave it** — never walk further up, never reach into real reply content. *(Bias per OQ-QS-A: under-reach beats over-reach.)*

For the **text-fallback** boundary (row 6) there is no element subtree: the attribution line node itself **is** the boundary — remove it and all following siblings to end-of-body.

### Serialize fidelity (OQ-QS-B)

- A body-level author `<style>` that precedes the quote (styling the kept reply) **survives** the parse → mutate → serialize round-trip. `stripEmailQuote` removes only the boundary subtree + attribution sibling; it must **not** drop, hoist, or reorder a preceding `<style>`.
- Re-serialize from **`document.body.innerHTML`** (the sanitized email lives under `<body>`; `DOMParser` keeps a body-level `<style>` there). Do **not** serialize only a fragment that could exclude a leading `<style>`.
- Safety-net: even if a `<style>` were lost, `SafeEmailHtml`'s `BASE_SHEET` keeps the kept reply legible — but the AC requires the `<style>` be preserved (AC-13).

---

## Near-empty fallback (D5 / OQ-QS-1) — the exact predicate

After computing a **candidate** stripped `<body>`, decide whether to keep it or fall back to the FULL sanitized HTML. **Fall back to FULL iff BOTH hold:**

1. **`normVisibleText(strippedBody).length < 2`**, where `normVisibleText` = the body's `textContent` with all whitespace **and** zero-width characters removed — specifically strip `​` (ZWSP), `‌` (ZWNJ), `‍` (ZWJ), `﻿` (BOM/ZWNBSP), plus standard whitespace — then trimmed. (i.e. empty, or a single stray glyph.) **AND**
2. **No meaningful media remains** in the stripped body:
   - no `<img>` with **either** a live `src` **or** a `data-blanc-src` (a to-be-revealed remote image still counts as content), **and**
   - no `<table>` and no `<picture>` carrying the reply.

If **either** condition fails — there **is** ≥2 chars of visible text, **or** there **is** a kept image/table/picture — **keep the stripped result**. This mirrors `toTimelineBody`'s "stripping emptied the body → fall back, never blank" (l.306–312) while guarding the all-quote/bare-forward case (US-3/EC-3/AC-5) **without** discarding a legit **image-only** reply (AC-14).

> **Why an image counts:** an inbound reply may be a single inline image with no text (a screenshot reply). Condition 2 keeps it. Both a live `data:`/remote `src` and a neutralized `data-blanc-src` (remote image awaiting "Show images") qualify.

---

## Behavior scenarios

Each scenario lists **Preconditions → Steps → Expected / side-effects** and maps to acceptance criteria (AC-n) / functional requirements (FR-n). Scenario IDs are stable for the TestCases agent.

### S1 — Happy path: Gmail reply (2599-shape) → only the new reply remains
- **Preconditions:** `/pulse/timeline/2599`; an **inbound** email whose `body_html` is a Gmail reply: new reply text, then a `<div dir="ltr" class="gmail_attr">On … wrote:</div>`, then `<div class="gmail_quote"><blockquote>…prior thread…</blockquote></div>`.
- **Steps:** (1) `EmailListItem` M1 renders `<SafeEmailHtml … stripQuotedHistory />`; (2) inside the memo, `sanitizeEmailHtml(...)` runs, then `stripEmailQuote(...)`; (3) detector row 1 (`.gmail_quote`, HIGH) matches → the `.gmail_quote` subtree **and** the preceding `gmail_attr` "On … wrote:" line are removed (OQ-QS-A); (4) the stripped string is set as shadow `innerHTML`.
- **Expected / side-effects:** the bubble shows **only the new reply**; the quoted history is **absent**; there is **no** expand / "Show quoted text" / ellipsis affordance anywhere (D1/FR-2). Links/images **in the kept reply** still work (forced `target/rel` from sanitize survive; images gated by "Show images" as before). (FR-1/FR-5; **AC-1, AC-3**)

### S2 — Apple Mail `blockquote[type="cite"]` → stripped
- **Preconditions:** an inbound Apple-Mail reply: new text, `On … wrote:` line, then `<blockquote type="cite">…</blockquote>`.
- **Steps:** M1 + strip → detector row 2 (HIGH) matches.
- **Expected:** the `blockquote[type="cite"]` subtree + preceding attribution line removed; only the new reply remains. (FR-4/FR-5; **AC-3**)

### S3 — Yahoo `.yahoo_quoted` → stripped
- **Preconditions:** an inbound Yahoo reply with a `.yahoo_quoted` container.
- **Steps:** M1 + strip → detector row 4 (HIGH) matches.
- **Expected:** the `.yahoo_quoted` subtree (+ preceding attribution if present) removed; only-new remains. (FR-4/FR-5)

### S4 — Outlook `#appendonsend` → stripped
- **Preconditions:** an inbound Outlook reply whose quote begins at a `<div id="appendonsend">`.
- **Steps:** M1 + strip → detector row 3a (HIGH) matches.
- **Expected:** the `#appendonsend` subtree (+ preceding attribution if present) removed; only-new remains. (FR-4/FR-5; OQ-QS-C narrow Outlook guarantee)

### S5 — Nested / multi-level reply → cut at the OUTERMOST/earliest boundary (one cut, all history gone)
- **Preconditions:** a 3-deep inbound reply thread — quote levels nested (`.gmail_quote` inside a `<blockquote>` inside another `.gmail_quote`), each with its own `On … wrote:`.
- **Steps:** M1 + strip → the earliest/outermost boundary (highest in the DOM / earliest in document order) is chosen (FR-6).
- **Expected:** a **single** cut removes the outermost boundary and everything after it → **zero** quoted levels survive in the bubble; no inner level leaks back. (FR-6/EC-2; **AC-4**)

### S6 — Over-strip guard: genuine mid-body `<blockquote>` with real content after it → KEPT
- **Preconditions:** an inbound **fresh** message (no reply history) whose body legitimately quotes a paragraph in a top-level `<blockquote>`, followed by **more new reply text** after the blockquote. No `.gmail_quote`/`type=cite`/`.yahoo_quoted`/`#appendonsend`; no attribution line before the blockquote.
- **Steps:** M1 + strip → detectors 1–4 miss; row 5 (first top-level `<blockquote>`, LOW/GUARDED) is evaluated: it is **not** preceded by an attribution line **and** it is **not** the trailing block (real content follows) → **guard fails → not stripped**; row 6 finds no attribution → no cut.
- **Expected:** the whole message — including the author's legitimate `<blockquote>` quotation and the text after it — renders **unchanged** (nothing stripped). (NFR-CORRECT-1/EC-6; **AC-6**)

### S7 — Guarded `<blockquote>`: bare trailing top-level `<blockquote>` with an attribution before → stripped
- **Preconditions:** an inbound reply: new text, an `On … wrote:` line, then a bare top-level `<blockquote>…history…</blockquote>` at the **end** (no client-specific class).
- **Steps:** M1 + strip → detectors 1–4 miss; row 5 matches with guard **(a)** satisfied (preceded by attribution) **and** guard **(b)** satisfied (trailing block) → strip.
- **Expected:** the trailing `<blockquote>` + preceding attribution removed; only-new remains. Contrast with S6 (mid-body, content after → kept). (FR-4/FR-5; **AC-3**, over-strip guard)

### S8 — No boundary → passthrough unchanged
- **Preconditions:** a fresh inbound HTML email with **no** quoted history and no author `<blockquote>` (e.g. a Google-LSA lead email — buttons/links but no reply quote).
- **Steps:** M1 + strip → no detector matches.
- **Expected:** `stripEmailQuote` returns its input **unchanged**; the bubble renders **byte-identically** to EMAIL-HTML-RENDER-001 output (transform is a no-op). (FR-9/EC-1; **AC-6** [no-op arm])

### S9 — Attribution line present, no following quote block → text-fallback cut
- **Preconditions:** an inbound email with new reply text, then an `On … wrote:` attribution line, then some **plain quoted text with no `<blockquote>` element** after it (a client that inlined the quote as bare text).
- **Steps:** M1 + strip → detectors 1–5 miss; row 6 (text fallback) matches the `On … wrote:` shape.
- **Expected:** the attribution line **and everything after it** to end-of-body are removed; only the new reply remains. If removal would empty the bubble, D5 fallback fires (→ S11). (FR-10/EC-4; **AC-7**)

### S10 — All-quote email (bare forward) → near-empty → render FULL (never blank)
- **Preconditions:** an inbound email that is **essentially all quoted history** — a bare forward / a reply with no new text above the quote.
- **Steps:** M1 + strip → a boundary matches and the candidate strip removes (almost) everything → the **near-empty predicate** is evaluated: `normVisibleText < 2` **AND** no kept media → **both hold**.
- **Expected:** `stripEmailQuote` returns the **FULL sanitized HTML unchanged**; the bubble shows the complete thread rather than a blank/near-blank bubble. Never empty due to stripping. (D5/FR-8/EC-3; **AC-5**)

### S11 — Attribution-only email (nothing meaningful after removing it) → near-empty → render FULL
- **Preconditions:** an inbound email that is just an `On … wrote:` line and quoted history, with **no** real new text.
- **Steps:** M1 + strip → row 6 (or an element boundary) cuts the attribution + trailing → candidate near-empty → predicate holds.
- **Expected:** D5 fallback → render FULL sanitized content (never blank). (FR-10 tail / D5; **AC-5/AC-7**)

### S12 — Image-only reply (inline image, no text) → KEPT (media guard)
- **Preconditions:** an inbound reply whose **new** content is a single inline image (`<img>` with a `data:` or a to-be-revealed remote `src`→`data-blanc-src`) and no text, followed by quoted history.
- **Steps:** M1 + strip → the quote boundary is removed → candidate body has `normVisibleText < 2` **but** contains an `<img>` with `src`/`data-blanc-src` → near-empty predicate condition 2 **fails** → **keep the stripped result**.
- **Expected:** the bubble shows the **kept image reply** (quote stripped), **not** the full thread; the image-only reply is not discarded by the near-empty rule. (D5 media guard; **AC-14**)

### S13 — Transform throws → fail-safe returns the input (full sanitized)
- **Preconditions:** an inbound HTML email; `stripEmailQuote` is forced into a parse/serialize error (or any internal throw).
- **Steps:** M1 + strip → the `try/catch` catches.
- **Expected:** `stripEmailQuote` returns the **input `sanitizedHtml` unchanged** (the full sanitized render) — **never** raw `body_html`, **never** `''`, **never** a throw reaching React; the timeline does not crash; other bubbles unaffected. (NFR-SEC-1/NFR-SEC-2; **AC-8** [fail-safe arm])

### S14 — Idempotent: `stripEmailQuote(stripEmailQuote(x)) === stripEmailQuote(x)`
- **Preconditions:** any inbound HTML `x` (with or without a quote).
- **Steps:** apply the transform twice.
- **Expected:** the second application is a **no-op** (the boundary markers were removed on pass 1 → no detector matches) → identical output. Matters because the sanitize memo re-runs on the `allowImages` toggle (S16/EC-9). (NFR-COMPAT-2; **AC-10** [idempotence arm])

### S15 — Workspace (`EmailMessageItem`) unchanged — full thread (regression)
- **Preconditions:** the **same** 2599 message opened in the `/email` workspace.
- **Steps:** `EmailMessageItem` renders `<SafeEmailHtml html={message.body_html} allowImages={…} />` **without** `stripQuotedHistory` → memo returns the sanitized string unchanged (no strip).
- **Expected:** the workspace shows the **complete** quoted thread, **byte-for-byte identical** to before this feature. No visual/behavioral change. (D2/FR-3/NFR-COMPAT-1; **AC-2**)

### S16 — `allowImages` toggle re-render → reply stays stripped, kept-reply images reveal
- **Preconditions:** a stripped inbound HTML bubble (S1) with a remote image **inside the kept reply**; agent clicks "Show images".
- **Steps:** caller sets `allowImages:true` → `SafeEmailHtml` memo re-runs with key `[memoKey, true, true]` → `sanitizeEmailHtml(…, {allowImages:true})` then `stripEmailQuote(…)` again (idempotent on the reply's structure).
- **Expected:** the reply stays **stripped** (no quoted history reappears), and only images **within the kept reply** reveal. The probe (repointed, OQ-QS-4) had shown the button only because a blockable image existed in the kept reply. (NFR-COMPAT-2/EC-9; **AC-10**)

### S17 — "Show images" probe reflects the KEPT reply, not the stripped quote (OQ-QS-4)
- **Preconditions two variants:** (A) remote images live **only inside** the quoted history (stripped away); the kept reply has **no** remote image. (B) the kept reply itself has a remote image; the quote also had some.
- **Steps:** `showImagesButton` tests `REMOTE_IMG_RE` on the **stripped** display HTML (memoized on `email.id`), not raw `body_html`.
- **Expected:** (A) the button does **NOT** appear (nothing to reveal — all remote images were in the removed quote). (B) the button **appears** and reveals the kept-reply image. The affordance matches what is actually visible. (EC-7/OQ-QS-4; **AC-11**)

### S18 — XSS unaffected: strip runs on already-sanitized DOM (security regression guard)
- **Preconditions:** the EMAIL-HTML-RENDER-001 hostile sample (`<script>`, `<img onerror>`, `<form>`, a `javascript:` link) **plus** a `.gmail_quote` history block, delivered inbound with `stripQuotedHistory` active.
- **Steps:** M1 → `sanitizeEmailHtml` neutralizes the hostile payloads (unchanged), then `stripEmailQuote` removes the quote from the already-sanitized tree.
- **Expected:** no script executes, no `on*` survives, no `<form>`/`<iframe>` in the DOM, `javascript:`/`data:` link hrefs nulled, tracking pixels not fetched — **exactly as EMAIL-HTML-RENDER-001 AC-2** — **and** the quote is stripped. `sanitizeEmailHtml.ts` is unchanged; a forced strip failure falls back to **full sanitized** (never raw). No new attribute/handler can be reintroduced by node removal. (NFR-SEC-1/D4; **AC-8**)

### S19 — Empty / degenerate quote markers → removed, no crash, no empty bubble
- **Preconditions:** an inbound email with a **present-but-empty** marker (an empty `<blockquote>` or a `.gmail_quote` with no content), plus real reply text.
- **Steps:** M1 + strip → the empty marker is removed like any boundary.
- **Expected:** if removing it changes nothing visible, the render is effectively unchanged; no crash; the reply text keeps the bubble non-empty (D5 not triggered). If the email were **only** the empty marker, D5 fallback renders full. (FR-11/EC-5)

### S20 — Outbound and inbound-plain-text paths untouched (scope guard)
- **Preconditions:** an outbound email (M3) and an inbound text-only email (M2) in the same timeline.
- **Steps:** neither reaches M1 (`renderHtml` gates on `!isOutgoing && body_html`); both render `linkifyToHtml(body_text)`.
- **Expected:** both render exactly as today (already only-new via `toTimelineBody`); `stripEmailQuote` is **never** invoked for M2/M3. (FR-12/EC-8; **AC-11-scope**)

---

## Acceptance criteria (mapped) — testability tagged

`[unit]` = **unit-testable-headless** — assertable on the pure `stripEmailQuote` fn under **jsdom/`DOMParser`** (no browser, no React). `[build]` = TypeScript build (`npm run build` = `tsc -b`) / static repo assertion. `[manual]` = **manual-browser** verification against a real prod-DB copy (shadow render on 2599; image reveal; layout; no-jank) — **cannot** be asserted in mocked Jest.

> **Vehicle note for TestCases (mirrors the parent):** the frontend has **no unit-test runner**, and `jsdom`/`vitest`/`@jest-environment jsdom` are **not installed**; `stripEmailQuote.ts` is TS-ESM (can't be `require`d as-is). So the `[unit]` AC arms are realized either by (a) a standalone Node **verify script** that hosts `jsdom`'s `DOMParser` and exercises a **verbatim CJS port** of `stripEmailQuote` with a **build-time parity assertion** that the port === the shipped `.ts` (the EMAIL-HTML-RENDER-001 pattern), or (b) manual-browser fallback if the owner refuses even a dev-only `jsdom`. `[unit]` here means "logic is pure and headless-checkable under jsdom `DOMParser`", not "a jest env exists today." TestCases prescribes the concrete vehicle.

- **AC-1 (S1, D1/FR-1/FR-2):** At `/pulse/timeline/2599`, an inbound reply that carried an `On … wrote:` + `.gmail_quote`/`<blockquote>` history renders showing **only the new reply**; the quoted history is **absent**; **no** expand/"Show quoted text" control anywhere. `[manual]` (shadow render on 2599) **+** `[unit]` (`stripEmailQuote` on the 2599 body removes the `.gmail_quote` + attribution and keeps the reply).
- **AC-2 (S15, D2/FR-3/NFR-COMPAT-1):** The **same** message in `/email` still shows the **full** thread, unchanged. `[unit]`/`[build]` (`EmailMessageItem` does **not** pass `stripQuotedHistory`; `SafeEmailHtml` default `false` → sanitized string returned unchanged) **+** `[manual]` (workspace shows full thread).
- **AC-3 (S1/S2/S7, D3/FR-4/FR-5):** For a Gmail-shaped (and Apple/Yahoo/guarded-blockquote) email, both the boundary subtree **and** the immediately-preceding `On … wrote:` line are removed; nothing from the boundary downward remains. `[unit]` (detectors 1–4 + guarded row 5 on crafted fixtures; assert boundary + attribution gone, reply kept).
- **AC-4 (S5, FR-6/EC-2):** A 3-deep nested reply strips at the outermost boundary — **zero** quoted levels remain. `[unit]` (nested fixture; assert one cut, no residual quote node).
- **AC-5 (S10/S11, D5/FR-8/EC-3):** A bare-forward / all-quote email renders the **FULL** sanitized content (not blank); never empty due to stripping. `[unit]` (all-quote fixture → near-empty predicate holds → input returned unchanged).
- **AC-6 (S6/S8, FR-9/EC-1/EC-6):** (a) A fresh inbound HTML email with no quote renders **byte-identically** to EMAIL-HTML-RENDER-001 output (no-op); (b) a genuine mid-body `<blockquote>` with content after it is **KEPT** (not over-stripped). `[unit]` (no-boundary passthrough === input; mid-body-blockquote fixture unchanged).
- **AC-7 (S9/S11, FR-10/EC-4):** An inbound email with an `On … wrote:` line but **no** `<blockquote>` after it has that line (and trailing content) removed; if that empties the body, the full content is shown (D5). `[unit]` (text-fallback fixture; + all-quote-after-attribution → D5 fallback).
- **AC-8 (S13/S18, D4/FR-7/NFR-SEC-1/NFR-SEC-2):** `sanitizeEmailHtml.ts` is **unchanged**; the EMAIL-HTML-RENDER-001 hostile sample still fully neutralizes with stripping active (no XSS regression); a forced `stripEmailQuote` failure falls back to **full sanitized** (never raw, never empty, never throws). `[unit]` (strip on the sanitized hostile output preserves the neutralization + strips the quote; forced-throw → returns input) **+** `[build]` (diff shows `sanitizeEmailHtml.ts` untouched).
- **AC-9 (S16, NFR-PERF-1):** Stripping is memoized per message (folded into the existing sanitize memo; dep `[memoKey, allowImages, stripQuotedHistory]`), **not** re-run on scroll; a long timeline with several large HTML threads scrolls without visible jank. `[unit]`/`[build]` (memo dep array includes the flag; strip called once per key) **+** `[manual]` (no visible jank on 2599 + a long list).
- **AC-10 (S14/S16, NFR-COMPAT-2/EC-9):** `stripEmailQuote` is **idempotent**; clicking "Show images" on a stripped bubble keeps the reply stripped and reveals only images within the kept reply. `[unit]` (double-apply === single-apply) **+** `[manual]` (toggle on 2599: history stays gone, kept image loads).
- **AC-11 (S17/S20, OQ-QS-4/EC-7 + FR-12/EC-8):** The "Show images" probe reflects the **kept** reply (button hidden when remote images were only in the removed quote; shown when the kept reply has one); outbound + inbound-plain-text bubbles are **unchanged**. `[unit]` (probe = `REMOTE_IMG_RE` on stripped HTML: variant A hidden, variant B shown; M2/M3 never call `stripEmailQuote`) **+** `[manual]` (button behavior on 2599).
- **AC-12 (NFR-COMPAT-3):** **No new npm dependency** (uses built-in `DOMParser`). `[build]` (`frontend/package.json` diff shows no new package).
- **AC-13 (S1/OQ-QS-B):** A styled email's **kept-reply** author `<style>` (body-level, preceding the quote) is **preserved** through the strip's parse→serialize round-trip. `[unit]` (fixture with a leading `<style>` + quote; assert the `<style>` survives in the output and the quote is gone).
- **AC-14 (S12, D5 media guard):** An **image-only** reply (inline image, no text) is **KEPT** (quote stripped), not discarded by the near-empty rule. `[unit]` (image-only-reply fixture: `normVisibleText < 2` but `<img src|data-blanc-src>` present → keep stripped).

### Unit-testable-headless vs manual-browser split (explicit)

- **Unit-testable-headless (pure `stripEmailQuote` under jsdom `DOMParser`):** the **entire detection table** (rows 1–6, HIGH direct + LOW/GUARDED), the **over-strip guard** (mid-body-blockquote KEPT vs trailing/attributed stripped), **outermost/earliest cut** on nested threads, **attribution-line removal** (OQ-QS-A shapes incl. 1–2-line wrap), the **near-empty predicate** (all-quote→full, image-only→kept, `<2`-char rule with zero-width stripping), **idempotence**, **fail-safe→input**, **no-boundary passthrough===input**, **`<style>` preservation** (OQ-QS-B), and the **probe** logic (`REMOTE_IMG_RE` on the stripped string). Realized via a Node verify script hosting jsdom `DOMParser` + a parity-asserted CJS port (see vehicle note).
- **Build-only:** the `SafeEmailHtml` memo dep array includes `stripQuotedHistory`; `EmailListItem` passes the flag and repoints the probe; `EmailMessageItem` does **not** pass the flag; `sanitizeEmailHtml.ts` untouched; `package.json` shows no new package; TS build (`tsc -b`).
- **Manual / browser (NOT mocked Jest):** on **`/pulse/timeline/2599`** — the bubble shows **only the new reply** (no expand control); the `/email` **workspace** shows the **full** thread (D2 regression); the **all-quote** fallback renders full (never blank); **"Show images"** appears only when the kept reply has a remote image and reveals only kept-reply images; **no scroll jank** on a long timeline; the **hostile-sample** sanitizer test still passes with stripping active. *(House lesson: don't trust mocked Jest for render — verify in a real browser on a prod-DB copy before any deploy; **prod deploy is owner-consent-gated**.)*

---

## Files to change (summary)

- **NEW (FE):** `frontend/src/lib/stripEmailQuote.ts` — pure `stripEmailQuote(sanitizedHtml: string): string`: `DOMParser` parse → ordered/guarded detection (table) → remove boundary subtree + preceding attribution (OQ-QS-A) → D5 near-empty check (return input on fallback) → re-serialize `document.body.innerHTML` (preserving a kept body-level `<style>`, OQ-QS-B); `try/catch` → return input on any error; idempotent.
- **CHANGE (FE):** `frontend/src/components/email/SafeEmailHtml.tsx` — add `stripQuotedHistory?: boolean` (default `false`) to `SafeEmailHtmlProps`; inside the `useMemo` (l.106–112) apply `stripEmailQuote` to the sanitized string when the flag is set; extend the memo dep array to `[memoKey, allowImages, stripQuotedHistory]`. Shadow render (l.114–137) untouched.
- **CHANGE (FE):** `frontend/src/components/pulse/EmailListItem.tsx` — pass `stripQuotedHistory` on the M1 `<SafeEmailHtml>` (l.117–122); repoint the `showImagesButton` probe (l.56) at the **stripped** display HTML (`stripEmailQuote(sanitizeEmailHtml(email.body_html||'', {allowImages:false}))`, memoized on `email.id`) instead of raw `email.body_html` (OQ-QS-4).
- **REUSED unchanged:** `frontend/src/lib/sanitizeEmailHtml.ts` (D4/AC-8 — NOT modified), `frontend/src/lib/linkifyText.ts` + M2/M3 paths (FR-12), `toTimelineBody`/`emailTimelineBody.js` (behavioral precedent only, not called from FE), all EMAIL-HTML-RENDER-001 / EMAIL-TIMELINE-001 backend + OAuth/sync/send paths.
- **UNCHANGED (asserted):** `frontend/src/components/email/EmailMessageItem.tsx` — does **NOT** pass `stripQuotedHistory` → full thread (D2/FR-3/AC-2).
- **Migration: NO. Backend: NO. New dependency: NO** (built-in `DOMParser`). **Protected files untouched:** `backend/src/server.js`, `frontend/src/lib/authedFetch.ts`, `frontend/src/hooks/useRealtimeEvents.ts`, DB schema.

---

## Middleware / tenancy

- **No new API route/endpoint, no query change.** `body_html` already flows to the timeline item via EMAIL-HTML-RENDER-001 (`getTimelineEmailByContact`, already `authenticate` + `requireCompanyAccess`, `company_id` via `req.companyFilter?.company_id`). This is a pure **client render transform** on already-company-scoped data — **no new cross-tenant surface**; multi-tenant scoping is unchanged.

---

## Out of scope (v1)

- Any **expander / collapse / "Show quoted text"** UI (explicitly rejected — D1).
- Stripping quotes in the **`/email` workspace** (`EmailMessageItem`) — keeps the full thread (D2).
- Changing the **outbound** or **inbound-plain-text** render paths (already quote-stripped via `toTimelineBody`).
- HTML **signature** stripping — only *quoted history* is removed; a signature outside the quote is kept (NFR-CORRECT-2). A signature embedded *inside* the quoted subtree goes with the quote (acceptable).
- Any **DOMPurify / sanitizer** config change (D4); any CSP/iframe rearchitecture.
- Any **backend / query / migration** change; **server-side** quote-collapsing of `body_html`.
- **Broader Outlook coverage** beyond the narrow `#appendonsend` + `border-top`-after-`From:` cases (OQ-QS-C — deferred; no prod Outlook sample; 2599 is Gmail).
- Persisting a per-email / per-sender "show full thread" preference.

---

## Residual open questions (deferred, non-blocking)

- **OQ-QS-C follow-up (future):** broader Outlook quote detection once a real prod Outlook thread exists to tune against (styled dividers, localized "From:" headers). v1 deliberately under-strips these (harmless).
