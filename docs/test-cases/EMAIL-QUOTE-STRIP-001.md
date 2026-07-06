# Тест-кейсы: EMAIL-QUOTE-STRIP-001 — strip quoted thread history from inbound-HTML emails in the Pulse timeline (timeline-only)

**Source spec:** `Docs/specs/EMAIL-QUOTE-STRIP-001.md` (scenarios S1–S20, the ordered detection + over-strip guard decision table, the near-empty D5 predicate, the attribution-line removal OQ-QS-A, serialize fidelity OQ-QS-B, Outlook deferral OQ-QS-C, AC-1…AC-14) + `Docs/requirements.md` §EMAIL-QUOTE-STRIP-001 (D1–D6, l.3378) + `Docs/architecture.md` §EMAIL-QUOTE-STRIP-001 (seam OQ-QS-2, detection OQ-QS-3, near-empty OQ-QS-1, image-probe OQ-QS-4, Outlook OQ-QS-5, l.4110).

**Design under test (change points — `stripEmailQuote.ts` does NOT exist yet; this doc is written BEFORE implementation):**
- **NEW `frontend/src/lib/stripEmailQuote.ts`** — pure `stripEmailQuote(sanitizedHtml: string): string`. Parses the **already-sanitized** string via `new DOMParser().parseFromString(html, 'text/html')`; runs **ordered detection** (row 1 `.gmail_quote` → row 2 `blockquote[type="cite"]` → row 3a Outlook `#appendonsend` / row 3b `border-top`-after-`From:` → row 4 `.yahoo_quoted` → row 5 guarded first top-level `<blockquote>` → row 6 `On…wrote:` text fallback); removes the boundary subtree **plus** the immediately-preceding attribution sibling (OQ-QS-A); chooses the **earliest/outermost** cut; applies the **over-strip guard** (mid-body `<blockquote>` with content-after = KEPT); applies the **near-empty predicate** (normalized visible text `< 2` chars AND no `<img src|data-blanc-src>`/`<table>`/`<picture>` → return the FULL input unchanged); **fail-safe** `try/catch` → return input on any throw; **idempotent**; pure `string→string`; preserves a body-level `<style>` that precedes the quote (OQ-QS-B); re-serializes from `document.body.innerHTML`.
- **CHANGE `frontend/src/components/email/SafeEmailHtml.tsx`** — add `stripQuotedHistory?: boolean` (default `false`) to `SafeEmailHtmlProps`; inside the existing `useMemo` (**l.106–112**) apply `stripEmailQuote(...)` to the sanitized string **after** `sanitizeEmailHtml(html, { allowImages })` when the flag is `true`; extend the memo dep array from `[memoKey, allowImages]` → **`[memoKey, allowImages, stripQuotedHistory]`**. Shadow attach / base-sheet / wholesale `innerHTML` re-set (l.114–137) **untouched**.
- **CHANGE `frontend/src/components/pulse/EmailListItem.tsx`** — pass `stripQuotedHistory` (always `true`) on the M1 `<SafeEmailHtml>` (**l.117–122**); repoint the `showImagesButton` probe (**l.56**, today `REMOTE_IMG_RE.test(email.body_html || '')`) at the **stripped display HTML** = `stripEmailQuote(sanitizeEmailHtml(email.body_html || '', { allowImages: false }))`, computed once and **memoized on `email.id`** (OQ-QS-4).
- **UNCHANGED (asserted):** `frontend/src/lib/sanitizeEmailHtml.ts` (D4/AC-8 — NOT modified), `frontend/src/components/email/EmailMessageItem.tsx` (does NOT pass the flag → full thread, D2/AC-2), `frontend/src/lib/linkifyText.ts` + M2/M3 text paths (FR-12), all EMAIL-HTML-RENDER-001 / EMAIL-TIMELINE-001 backend + OAuth/sync/send paths. **Backend / query / type / migration / new npm package: NONE** (built-in `DOMParser`).

---

## ⚠️ TEST VEHICLE — READ FIRST (the prescription is pinned; do NOT assume a runner that isn't installed)

**Investigated, verified in this worktree (2026-07-06):**

| Fact | Evidence | Consequence |
|------|----------|-------------|
| **Frontend has NO unit-test runner** | `frontend/package.json` scripts = `dev/build/lint/preview` only; **0** `*.test.*` under `frontend/src`; no `jest`/`vitest`/`@testing-library` in devDeps (memory "frontend has NO test harness" — VERIFIED) | Nowhere to run a frontend unit test today. |
| **`jsdom` / `jest-environment-jsdom` / `vitest` are NOT in the repo** | absent from root + `frontend` `node_modules`; **0 hits** in `frontend/package-lock.json` (checked during EMAIL-HTML-RENDER-001) | A `@jest-environment jsdom` docblock **cannot** run — the env package isn't installed. Adding it as a *shipped* dep is forbidden by the spec (AC-12: no new npm package). |
| **`stripEmailQuote.ts` is TS-ESM and cannot be `require`d by Node** | it is a NEW `.ts` (does not exist yet); the 9 `scripts/verify-*.js` all `require(...)` **backend CJS** modules; **no** `ts-node`/`tsx`/`esbuild`/`sucrase`/`@swc/register` installed | A node verify script **cannot `require()`** the TS transform as-is. It must carry a **verbatim CJS port** + a **parity guard** (the EMAIL-HTML-RENDER-001 pattern). |
| **`stripEmailQuote` calls `DOMParser` (not `document.createElement`)** | spec Contract 1: `new DOMParser().parseFromString(html, 'text/html')`; jsdom exposes `DOMParser` as `new JSDOM('').window.DOMParser` — **it is NOT a Node global** | The script MUST inject/construct a jsdom `DOMParser` and make it visible to the ported transform (assign to `global.DOMParser` **or** hand a `DOMParser` constructor into the port). |
| **jsdom `DOMParser` correctly parses + serializes the boundary shapes** | scratchpad probe (`new JSDOM('').window.DOMParser`, v29.1.1): `parseFromString('<div class=gmail_quote>x</div>','text/html').querySelector('.gmail_quote')` → **found**; `doc.body.innerHTML` → `<div class="gmail_quote">x</div>` | The whole detection table + serialize round-trip is **headless-checkable** under jsdom `DOMParser`. |
| **The scratchpad already has jsdom (from EMAIL-HTML-RENDER-001)** | `<scratchpad>/node_modules/jsdom` present, **v29.1.1**; `require('jsdom')` resolves | **Reuse it via `NODE_PATH=<scratchpad>/node_modules`** — no new install, no repo dep. |
| **The parent verify script exists and is the exact template** | `scripts/verify-email-html-render-001.js` (39 KB): `#!/usr/bin/env node`, `'use strict'`, jsdom via `NODE_PATH`, **CJS port + `parity` section** (`fs.readFileSync` the `.ts`, `check(...)` load-bearing bits), **`sab` section**, assert kit `check`/`eq`/`record`/`class CheckError`, `--section=…|all`, `process.exit(fail>0?1:0)` | Clone its structure verbatim; only the port body + the fixtures + the parity terms change. |
| **The attribution regex family is a real, verifiable precedent** | `backend/src/services/email/emailTimelineBody.js` l.36–40: `RE_ON_WROTE = /^\s*On\s.+\swrote:\s*$/`, `RE_ON_START = /^\s*On\s.+$/`, `RE_WROTE_END = /wrote:\s*$/` | The port's attribution regexes MUST mirror these (OQ-QS-A single-line + 1–2-line wrap); the parity guard asserts the ported regexes match. |

### Vehicle decision — the ONE automated vehicle (each choice justified by the table above)

**This feature's entire automated coverage = ONE new standalone Node verify script `scripts/verify-email-quote-strip-001.js`** (Node + jsdom, run from repo root). There is **no backend** in this feature, so **no backend jest** is needed; there is no FE runner and no jsdom-jest env, so the pure-fn matrix cannot run under root jest. This script is the only vehicle that works with installed deps.

- **Reuse the scratchpad jsdom (no repo dep, satisfies AC-12).** `jsdom@29.1.1` is already installed in the scratchpad from the EMAIL-HTML-RENDER-001 run. Run:
  ```
  NODE_PATH=<scratchpad>/node_modules node scripts/verify-email-quote-strip-001.js [--section=detect|guard|nearempty|attribution|nested|idempotent|style|xss|failsafe|probe|parity|sab|all]
  ```
  The script **ships** in the repo; jsdom is **dev/verify-only** (never added to any `package.json`, never bundled) — so it does **not** violate "no new npm package" (AC-12).
- **jsdom `DOMParser` injection (load-bearing detail — `stripEmailQuote` uses `DOMParser`, not a Node global).** At startup the script does:
  ```js
  const { JSDOM } = require('jsdom');
  const { window } = new JSDOM('');
  global.DOMParser = window.DOMParser;   // the ported transform reads `new DOMParser()`
  ```
  (or hands `window.DOMParser` into the port as a param). The scratchpad probe confirms `window.DOMParser` parses `.gmail_quote` and serializes via `document.body.innerHTML`. If jsdom/`DOMParser` cannot be loaded, the script prints the `NODE_PATH` remedy and `process.exit(2)` (parent-script pattern).
- **CJS port + PARITY guard (because the `.ts` can't be `require`d).** The script holds a **verbatim CJS port** of `stripEmailQuote` (same ordered detectors, same attribution regexes, same near-empty predicate, same guard, same fail-safe). Because a port can silently drift, a **`parity` section (TC-EQS-P01)** reads `frontend/src/lib/stripEmailQuote.ts` via `fs.readFileSync` and asserts the load-bearing bits still match — **exactly the parent's `runParity()` idiom** (`check(norm(src).includes(norm('…')))`):
  - the **ordered selector literals**: `'.gmail_quote'`, `'blockquote[type="cite"]'`, `'#appendonsend'`, `'.yahoo_quoted'`, and a top-level `'blockquote'` scan;
  - the **attribution regex family**: `/^\s*On\s.+\swrote:\s*$/` (single-line), `/^\s*On\s.+$/` (wrap start), `/wrote:\s*$/` (wrap end) — mirroring `emailTimelineBody.js`;
  - the **near-empty rule**: a `< 2` visible-text threshold **and** the media guard (`img` with `src` **or** `data-blanc-src`, `table`, `picture`), **and** the zero-width strip set (`​‌‍﻿`);
  - the **over-strip guard** wording (first top-level `<blockquote>` stripped only if attribution-preceded OR trailing);
  - the **fail-safe**: `try {` … `catch` … `return sanitizedHtml` (return the **input**, never `''`, never raw).
  If the `.ts` changes a load-bearing bit the port did not mirror, `parity` **FAILs loudly**. (If the Implementer instead wires a TS/ESM loader so the script imports the real `.ts`, TC-EQS-P01 asserts THAT import resolves to the real file — pick one; absent a loader today, the port + parity is the working default.)
- **Assertions are structural, not brittle-string.** Re-parse each transform output into a jsdom fragment and assert via `querySelector`/`querySelectorAll`/`textContent` (`out.querySelector('.gmail_quote') === null`, `out.querySelectorAll('blockquote').length === 0`, `out.textContent.includes('new reply')`), so serialization quirks (attribute order/quoting/whitespace) don't cause false FAILs.
- **NOT prescribed:** `@jest-environment jsdom` (env package absent), adding jsdom/vitest to any `package.json` (would be a shipped dep — AC-12), a backend jest suite (this feature has no backend).

### Unit-headless vs manual-browser split (explicit — mirrors the parent's binding lesson)

- **Unit-testable-headless (pure `stripEmailQuote` under jsdom `DOMParser`, in `scripts/verify-email-quote-strip-001.js`):** the **entire detection table** (rows 1–6, HIGH-direct + LOW/GUARDED), the **over-strip guard** (mid-body blockquote KEPT vs trailing/attributed stripped), the **earliest/outermost cut** on nested threads, **attribution-line removal** (OQ-QS-A shapes incl. 1–2-line wrap and split-across-two-siblings), the **near-empty predicate** (all-quote→FULL, image-only→KEPT, `<2`-char rule with zero-width stripping), **idempotence** (`strip(strip(x))===strip(x)`), **fail-safe→input** (forced throw), **no-boundary passthrough===input**, **`<style>` preservation** (OQ-QS-B), the **XSS-neutrality** (strip only removes, never adds — no `<script>`/`on*` can appear that wasn't in the input), and the **probe** logic (`REMOTE_IMG_RE` on the stripped string). The `.ts` transform is pure, so its string output is fully headless-checkable.
- **Manual / browser (NOT the verify script — MANDATORY, run in the deploy window on a real prod-DB copy):** on **`/pulse/timeline/2599`** — the bubble shows **only the new reply** (no expand / "Show quoted text" control anywhere, D1); the `/email` **workspace** STILL shows the **full** thread (D2 regression); the **all-quote** email still renders full content (never blank); **"Show images"** appears only when the kept reply has a remote image and reveals only kept-reply images; **no scroll jank** on a long timeline of large HTML threads; the **EMAIL-HTML-RENDER-001 hostile sample** still sanitizes with stripping active. *(House lesson — LIST-PAGINATION-001 / created_by-FK / PULSE-PERF-001: never trust headless for shadow-DOM render, live network, or jank; verify in a real browser on a prod-DB copy before any deploy; **prod deploy is owner-consent-gated**.)*
- **Build-only:** the `SafeEmailHtml` memo dep array includes `stripQuotedHistory`; `EmailListItem` passes the flag + repoints the probe; `EmailMessageItem` does **not** pass the flag; `sanitizeEmailHtml.ts` untouched; `frontend/package.json` shows no new package; `cd frontend && npm run build` (`tsc -b`, stricter prod Docker gate) green.

> **What a green verify run does NOT prove** (must be eyeballed manually before ship): the shadow-DOM render of the stripped 2599 reply, that the `/email` workspace still shows the full thread, that the all-quote fallback isn't a blank bubble in the real UI, and that a long timeline doesn't jank. Green matrix + green manual on a prod-copy = ship bar.

---

## Scenario map (spec S-id / AC → coverage)

| S / AC | Meaning | Priority | Vehicle & where PROVEN |
|--------|---------|----------|------------------------|
| **S1 / AC-1, AC-3** | Gmail `.gmail_quote` + `On…wrote:` → only the new reply remains (boundary + attribution gone) | **P0** | headless (`detect`) **+** manual (2599 render) |
| **S2 / AC-3** | Apple `blockquote[type="cite"]` → stripped | **P0** | headless (`detect`) |
| **S3** | Yahoo `.yahoo_quoted` → stripped | **P0** | headless (`detect`) |
| **S4 / AC (OQ-QS-C)** | Outlook `#appendonsend` → stripped | **P0** | headless (`detect`) |
| **S5 / AC-4** | Nested 3-deep → one OUTERMOST/earliest cut, zero levels survive | **P1** | headless (`nested`) |
| **S6 / AC-6** | Over-strip guard: mid-body `<blockquote>` + content-after → KEPT | **P0** | headless (`guard`) |
| **S7 / AC-3** | Guarded `<blockquote>`: bare trailing + preceding attribution → stripped | **P0** | headless (`guard`) |
| **S8 / AC-6** | No boundary → passthrough byte-identical (no-op) | **P0** | headless (`detect`) |
| **S9 / AC-7** | Attribution present, no `<blockquote>` after → text-fallback cut | **P1** | headless (`attribution`) |
| **S10 / AC-5** | All-quote bare forward → near-empty → render FULL (never blank) | **P0** | headless (`nearempty`) **+** manual |
| **S11 / AC-5, AC-7** | Attribution-only → near-empty → render FULL | **P1** | headless (`nearempty`) |
| **S12 / AC-14** | Image-only reply (no text) → KEPT (media guard) | **P0** | headless (`nearempty`) |
| **S13 / AC-8** | Transform throws → fail-safe returns input (full sanitized) | **P0** | headless (`failsafe`) |
| **S14 / AC-10** | Idempotent: `strip(strip(x))===strip(x)` | **P1** | headless (`idempotent`) |
| **S15 / AC-2** | Workspace (`EmailMessageItem`) unchanged — full thread (regression) | **P0** | `[build]`/grep **+** manual |
| **S16 / AC-10** | `allowImages` toggle re-render → reply stays stripped, kept images reveal | **P1** | headless (`idempotent`) **+** manual |
| **S17 / AC-11** | "Show images" probe reflects KEPT reply, not the stripped quote | **P1** | headless (`probe`) **+** manual |
| **S18 / AC-8** | XSS unaffected: strip on already-sanitized DOM adds nothing | **P0** | headless (`xss`) |
| **S19** | Empty/degenerate marker → removed, no crash, no empty bubble | **P2** | headless (`nearempty`/`detect`) |
| **S20 / AC-11-scope** | Outbound + inbound-plain-text never invoke strip | **P1** | `[build]`/grep + manual |
| **AC-9 (memo)** | Strip memoized per `(message, images-state)` — dep includes the flag, not per scroll | **P1** | `[build]` (dep array) **+** manual (no jank) |
| **AC-12 (dep)** | No new npm package (built-in `DOMParser`) | **P0** | `[build]` (package.json diff) |
| **AC-13 (`<style>`)** | Kept-reply body-level `<style>` preserved through parse→serialize | **P1** | headless (`style`) |

**The P0 gates that MUST be green before ship:** the **headless detection matrix** (`detect` — one case per client boundary, boundary + attribution removed), the **over-strip guard** (`guard` — mid-body KEPT vs trailing stripped), the **near-empty** trio (`nearempty` — all-quote→FULL, image-only→KEPT), the **fail-safe** (`failsafe` — throw→input), the **XSS-neutrality** (`xss`), plus the **sabotage** (`sab`) and **parity** (`parity`) self-checks, **and** the **manual browser pass** on 2599 (only-new render + workspace-full regression + all-quote-not-blank + probe + no-jank + hostile-sample). Prod deploy is owner-consent-gated.

---

## Покрытие / Coverage

- Всего тест-кейсов: **43** (numbered TC-EQS-*, incl. the 2 harness self-checks `TC-EQS-SAB` + `TC-EQS-P01`) + **6** regression/protected = **49**.
- **By priority (all TC-EQS-*): P0: 19 | P1: 18 | P2: 6.** (P0 includes the sabotage + parity self-checks.)
- **By type — unit-headless (Node+jsdom, `scripts/verify-email-quote-strip-001.js`): 31 (detect ×6, guard ×3, nearempty ×5, attribution ×5, nested ×2, idempotent ×2, style ×2, xss ×2, failsafe ×2, probe ×2) + the `sab` self-check | build/static: 6 (B01–B05 + the `parity` self-check TC-EQS-P01) | manual-browser: 5 (M01–M05).** (Several headless cases are parametrized — the raw assertion count is higher.)
- Every spec scenario **S1–S20** covered; positive + negative per scenario. **Fail-safe** (throw→input) covered headless (TC-EQS-F01). **XSS-neutrality** = the strip only removes nodes, so it cannot reintroduce a handler (TC-EQS-X01/X02). **No new middleware/tenancy surface** — this is a pure client render transform on already-company-scoped `body_html` (EMAIL-HTML-RENDER-001 already surfaced it via the `authenticate`+`requireCompanyAccess` timeline read); **no new route/param → no new 401/403/cross-tenant case** (asserted "unchanged", TC-R-6). **Sabotage negative control** = TC-EQS-SAB. **Parity guard** = TC-EQS-P01.

---

## Shared harness (headless script)

House pattern of `scripts/verify-email-html-render-001.js` (the parent) — **no DB, no mocks of app logic**; the "unit under test" is the **pure `stripEmailQuote` transform**, re-hosted on jsdom `DOMParser`:

- **Script:** `scripts/verify-email-quote-strip-001.js`, sections `detect` / `guard` / `nearempty` / `attribution` / `nested` / `idempotent` / `style` / `xss` / `failsafe` / `probe` / `parity` / `sab`, selectable via `--section=<id>|all`. Exit code 0 only when **no case FAILs**. Reuse the tiny assert kit (`check(cond,msg)` / `eq(actual,expected,label)` / `record(id,status,note)` / `class CheckError`) verbatim from the parent.
- **DOM:** `const { JSDOM } = require('jsdom'); const { window } = new JSDOM(''); global.DOMParser = window.DOMParser;` — so the ported `stripEmailQuote` reads `new DOMParser().parseFromString(...)` headless. (jsdom resolved via `NODE_PATH=<scratchpad>/node_modules`; the scratchpad already has `jsdom@29.1.1`.) If it can't load, print the NODE_PATH remedy + `process.exit(2)`.
- **Port + parity:** the script holds a **verbatim CJS port** of `stripEmailQuote` (ordered detectors, attribution regexes, near-empty predicate, guard, fail-safe). **TC-EQS-P01** (`parity`) `fs.readFileSync`s `frontend/src/lib/stripEmailQuote.ts` and `check(...)`s the load-bearing bits (selectors, regex family, `<2`+media rule, guard wording, fail-safe returns input) — so the matrix can never certify a transform that differs from what ships.
- **Fixtures** (crafted, per spec shapes — NOT the raw 2599 PII; a sanitized 2599 excerpt may be checked in under `scripts/fixtures/email-quote-strip/` for the S1 case, matching the parent's `lsa-3044.html` precedent): a Gmail `GMAIL` (`<div>new reply</div><div dir="ltr" class="gmail_attr">On Mon, … wrote:</div><div class="gmail_quote"><blockquote>…history…</blockquote></div>`), an Apple `APPLE` (`type="cite"`), a Yahoo `YAHOO` (`.yahoo_quoted`), an Outlook `OUTLOOK` (`#appendonsend`), a `NESTED` 3-deep, a `MIDBLOCK` (mid-body `<blockquote>` + content-after, no attribution), a `TRAILBLOCK` (attribution + bare trailing `<blockquote>`), a `NOQUOTE` fresh email, an `ALLQUOTE` bare forward, an `ATTRONLY`, an `IMGONLY` (`<img data-blanc-src>` reply, no text), a `TEXTFALLBACK` (`On…wrote:` + bare quoted text, no `<blockquote>`), a `STYLED` (leading `<style>` + quote), an `XSSQUOTE` (the parent's already-sanitized hostile output + a `.gmail_quote`).
- **Assertions are structural:** parse each output back into a jsdom fragment and assert via `querySelector`/`querySelectorAll`/`textContent`.
- **Sabotage (`sab`):** run the `detect` assertions against a variant where the strip step is a **pass-through** (`html => html`) and confirm the harness **records FAIL** on the Gmail/Apple/Yahoo/Outlook cases (the quote survives). Then restore → green. Proves the matrix is load-bearing.

---

## 1. Headless script — `detect` section (the detection matrix — one case per client boundary)

> **Why this section is non-negotiable:** it is the core P0 proof that each client's quote boundary is found and cut. Green here + green manual on 2599 is the ship bar for AC-1/AC-3.

### TC-EQS-D01: Gmail `.gmail_quote` + preceding `gmail_attr` "On … wrote:" → BOTH removed, only new reply remains
- **Приоритет:** P0
- **Тип:** unit-headless (Node+jsdom)
- **Связанный сценарий:** S1; AC-1, AC-3; detector row 1 (HIGH); OQ-QS-A
- **Вход:** `stripEmailQuote(GMAIL)` where `GMAIL = '<div>new reply here</div><div dir="ltr" class="gmail_attr">On Mon, Jul 6, 2026, Jane <j@x.io> wrote:</div><div class="gmail_quote"><blockquote type="cite">prior thread text</blockquote></div>'`.
- **Ожидаемый результат:** parsed output has `querySelector('.gmail_quote') === null` **and** `querySelector('.gmail_attr') === null` (the attribution sibling removed, OQ-QS-A) **and** `textContent` contains `"new reply here"` **and** does NOT contain `"prior thread text"` **and** does NOT contain `"wrote:"`. No expand/ellipsis marker added.
- **Файл:** `scripts/verify-email-quote-strip-001.js` (`detect`)

### TC-EQS-D02: Apple Mail `blockquote[type="cite"]` + attribution → stripped
- **Приоритет:** P0
- **Тип:** unit-headless
- **Связанный сценарий:** S2; AC-3; detector row 2 (HIGH)
- **Вход:** `stripEmailQuote(APPLE)` where `APPLE = '<div>my new answer</div><div>On Jul 6, 2026, at 09:00, Bob <b@x.io> wrote:</div><blockquote type="cite">quoted apple history</blockquote>'`.
- **Ожидаемый результат:** `querySelector('blockquote[type="cite"]') === null`; the attribution `<div>` removed; `textContent` has `"my new answer"`, lacks `"quoted apple history"` and `"wrote:"`.
- **Файл:** `scripts/verify-email-quote-strip-001.js` (`detect`)

### TC-EQS-D03: Yahoo `.yahoo_quoted` → stripped
- **Приоритет:** P0
- **Тип:** unit-headless
- **Связанный сценарий:** S3; detector row 4 (HIGH)
- **Вход:** `stripEmailQuote(YAHOO)` where `YAHOO = '<div>yahoo new reply</div><div class="yahoo_quoted">quoted yahoo history</div>'`.
- **Ожидаемый результат:** `querySelector('.yahoo_quoted') === null`; `textContent` has `"yahoo new reply"`, lacks `"quoted yahoo history"`.
- **Файл:** `scripts/verify-email-quote-strip-001.js` (`detect`)

### TC-EQS-D04: Outlook `#appendonsend` → stripped
- **Приоритет:** P0
- **Тип:** unit-headless
- **Связанный сценарий:** S4; detector row 3a (HIGH); OQ-QS-C narrow guarantee
- **Вход:** `stripEmailQuote(OUTLOOK)` where `OUTLOOK = '<div>outlook new reply</div><div id="appendonsend"></div><div>From: Bob<br>Sent: …<br>quoted outlook history</div>'`.
- **Ожидаемый результат:** `getElementById('appendonsend') === null` and everything after it removed; `textContent` has `"outlook new reply"`, lacks `"quoted outlook history"`.
- **Файл:** `scripts/verify-email-quote-strip-001.js` (`detect`)

### TC-EQS-D05: No boundary → passthrough byte-identical (no-op)
- **Приоритет:** P0
- **Тип:** unit-headless
- **Связанный сценарий:** S8; AC-6 (no-op arm); FR-9
- **Вход:** `stripEmailQuote(NOQUOTE)` where `NOQUOTE = '<div>Fresh lead email. <a href="https://x.io">Reply</a></div>'` (no `.gmail_quote`/`type=cite`/`.yahoo_quoted`/`#appendonsend`/`<blockquote>`/`On…wrote:`).
- **Ожидаемый результат:** the returned string **=== the input string** (byte-identical; the transform is a pure no-op when no detector matches). No node added or removed.
- **Файл:** `scripts/verify-email-quote-strip-001.js` (`detect`)

### TC-EQS-D06: Outlook CONSERVATIVE — `border-top` `<div>` WITHOUT a preceding `From:` header run → NOT cut (deliberate under-strip)
- **Приоритет:** P2
- **Тип:** unit-headless (negative)
- **Связанный сценарий:** S4-adjacent; OQ-QS-C / detector row 3b guard
- **Вход:** `stripEmailQuote('<div>reply</div><div style="border-top:1px solid #ccc">not a header, just a rule</div><div>more reply</div>')` (a `border-top` div NOT immediately following a `From:`/`Sent:`/`To:` run).
- **Ожидаемый результат:** nothing stripped (row 3b requires the exact header-run-then-border-top shape); output === input. Confirms the conservative Outlook guard under-strips rather than over-strips a stray divider. (Positive row-3b shape is covered by manual only — no prod Outlook sample; OQ-QS-C.)
- **Файл:** `scripts/verify-email-quote-strip-001.js` (`detect`)

---

## 2. Headless script — `guard` section (the over-strip guard — row 5)

### TC-EQS-G01: Mid-body `<blockquote>` with REAL content after it → KEPT (not over-stripped)
- **Приоритет:** P0
- **Тип:** unit-headless
- **Связанный сценарий:** S6; AC-6 (over-strip guard); EC-6
- **Вход:** `stripEmailQuote(MIDBLOCK)` where `MIDBLOCK = '<div>As you said:</div><blockquote>an inline quotation</blockquote><div>here is my actual reply after it</div>'` (top-level `<blockquote>`, **no** client class, **no** attribution before it, **real content after**).
- **Ожидаемый результат:** `querySelector('blockquote') !== null` (KEPT) **and** `textContent` still contains **both** `"an inline quotation"` **and** `"here is my actual reply after it"`. Guard fails (not attribution-preceded AND not trailing) → row 5 does NOT strip; row 6 finds no attribution → no cut. Output === input.
- **Файл:** `scripts/verify-email-quote-strip-001.js` (`guard`)

### TC-EQS-G02: Bare TRAILING top-level `<blockquote>` + preceding attribution → stripped
- **Приоритет:** P0
- **Тип:** unit-headless
- **Связанный сценарий:** S7; AC-3; row 5 guard (a) attribution-preceded AND (b) trailing
- **Вход:** `stripEmailQuote(TRAILBLOCK)` where `TRAILBLOCK = '<div>new reply text</div><div>On Jul 6, 2026, Sam <s@x.io> wrote:</div><blockquote>trailing history block</blockquote>'` (no client class; attribution above; blockquote is the trailing element).
- **Ожидаемый результат:** `querySelector('blockquote') === null` **and** the attribution `<div>` removed; `textContent` has `"new reply text"`, lacks `"trailing history block"` and `"wrote:"`. Contrast with TC-EQS-G01 (mid-body → KEPT).
- **Файл:** `scripts/verify-email-quote-strip-001.js` (`guard`)

### TC-EQS-G03: Bare trailing `<blockquote>` with NO attribution before it → stripped via guard (b) trailing-block arm
- **Приоритет:** P1
- **Тип:** unit-headless
- **Связанный сценарий:** S7-variant; row 5 guard (b)
- **Вход:** `stripEmailQuote('<div>reply</div><blockquote>trailing quoted history</blockquote>')` (blockquote is the last element; nothing but whitespace follows).
- **Ожидаемый результат:** `querySelector('blockquote') === null` (guard (b) trailing-block satisfied even without attribution); `textContent` has `"reply"`, lacks `"trailing quoted history"`. Documents that a bare trailing blockquote IS a boundary (distinct from G01's mid-body-with-content-after).
- **Файл:** `scripts/verify-email-quote-strip-001.js` (`guard`)

---

## 3. Headless script — `nearempty` section (D5 predicate)

### TC-EQS-N01: All-quote bare forward → near-empty → returns FULL input unchanged (never blank)
- **Приоритет:** P0
- **Тип:** unit-headless
- **Связанный сценарий:** S10; AC-5; D5
- **Вход:** `stripEmailQuote(ALLQUOTE)` where `ALLQUOTE = '<div class="gmail_quote"><blockquote>the entire forwarded thread, nothing new above</blockquote></div>'` (a boundary matches; the candidate strip removes essentially everything).
- **Ожидаемый результат:** the candidate stripped body has `normVisibleText < 2` AND no kept `<img>`/`<table>`/`<picture>` → **both** D5 conditions hold → the function returns the **FULL input string unchanged** (=== input). `textContent` of the output STILL contains `"the entire forwarded thread"` (nothing lost; never a blank bubble).
- **Файл:** `scripts/verify-email-quote-strip-001.js` (`nearempty`)

### TC-EQS-N02: Attribution-only email (nothing meaningful after removal) → near-empty → returns FULL
- **Приоритет:** P1
- **Тип:** unit-headless
- **Связанный сценарий:** S11; AC-5, AC-7; D5 + FR-10 tail
- **Вход:** `stripEmailQuote(ATTRONLY)` where `ATTRONLY = '<div>On Jul 6, 2026, Ann <a@x.io> wrote:</div><blockquote>quoted history only, no new text</blockquote>'`.
- **Ожидаемый результат:** the candidate cut empties the body (< 2 chars, no media) → D5 holds → returns the FULL input unchanged; output `textContent` still has `"quoted history only"`. Never blank.
- **Файл:** `scripts/verify-email-quote-strip-001.js` (`nearempty`)

### TC-EQS-N03: Image-only reply (inline image, no text) → KEPT stripped (media guard, D5 condition 2 FAILS)
- **Приоритет:** P0
- **Тип:** unit-headless
- **Связанный сценарий:** S12; AC-14; D5 media guard
- **Вход:** `stripEmailQuote(IMGONLY)` where `IMGONLY = '<div><img data-blanc-src="https://cdn.x/screenshot.png"></div><div class="gmail_quote"><blockquote>quoted history</blockquote></div>'` (new content = a single to-be-revealed image, no text).
- **Ожидаемый результат:** after the quote is removed the candidate has `normVisibleText < 2` **but** `querySelector('img[data-blanc-src]') !== null` → D5 condition 2 fails → **keep the stripped result** (NOT the full thread). Output `querySelector('.gmail_quote') === null` AND `querySelector('img') !== null` AND does NOT contain `"quoted history"`. (Also assert the `<img src="data:…">` variant is kept the same way.)
- **Файл:** `scripts/verify-email-quote-strip-001.js` (`nearempty`)

### TC-EQS-N04: Zero-width-only "text" after strip → treated as near-empty (ZWSP/ZWNJ/ZWJ/BOM stripped before the <2 test)
- **Приоритет:** P1
- **Тип:** unit-headless
- **Связанный сценарий:** S10-variant; D5 predicate condition 1 (zero-width normalization)
- **Вход:** `stripEmailQuote('<div>​‌﻿</div><div class="gmail_quote"><blockquote>all history</blockquote></div>')` (the only "text" outside the quote is zero-width glyphs).
- **Ожидаемый результат:** `normVisibleText` strips `​‌‍﻿` + whitespace → length `< 2` → D5 holds (no media) → returns FULL input unchanged. Guards the exact zero-width set from the spec's D5.
- **Файл:** `scripts/verify-email-quote-strip-001.js` (`nearempty`)

### TC-EQS-N05: Empty/degenerate marker (empty `<blockquote>`) + real reply text → marker removed, reply keeps bubble non-empty
- **Приоритет:** P2
- **Тип:** unit-headless
- **Связанный сценарий:** S19; FR-11/EC-5
- **Вход:** `stripEmailQuote('<div>real reply that stays</div><div class="gmail_quote"><blockquote></blockquote></div>')` (present-but-empty marker) AND a variant that is ONLY the empty marker.
- **Ожидаемый результат:** variant 1 → `.gmail_quote` removed, `textContent` still has `"real reply that stays"` (D5 NOT triggered — reply keeps ≥2 chars); no crash. Variant 2 (only the empty marker) → candidate near-empty → D5 → returns FULL input. Neither throws.
- **Файл:** `scripts/verify-email-quote-strip-001.js` (`nearempty`)

---

## 4. Headless script — `attribution` section (text-fallback row 6 + OQ-QS-A shapes)

### TC-EQS-A01: Attribution line, NO `<blockquote>` after → text-fallback cut (row 6)
- **Приоритет:** P1
- **Тип:** unit-headless
- **Связанный сценарий:** S9; AC-7; detector row 6 (LOW/GUARDED), FR-10
- **Вход:** `stripEmailQuote(TEXTFALLBACK)` where `TEXTFALLBACK = '<div>my reply</div><div>On Jul 6, 2026, Kim <k@x.io> wrote:</div><div>bare quoted line 1</div><div>bare quoted line 2</div>'` (attribution as an element, then plain quoted text with NO `<blockquote>`).
- **Ожидаемый результат:** the attribution node **and everything after it** to end-of-body are removed; `textContent` has `"my reply"`, lacks `"bare quoted line 1"`, `"bare quoted line 2"`, `"wrote:"`. (If removal empties the body, D5 fires → S11/TC-EQS-N02.)
- **Файл:** `scripts/verify-email-quote-strip-001.js` (`attribution`)

### TC-EQS-A02: Bare `wrote:` WITHOUT the `On …` shape → does NOT cut (negative — row 6 guard)
- **Приоритет:** P1
- **Тип:** unit-headless (negative)
- **Связанный сценарий:** S9-negative; row 6 guard ("bare `wrote:` does not fire")
- **Вход:** `stripEmailQuote('<div>He wrote: a great review, and here is the rest of my message.</div>')` (contains `wrote:` but not the `^\s*On\s.+\swrote:\s*$` attribution shape).
- **Ожидаемый результат:** nothing stripped; output === input. Confirms the text fallback fires ONLY on the `On …` attribution regex family, not any `wrote:`. (Bias: under-strip over over-strip.)
- **Файл:** `scripts/verify-email-quote-strip-001.js` (`attribution`)

### TC-EQS-A03: Attribution as a 1–2-line HARD WRAP inside one node → matched and removed (OQ-QS-A wrap, single node)
- **Приоритет:** P1
- **Тип:** unit-headless
- **Связанный сценарий:** S1/S2 variant; OQ-QS-A (1–2-line wrap collapsed in one node); mirrors `RE_ON_START` + `RE_WROTE_END`
- **Вход:** `stripEmailQuote('<div>reply</div><div class="gmail_attr">On Mon, Jul 6, 2026 at 9:00 AM\nJane Doe <jane@x.io> wrote:</div><div class="gmail_quote"><blockquote>history</blockquote></div>')` (the attribution wraps across a `\n` within ONE `<div>`: starts `On …`, ends `… wrote:`).
- **Ожидаемый результат:** the wrapped `gmail_attr` node IS recognized as attribution (starts `^\s*On\s.+`, ends `wrote:\s*$` within its own text) and removed along with the `.gmail_quote`; `textContent` has `"reply"`, lacks `"Jane Doe"` and `"history"`.
- **Файл:** `scripts/verify-email-quote-strip-001.js` (`attribution`)

### TC-EQS-A04: Attribution SPLIT across two sibling nodes (`On …` node + `… wrote:` node) → both removed (OQ-QS-A split-wrap)
- **Приоритет:** P2
- **Тип:** unit-headless
- **Связанный сценарий:** OQ-QS-A (wrap split across two siblings, within 2, no blank break)
- **Вход:** `stripEmailQuote('<div>reply</div><div>On Mon, Jul 6, 2026 at 9:00 AM</div><div>Jane Doe &lt;jane@x.io&gt; wrote:</div><blockquote>history</blockquote>')`.
- **Ожидаемый результат:** BOTH the `On …` node and the `… wrote:` node (the paired wrap) preceding the `<blockquote>` are removed; `textContent` has `"reply"`, lacks the two attribution lines and `"history"`.
- **Файл:** `scripts/verify-email-quote-strip-001.js` (`attribution`)

### TC-EQS-A05: Preceding sibling is NOT attribution → left in place (OQ-QS-A under-reach bias)
- **Приоритет:** P1
- **Тип:** unit-headless (negative)
- **Связанный сценарий:** OQ-QS-A ("if it does not match, leave it — never reach into real content")
- **Вход:** `stripEmailQuote('<div>my genuine reply sentence that must survive</div><div class="gmail_quote"><blockquote>history</blockquote></div>')` (the sibling immediately above `.gmail_quote` is real reply text, NOT an attribution).
- **Ожидаемый результат:** `.gmail_quote` removed BUT the real reply `<div>` is **KEPT** (`textContent` still has `"my genuine reply sentence that must survive"`); the strip did NOT walk up into real content. Only the single immediately-preceding sibling is inspected, and it is left because it doesn't match the attribution shape.
- **Файл:** `scripts/verify-email-quote-strip-001.js` (`attribution`)

---

## 5. Headless script — `nested` section (earliest/outermost cut)

### TC-EQS-NE01: 3-deep nested reply → single OUTERMOST/earliest cut, ZERO quoted levels survive
- **Приоритет:** P1
- **Тип:** unit-headless
- **Связанный сценарий:** S5; AC-4; FR-6/EC-2
- **Вход:** `stripEmailQuote(NESTED)` where `NESTED` is a 3-level thread: `<div>newest reply</div>` + `On…wrote:` + `<div class="gmail_quote"><blockquote>level-1 <div>On…wrote:</div><div class="gmail_quote"><blockquote>level-2 <div>On…wrote:</div><blockquote type="cite">level-3</blockquote></blockquote></div></blockquote></div>`.
- **Ожидаемый результат:** a **single** cut at the outermost/earliest boundary removes all levels → `querySelectorAll('.gmail_quote').length === 0` AND `querySelectorAll('blockquote').length === 0`; `textContent` has `"newest reply"` and NONE of `"level-1"`/`"level-2"`/`"level-3"`. No inner level leaks back.
- **Файл:** `scripts/verify-email-quote-strip-001.js` (`nested`)

### TC-EQS-NE02: Two independent detectors present (`.gmail_quote` inside a `<blockquote>`) → cut at the earliest-in-document-order boundary
- **Приоритет:** P2
- **Тип:** unit-headless
- **Связанный сценарий:** S5; FR-6 "earliest/outermost"
- **Вход:** `stripEmailQuote('<div>reply</div><div>On…wrote:</div><blockquote>outer <div class="gmail_quote"><blockquote>inner history</blockquote></div></blockquote>')` (a `.gmail_quote` nested inside a top-level `<blockquote>`).
- **Ожидаемый результат:** the chosen cut is the **outermost/earliest** boundary (the top-level structure), so `textContent` has `"reply"` and NEITHER `"outer"` NOR `"inner history"` survive; exactly one cut. Documents that detectors 1–4 take the outermost matching ancestor and the earliest document-order hit wins.
- **Файл:** `scripts/verify-email-quote-strip-001.js` (`nested`)

---

## 6. Headless script — `idempotent` section

### TC-EQS-I01: `stripEmailQuote(stripEmailQuote(x)) === stripEmailQuote(x)` for each client shape
- **Приоритет:** P1
- **Тип:** unit-headless (parametrized over GMAIL/APPLE/YAHOO/OUTLOOK/NESTED/MIDBLOCK/NOQUOTE/ALLQUOTE)
- **Связанный сценарий:** S14; AC-10; NFR-COMPAT-2
- **Вход:** for each fixture `x`: `const once = stripEmailQuote(x); const twice = stripEmailQuote(once);`.
- **Ожидаемый результат:** `twice === once` (byte-identical) for **every** shape — pass 2 matches no boundary (markers gone on pass 1) and returns its input unchanged. Includes the guard/near-empty shapes (KEPT / FULL-returned inputs are also stable under re-application).
- **Файл:** `scripts/verify-email-quote-strip-001.js` (`idempotent`)

### TC-EQS-I02: Re-strip after an `allowImages`-style re-sanitize keeps the reply stripped (no quoted history reappears)
- **Приоритет:** P1
- **Тип:** unit-headless
- **Связанный сценарий:** S16; AC-10; EC-9
- **Вход:** simulate the toggle: `const s1 = stripEmailQuote(sanitizeEmailHtml(RAW, {allowImages:false}))` then `const s2 = stripEmailQuote(sanitizeEmailHtml(RAW, {allowImages:true}))` (RAW = a Gmail reply with a remote image inside the KEPT reply). *(Uses the parent's ported `sanitizeEmailHtml` from `verify-email-html-render-001.js`, or a minimal stand-in that only flips `src`↔`data-blanc-src`.)*
- **Ожидаемый результат:** BOTH `s1` and `s2` have `querySelector('.gmail_quote') === null` (history stays gone across the image-state flip); `s2` has a live `<img src>` in the kept reply where `s1` had `data-blanc-src`. The quoted history does NOT reappear when images are enabled.
- **Файл:** `scripts/verify-email-quote-strip-001.js` (`idempotent`)

---

## 7. Headless script — `style` section (OQ-QS-B serialize fidelity)

### TC-EQS-S01: Body-level `<style>` preceding the quote survives the parse→serialize round-trip
- **Приоритет:** P1
- **Тип:** unit-headless
- **Связанный сценарий:** S1; AC-13; OQ-QS-B
- **Вход:** `stripEmailQuote(STYLED)` where `STYLED = '<style>.reply{color:#333}</style><div class="reply">new reply</div><div class="gmail_quote"><blockquote>history</blockquote></div>'`.
- **Ожидаемый результат:** the output STILL contains the `<style>` node (`querySelector('style') !== null` AND its text includes `.reply{color:#333}`) AND `querySelector('.gmail_quote') === null` AND `textContent` has `"new reply"`, lacks `"history"`. The strip removed ONLY the boundary subtree + attribution — it did NOT drop, hoist, or reorder the leading `<style>` (re-serialized from `document.body.innerHTML`, which keeps a body-level `<style>`).
- **Файл:** `scripts/verify-email-quote-strip-001.js` (`style`)

### TC-EQS-S02: A `<style>` INSIDE the removed quote subtree goes away with the quote (no leak of quote-only CSS)
- **Приоритет:** P2
- **Тип:** unit-headless
- **Связанный сценарий:** OQ-QS-B (only a PRECEDING style is preserved)
- **Вход:** `stripEmailQuote('<div class="reply">reply</div><div class="gmail_quote"><style>.q{color:red}</style><blockquote>history</blockquote></div>')`.
- **Ожидаемый результат:** the `<style>.q{color:red}</style>` (inside `.gmail_quote`) is removed along with the boundary — `querySelector('style') === null`; only the reply remains. Documents that OQ-QS-B preserves a **preceding** style, not one buried in the stripped subtree.
- **Файл:** `scripts/verify-email-quote-strip-001.js` (`style`)

---

## 8. Headless script — `xss` section (XSS-neutrality — strip only removes, never adds)

### TC-EQS-X01: Strip on the already-sanitized hostile sample → quote gone AND no `<script>`/`on*`/`<form>` reintroduced
- **Приоритет:** P0
- **Тип:** unit-headless
- **Связанный сценарий:** S18; AC-8; NFR-SEC-1/D4
- **Вход:** `stripEmailQuote(XSSQUOTE)` where `XSSQUOTE` = the **output of the parent's `sanitizeEmailHtml`** on the EMAIL-HTML-RENDER-001 hostile blob (script neutralized, `onerror` stripped, `<form>` removed, `javascript:` href nulled, remote `<img src>`→`data-blanc-src`) **plus** a trailing `.gmail_quote` history block. *(Reuse the parent script's ported sanitizer to produce `XSSQUOTE`.)*
- **Ожидаемый результат:** on the stripped output — `querySelector('script') === null`, no element has any `on*` attribute (`[...out.querySelectorAll('*')].every(el => ![...el.attributes].some(a => /^on/i.test(a.name)))`), `querySelector('form') === null`, `querySelector('iframe') === null`, no `<a>` href starts with `javascript:`/`data:` — **exactly the parent AC-2 posture** — **and** `querySelector('.gmail_quote') === null` (quote stripped). The strip added NOTHING that wasn't already there.
- **Файл:** `scripts/verify-email-quote-strip-001.js` (`xss`)

### TC-EQS-X02: Node-removal cannot reintroduce a handler — output attribute set ⊆ input attribute set
- **Приоритет:** P1
- **Тип:** unit-headless (invariant)
- **Связанный сценарий:** S18; AC-8; "strip only removes, never adds"
- **Вход:** for each fixture (GMAIL, MIDBLOCK, STYLED, XSSQUOTE): collect the multiset of `(tagName, attrName)` pairs in the input and in the output.
- **Ожидаемый результат:** the output's `(tag, attr)` multiset is a **subset** of the input's for every fixture — the transform never introduces a tag or attribute (e.g. no injected `on*`, no new `<script>`, no added `href`). Proves XSS-neutrality structurally, independent of any single hostile payload.
- **Файл:** `scripts/verify-email-quote-strip-001.js` (`xss`)

---

## 9. Headless script — `failsafe` section

### TC-EQS-F01: Forced throw inside the transform → returns the INPUT unchanged (never `''`, never raw, never throws)
- **Приоритет:** P0
- **Тип:** unit-headless
- **Связанный сценарий:** S13; AC-8; NFR-SEC-2
- **Вход:** force a throw inside the ported `stripEmailQuote` body — e.g. temporarily monkeypatch `global.DOMParser` to a constructor whose `parseFromString` throws, OR stub the internal detection to throw — then call `stripEmailQuote(GMAIL)`.
- **Ожидаемый результат:** returns **`GMAIL` unchanged** (the input `sanitizedHtml`) — `record` PASS only if `out === GMAIL`; **no** exception escapes, output is **not** `''`, output is **not** a partial. (Then restore the real `DOMParser`.) This is the load-bearing fail-safe: React never sees a throw.
- **Файл:** `scripts/verify-email-quote-strip-001.js` (`failsafe`)

### TC-EQS-F02: Empty / degenerate input → returned as-is, no crash
- **Приоритет:** P2
- **Тип:** unit-headless
- **Связанный сценарий:** Contract 1 "empty input → `''`"; S19
- **Вход:** `stripEmailQuote('')`, `stripEmailQuote('   ')`, `stripEmailQuote('<!-- only a comment -->')`.
- **Ожидаемый результат:** `stripEmailQuote('') === ''`; the whitespace/comment inputs return unchanged (no boundary, no throw). No crash on degenerate input.
- **Файл:** `scripts/verify-email-quote-strip-001.js` (`failsafe`)

---

## 10. Headless script — `probe` section (OQ-QS-4 "Show images" probe logic)

> The probe is `REMOTE_IMG_RE.test(strippedDisplayHtml)` where `strippedDisplayHtml = stripEmailQuote(sanitizeEmailHtml(body_html, {allowImages:false}))`. These cases assert the **pure string** the probe runs on — the button-visibility half is manual (TC-EQS-M04).

### TC-EQS-PR01: Remote image ONLY inside the quoted history → probe string has no blockable image (button would be HIDDEN)
- **Приоритет:** P1
- **Тип:** unit-headless
- **Связанный сценарий:** S17 variant A; AC-11; OQ-QS-4
- **Вход:** `REMOTE_IMG_RE.test(stripEmailQuote('<div>text reply, no image</div><div class="gmail_quote"><blockquote><img data-blanc-src="https://track/x.gif"></blockquote></div>'))`.
- **Ожидаемый результат:** the stripped string has **no** `data-blanc-src` / remote `src` (the only remote image was in the removed quote) → `REMOTE_IMG_RE.test(...) === false` → the "Show images" button would NOT appear. Confirms the probe reflects the KEPT reply, not the stripped quote.
- **Файл:** `scripts/verify-email-quote-strip-001.js` (`probe`)

### TC-EQS-PR02: Remote image inside the KEPT reply → probe string has a blockable image (button would be SHOWN)
- **Приоритет:** P1
- **Тип:** unit-headless
- **Связанный сценарий:** S17 variant B; AC-11; OQ-QS-4
- **Вход:** `REMOTE_IMG_RE.test(stripEmailQuote('<div>reply <img data-blanc-src="https://cdn/keep.png"></div><div class="gmail_quote"><blockquote><img data-blanc-src="https://track/x.gif"></blockquote></div>'))`.
- **Ожидаемый результат:** the stripped string retains the kept-reply `<img data-blanc-src="https://cdn/keep.png">` → `REMOTE_IMG_RE.test(...) === true` → the button WOULD appear and reveal the kept-reply image. The affordance matches what is actually visible.
- **Файл:** `scripts/verify-email-quote-strip-001.js` (`probe`)

---

## 11. Build / static gates

### TC-EQS-B01: `SafeEmailHtml` memo dep array includes `stripQuotedHistory`; strip applied AFTER sanitize, inside the memo
- **Приоритет:** P1
- **Тип:** build/static (grep/inspection)
- **Связанный сценарий:** S16; AC-9; NFR-PERF-1; Contract 2
- **Ожидаемый результат:** in `frontend/src/components/email/SafeEmailHtml.tsx` the `useMemo` dep array is `[memoKey, allowImages, stripQuotedHistory]` (the flag added — was `[memoKey, allowImages]` at l.111); the memo body applies `stripEmailQuote(...)` to the `sanitizeEmailHtml(...)` result ONLY when `stripQuotedHistory` is truthy; `stripQuotedHistory?: boolean` (default `false`) is on `SafeEmailHtmlProps`. The shadow attach / base-sheet / wholesale `innerHTML` re-set (l.114–137) are unchanged.
- **Файл:** PR grep / inspection

### TC-EQS-B02: `EmailListItem` passes `stripQuotedHistory` (M1) and repoints the probe at the stripped HTML; `EmailMessageItem` does NOT pass it
- **Приоритет:** P0
- **Тип:** build/static (grep)
- **Связанный сценарий:** S1/S15/S20; AC-1/AC-2/AC-11; frontend wiring
- **Ожидаемый результат:** `grep -n "stripQuotedHistory" frontend/src/components/pulse/EmailListItem.tsx` shows it passed on the M1 `<SafeEmailHtml>` (l.117–122 region); the `showImagesButton` probe (l.56) now tests `stripEmailQuote(sanitizeEmailHtml(email.body_html || '', { allowImages: false }))` (memoized on `email.id`), NOT raw `email.body_html`. `grep -n "stripQuotedHistory" frontend/src/components/email/EmailMessageItem.tsx` returns **nothing** (workspace keeps the full thread → default `false`). Outbound never reaches M1 (`renderHtml` gates on `!isOutgoing`), so M2/M3 never call `stripEmailQuote`.
- **Файл:** PR grep

### TC-EQS-B03: `sanitizeEmailHtml.ts` is UNCHANGED by this feature (D4/AC-8) — no config edit, no new hook
- **Приоритет:** P0
- **Тип:** build/static (diff)
- **Связанный сценарий:** S18; AC-8; D4/FR-7/NFR-SEC-1
- **Ожидаемый результат:** `git diff frontend/src/lib/sanitizeEmailHtml.ts` for this PR is **empty** — the single DOMPurify authority is untouched; the strip is strictly downstream. The XSS pipeline is unaffected.
- **Файл:** PR diff / CI check

### TC-EQS-B04: NO new npm dependency (built-in `DOMParser`); NO migration; protected files untouched
- **Приоритет:** P0
- **Тип:** build/static (repo check)
- **Связанный сценарий:** AC-12; D6; middleware/tenancy
- **Ожидаемый результат:** `git diff frontend/package.json` shows **no** new runtime dependency (uses built-in `DOMParser`; jsdom is dev/verify-only via `NODE_PATH`, never in any `package.json`); **no** new file under `backend/db/migrations/` (max migration unchanged); protected files (`backend/src/server.js`, `frontend/src/lib/authedFetch.ts`, `frontend/src/hooks/useRealtimeEvents.ts`, DB schema) not edited; **no** backend/query/type change (`body_html` already flows from EMAIL-HTML-RENDER-001).
- **Файл:** repo check / CI

### TC-EQS-B05: TypeScript build green — `cd frontend && npm run build` (`tsc -b`, stricter prod Docker gate)
- **Приоритет:** P0
- **Тип:** build
- **Связанный сценарий:** AC-1 type/prop add; frontend-build-command lesson
- **Ожидаемый результат:** `npm run build` exits 0 with the NEW `frontend/src/lib/stripEmailQuote.ts`, the new `stripQuotedHistory` prop on `SafeEmailHtml`, and the `EmailListItem` edits — **no `noUnusedLocals`/type error** (prod Docker build is stricter than `tsc --noEmit`). Confirms the pure-fn signature `(sanitizedHtml: string): string` and the prop type compile.
- **Файл:** build / CI (+ Docker build)

---

## 12. Manual / browser (NOT the verify script — MANDATORY; the render/network/layout truths a headless check cannot assert)

Run on a **real prod-DB copy** in a real browser (`/pulse/timeline/2599` + `/email`). House lesson: don't trust headless for shadow render, live network, or jank. **Prod deploy is owner-consent-gated.**

### TC-EQS-M01: S1 — `/pulse/timeline/2599` renders ONLY the new reply; NO expand / "Show quoted text" control anywhere
- **Приоритет:** P0
- **Тип:** manual-browser
- **Связанный сценарий:** S1; AC-1; D1
- **Шаги:** load `/pulse/timeline/2599`; observe the inbound Gmail reply bubble(s) that carried `On … wrote:` + `.gmail_quote` history; inspect the shadow root.
- **Ожидаемый результат:** the bubble shows **only the new reply**; the quoted history is **absent**; there is **NO** expand / ellipsis / "Show quoted text" affordance anywhere (D1); links in the kept reply still open in a new tab (`rel="noopener noreferrer"` survives); no console error. A wall-of-history bubble is gone.

### TC-EQS-M02: S15 — the SAME 2599 message in `/email` workspace STILL shows the FULL thread (D2 regression)
- **Приоритет:** P0
- **Тип:** manual-browser
- **Связанный сценарий:** S15; AC-2; D2/NFR-COMPAT-1
- **Шаги:** open the same message in the `/email` workspace (`EmailMessageItem`).
- **Ожидаемый результат:** the workspace shows the **complete** quoted thread, **byte-for-byte identical** to before this feature (the flag is NOT passed there → `stripEmailQuote` never runs). No visual/behavioral change. This is the critical regression: timeline strips, workspace does not.

### TC-EQS-M03: S10 — all-quote email still shows content in the real UI (never a blank bubble)
- **Приоритет:** P1
- **Тип:** manual-browser
- **Связанный сценарий:** S10/S11; AC-5; D5
- **Шаги:** find (or craft on the prod copy) an inbound bare-forward / all-quote email in the timeline; load it.
- **Ожидаемый результат:** the bubble renders the **full** sanitized content (the D5 near-empty fallback fired) — **not** a blank or near-blank bubble. Confirms the fallback path in the live render, not just the string check.

### TC-EQS-M04: S17 — "Show images" reflects the KEPT reply; reveals only kept-reply images; no beacon for stripped-quote images
- **Приоритет:** P1
- **Тип:** manual-browser (devtools Network)
- **Связанный сценарий:** S16/S17; AC-10/AC-11; OQ-QS-4
- **Шаги:** on a stripped 2599 bubble whose KEPT reply has a remote image, open devtools → Network (filter Img); confirm the button appears and NO request fires until clicked; click "Show images"; confirm only the kept-reply image loads and the history stays gone. Separately, on a bubble where the remote image was ONLY in the (removed) quote, confirm the button does NOT appear.
- **Ожидаемый результат:** button visibility matches the KEPT reply (shown iff a kept-reply blockable image exists); clicking reveals only kept-reply images; the quoted history does **not** reappear on toggle; no read-beacon fires for images that were stripped away with the quote.

### TC-EQS-M05: S7/AC-9 — no scroll jank; hostile EMAIL-HTML sample still sanitizes with stripping active
- **Приоритет:** P1
- **Тип:** manual-browser (+ optional perf trace)
- **Связанный сценарий:** S7/S18; AC-9/AC-8; NFR-PERF-1
- **Шаги:** on a contact timeline with several large HTML reply threads, scroll up/down repeatedly and toggle "Show images" on one item (optionally record a Performance trace / `console.count` in `stripEmailQuote`); separately, render the EMAIL-HTML-RENDER-001 hostile sample (with a `.gmail_quote` appended) inbound with stripping active.
- **Ожидаемый результат:** no visible jank/reflow storm; the strip runs **once per (message, images-state)** (folded into the sanitize memo, dep includes the flag — not per scroll); and the hostile sample is fully neutralized (no script exec, no `on*`, no `<form>`/`<iframe>`, `javascript:`/`data:` hrefs nulled, tracking pixels not fetched) **while** the quote is stripped — exactly the parent's AC-2 posture, unchanged.

---

## 13. Sabotage negative control

### TC-EQS-SAB: replace the strip step with a pass-through → the detection matrix MUST turn RED, then restore
- **Приоритет:** P0
- **Тип:** unit-headless (self-check — mirrors `verify-email-html-render-001.js` `sab`)
- **Связанный сценарий:** harness integrity (LIST-PAGINATION-001 "a green run must certify the detector works")
- **Шаги (two prongs):**
  1. **Config sabotage (always runs in `sab`):** run the `detect` assertions (TC-EQS-D01…D04) against a variant where `stripEmailQuote` is `html => html` (pass-through, no detection/removal). Confirm the harness **records FAIL** on the Gmail/Apple/Yahoo/Outlook cases (the `.gmail_quote`/`blockquote[type="cite"]`/`.yahoo_quoted`/`#appendonsend` survives; the reply-only assertion fails because the quote text is still present). Then restore the real port → assert green.
  2. **Code sabotage (documented, run manually in the deploy window):** temporarily neuter one detector in `stripEmailQuote.ts` (e.g. drop the `.gmail_quote` selector, or bypass the removal), re-run `--section=detect` → the matrix **MUST turn red** for that client. Restore → green.
- **Ожидаемый результат:** prong 1 trips FAILs on all four client cases then restores green in one run; prong 2 shows red-on-removal / green-on-restore. If either does NOT trip a FAIL, the detector is broken and every PASS above is vacuous. This is what makes a green run trustworthy for AC-1/AC-3.
- **Файл:** `scripts/verify-email-quote-strip-001.js` (`sab`) + a one-line PR note for the manual prong.

### TC-EQS-P01: PARITY — the CJS port mirrors the shipped `stripEmailQuote.ts` on the load-bearing bits; dropping a selector FAILs parity
- **Приоритет:** P0
- **Тип:** build/static (self-check — mirrors the parent's `runParity()`)
- **Связанный сценарий:** harness integrity (vehicle §Port + parity)
- **Шаги / Ожидаемый результат:** `parity` `fs.readFileSync`s `frontend/src/lib/stripEmailQuote.ts` and `check(...)`s that the source still contains: the ordered selector literals (`'.gmail_quote'`, `'blockquote[type="cite"]'`, `'#appendonsend'`, `'.yahoo_quoted'`, a top-level `blockquote` scan), the attribution regex family (`/^\s*On\s.+\swrote:\s*$/`, `/^\s*On\s.+$/`, `/wrote:\s*$/`), the near-empty rule (`< 2` threshold + the `img[src|data-blanc-src]`/`table`/`picture` media guard + the zero-width set `​‌‍﻿`), the over-strip guard wording, and the fail-safe (`try`…`catch`…`return sanitizedHtml`). **Sabotage self-test:** dropping any one of these from the `.ts` source (e.g. removing the `.gmail_quote` selector) MUST make `parity` FAIL — proving the guard is load-bearing and the headless matrix can never certify a transform that differs from what ships. *(If the Implementer wires a TS/ESM loader so the script imports the real `.ts`, this case asserts THAT import resolves to the real module — pick one.)*
- **Файл:** `scripts/verify-email-quote-strip-001.js` (`parity`) + PR check

---

## Regression / Protected (must stay green)

- **TC-R-1 (P0):** **`/email` workspace shows the FULL thread** — `EmailMessageItem` does NOT pass `stripQuotedHistory` → `SafeEmailHtml` default `false` → the sanitized string is returned unchanged (no strip). Byte-for-byte identical to pre-feature (TC-EQS-M02, TC-EQS-B02). The strip is timeline-only (D2).
- **TC-R-2 (P0):** **`sanitizeEmailHtml.ts` untouched** — the single DOMPurify authority is unchanged (empty diff, TC-EQS-B03); the strip runs strictly downstream on already-sanitized output; the XSS pipeline (EMAIL-HTML-RENDER-001 AC-2) is preserved with stripping active (TC-EQS-X01/X02, TC-EQS-M05). **Security regression = P0.**
- **TC-R-3 (P0):** **Fail-safe never blanks/crashes the timeline** — a forced strip failure returns the FULL sanitized input (never `''`, never raw, never a throw); other bubbles unaffected (TC-EQS-F01). A near-empty candidate returns FULL rather than a blank bubble (TC-EQS-N01/N02).
- **TC-R-4 (P1):** **Outbound + inbound-plain-text paths untouched** — neither reaches M1 (`renderHtml` gates on `!isOutgoing && body_html`); both render `linkifyToHtml(body_text)` (already only-new via `toTimelineBody`); `stripEmailQuote` is **never** invoked for M2/M3 (TC-EQS-B02, TC-EQS-M05). Scope guard (S20/FR-12).
- **TC-R-5 (P1):** **Existing chrome + probe mechanics untouched** — `EmailListItem`'s eyebrow/subject/timestamp, the `max-w-[75%]` bubble cage, and the "Show images" button mechanics are unchanged; only the M1 body is stripped and the probe input is repointed (TC-EQS-B02, TC-EQS-M01). `hasBody`/M4 empty-guard preserved.
- **TC-R-6 (P0):** **No new tenancy/middleware surface; no new dep/migration** — no new route/param/query/type; `body_html` already company+contact-scoped via the EMAIL-HTML-RENDER-001 timeline read (`authenticate`+`requireCompanyAccess`), so there is **no new 401/403/cross-tenant case** (asserted "unchanged"); no new npm package (built-in `DOMParser`; jsdom dev/verify-only via `NODE_PATH`); no migration; protected files untouched (TC-EQS-B04).

## Notes for the Implementer / Tester

- **Vehicle, restated so nobody re-invents it:** there is **no frontend test runner and no jsdom-jest env installed** (verified), and `stripEmailQuote.ts` is TS-ESM (can't be `require`d). This feature's **entire automated coverage = ONE script, `scripts/verify-email-quote-strip-001.js`** (Node + a **dev-only `jsdom` reused from the scratchpad via `NODE_PATH=<scratchpad>/node_modules`**, `jsdom@29.1.1` already present) running a **CJS port** of `stripEmailQuote` + a **PARITY guard** (reads the `.ts`) + a **SABOTAGE** section. **There is NO backend in this feature, so NO backend jest is needed.** Do **not** add `@jest-environment jsdom` (env absent) and do **not** add jsdom/vitest to any `package.json` (that would be a shipped dep — AC-12 forbids it).
- **`DOMParser` injection is load-bearing:** `stripEmailQuote` calls `new DOMParser()` — which is **not** a Node global. The script MUST `global.DOMParser = new JSDOM('').window.DOMParser` (or pass the constructor into the port) before exercising it. The scratchpad probe confirms jsdom's `DOMParser` parses `.gmail_quote` and serializes via `document.body.innerHTML`.
- **PARITY (TC-EQS-P01) is what stops silent drift:** because the port isn't the shipped `.ts`, the parity guard asserts the ordered selectors, the attribution regex family (mirroring `emailTimelineBody.js` l.36–40), the `<2`+media near-empty rule (with the zero-width set), the guard wording, and the fail-safe are all still present in the source. Dropping any one from the `.ts` MUST FAIL parity.
- **SABOTAGE (TC-EQS-SAB) is what makes green trustworthy:** if `html=>html` pass-through does NOT turn the `detect` matrix red on the four client cases, the matrix isn't asserting anything. Keep it in `--section=sab` and run it every time.
- **The bias is UNDER-strip over OVER-strip.** The negative cases (TC-EQS-G01 mid-body KEPT, TC-EQS-A02 bare-`wrote:` no-cut, TC-EQS-A05 non-attribution sibling kept, TC-EQS-D06 stray border-top no-cut) are as load-bearing as the positive strips — losing the new reply is the only truly harmful failure.
- **What a green run does NOT prove** (must be eyeballed manually on a prod-copy before ship): the shadow-DOM render of the stripped 2599 reply (M01), the `/email` workspace still shows the full thread (M02), the all-quote fallback isn't a blank bubble in the real UI (M03), the probe/beacon behavior (M04), and no scroll jank (M05). Green matrix + green manual on 2599 = ship bar. **Prod deploy is owner-consent-gated.**
