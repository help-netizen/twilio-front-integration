# Тест-кейсы: EMAIL-HTML-RENDER-001 — render inbound email bodies in the Pulse timeline as sanitized, style-isolated HTML (shared sanitizer; outbound & no-HTML fall back to escape-then-linkify)

**Source spec:** `Docs/specs/EMAIL-HTML-RENDER-001.md` (scenarios S1–S12, the Security strip matrix, the shadow base sheet, render matrix M1–M5, AC-1…AC-10) + `Docs/requirements.md` §EMAIL-HTML-RENDER-001 (D1–D6, FR-1…FR-10, NFR-SEC-1…6/NFR-PERF-1/2/NFR-A11Y-1/NFR-COMPAT-1) + `Docs/architecture.md` §EMAIL-HTML-RENDER-001 (OQ-1/2/3 + OQ-HR-A/B/C).

**Design under test (change points confirmed against the current worktree):**
- **NEW `frontend/src/lib/sanitizeEmailHtml.ts`** — `sanitizeEmailHtml(html, { allowImages }): string`: one app-wide DOMPurify config (strip `<script>`/`on*`/`<form>`+controls/`<iframe>`) + an `afterSanitizeAttributes` hook that (a) forces every surviving `<a>`→`target="_blank" rel="noopener noreferrer"`, (b) nulls link `href` matching `^\s*(javascript|data):`i, (c) when `!allowImages` moves remote/protocol-relative/`cid:` `<img src>`→`data-blanc-src` + strips `srcset` + inline `background`/`background-image:url()`; `data:` image `src` left intact. try/catch → returns `''` on any throw. Hooks add/remove around the call (no global DOMPurify leak).
- **NEW `frontend/src/lib/linkifyText.ts`** — `linkifyToHtml(text): string`: **escape `& < > " '` FIRST**, THEN regex-wrap URL / `www.` / email / phone into `<a target="_blank" rel="noopener noreferrer" href=…>` (`mailto:`/`tel:`), preserving `\n`. Pure `string→string`, no dependency.
- **NEW `frontend/src/components/email/SafeEmailHtml.tsx`** — host `<div>` (`max-width:100%; overflow-x:auto`) + **open** shadow root attached once + 8-declaration base `<style>` injected once + `shadowRoot.innerHTML = sanitizeEmailHtml(html,{allowImages})`. `useMemo` on key `(messageId ?? hash(html), allowImages)`; controlled/dumb (caller owns `allowImages` + the "Show images" button); `''`→empty shadow.
- **CHANGE `frontend/src/components/pulse/EmailListItem.tsx`** — render matrix M1 (inbound+html→`SafeEmailHtml`+"Show images"), M2 (inbound no-html→`linkifyToHtml(body_text)`), M3 (outbound→`linkifyToHtml` always), M4 (empty→nothing), M5 (inbound+html but sanitize→`''`→fall through to linkify).
- **CHANGE `frontend/src/components/email/EmailMessageItem.tsx`** — `/email` workspace adopts `SafeEmailHtml` (was `DOMPurify.sanitize(body_html)` at l.87–92, a **second** config that must be removed — AC-6); `<pre>` `body_text` fallback + attachments kept.
- **CHANGE `frontend/src/types/pulse.ts`** — `EmailTimelineItem` (l.39–52) gains `body_html: string | null` (additive).
- **CHANGE (BE, NO migration)** — `body_html` added to the timeline email projection: `emailQueries.getTimelineEmailByContact` **SELECT (l.594–597)** (currently lists `…subject, body_text, snippet, gmail_internal_at, sent_by_user_email` — **`body_html` is NOT there yet**; `WHERE company_id=$1 AND contact_id=$2 AND on_timeline=true` unchanged); `pulse.js` mapping (l.314, add `body_html: row.body_html` beside the existing `body_text: toTimelineBody(...)`); `emailTimelineService.toEmailItem` (l.70 region, add `body_html: row.body_html || null` — SSE-parity only, NOT required for AC-1). The `body_text ILIKE` search (emailQueries l.152–165) is **untouched**.
- **CHANGE (deps)** — `frontend/package.json` gains explicit `"dompurify": "3.2.7"` (OQ-HR-C; already in `frontend/package-lock.json` l.7773, so "no new package" — closes an `npm ci`/hoist-drop gap). `@types/dompurify` only if `tsc -b` demands it.

---

## ⚠️ TEST VEHICLE — READ FIRST (the prescription is unmistakable; do NOT assume a runner that isn't installed)

**Investigated, verified in this worktree (2026-07-06):**

| Fact | Evidence | Consequence |
|------|----------|-------------|
| **Frontend has NO unit-test runner** | `frontend/package.json` scripts = `dev/build/lint/preview` only; **0** `*.test.*` under `frontend/src`; no `jest`/`vitest`/`@testing-library` in devDeps (memory "frontend has NO test harness" — **VERIFIED true**) | There is nowhere to run a frontend unit test today. |
| **`jsdom` / `jest-environment-jsdom` / `vitest` / `happy-dom` are ABSENT everywhere** | not in root `node_modules`, not in `frontend/node_modules`, **0 hits** in `frontend/package-lock.json` (not even transitively) | A `@jest-environment jsdom` docblock **cannot** run — the env package isn't installed. Installing it = a new package (spec forbids adding shipped deps). |
| **Root jest = NODE env**, jest `^30.2.0`, `testPathIgnorePatterns` already ignores `/node_modules/` **and** `/\.claude/worktrees/` | root `package.json` `jest` block | The root jest cannot give `sanitizeEmailHtml`/`SafeEmailHtml` a DOM. **Worktree gotcha:** its config already skips `/\.claude/worktrees/`, so a test file placed **inside this worktree** is silently NOT collected — run new jest from the **real repo root**, or override `--rootDir`/`--testPathIgnorePatterns` deliberately (superset of the JOBS-UX-RBAC-001 lesson). |
| **`dompurify` is NOT installed** (root or frontend `node_modules`) — only in the frontend lockfile | `ls node_modules/dompurify` → absent both places; lockfile l.7773 | Any DOM harness must first `npm i` dompurify (the Implementer's OQ-HR-C add covers the frontend tree; a script under repo root needs it in root deps or an explicit path). |
| **Frontend targets are TS-ESM; verify scripts are CommonJS `require`** | `sanitizeEmailHtml.ts`/`linkifyText.ts` are NEW `.ts`; the 8 `scripts/verify-*.js` all `require(...)` **backend CJS** modules; **no** `ts-node`/`tsx`/`esbuild`/`sucrase`/`@swc/register` installed | A node verify script **cannot `require()`** the TS sanitizer as-is — it needs a TS/ESM transpile hook. |
| **Backend is CJS and the mapping targets exist** | `getTimelineEmailByContact` @ l.586 (SELECT l.594), `pulse.js` mapping @ l.314, `toEmailItem` @ l.54/70, `EmailTimelineItem` @ l.39 | The **backend** cases run in the existing **node-env root jest** with zero new deps. |

### Vehicle decision — per test group (each explicitly justified by the above)

- **Group A — `sanitizeEmailHtml` (DOMPurify → needs a DOM) + `SafeEmailHtml` shadow wiring:**
  **Vehicle = a NEW standalone Node verify script `scripts/verify-email-html-render-001.js`** (house pattern of `scripts/verify-contact-email-merge-001.js`: `#!/usr/bin/env node`, `'use strict'`, `--section=<id>|all`, tiny `check/eq/record`+`CheckError` kit copied verbatim, exit 0 only when no case FAILs). It constructs a **jsdom** `window`, hands it to **DOMPurify** (`createDOMPurify(window)` — DOMPurify's own supported headless pattern), and runs the **hostile-HTML security matrix headless**. This is the ONLY vehicle that actually works given installed deps: jest-node has no DOM, jsdom-jest env isn't installed, and vitest isn't installed.
  - **Dep requirement (state loudly in the PR):** the script needs `jsdom` **and** `dompurify` available to Node. Two honest options — the Planner/Implementer picks ONE and the PR says which:
    1. **Port-under-test (PREFERRED, zero shipped-dep drift):** `scripts/verify-email-html-render-001.js` imports the **frontend** `dompurify` (the OQ-HR-C add) via `require(path.join(ROOT,'frontend/node_modules/dompurify'))` and adds **`jsdom` as a root `devDependency`** (dev/verify-only — it is NEVER bundled into the app, so it does **not** violate the spec's "no new *frontend* package / no new shipped dep" rule; call this out explicitly). Because the TS sanitizer can't be `require`d, the script contains a **verbatim CommonJS port of the `sanitizeEmailHtml` config+hook** (the same config string the `.ts` exports) and a **build-time assertion (Group C, TC-EHR-B03)** that the ported config === the shipped `.ts` config, so the port can't silently drift. *(This mirrors how `verify-*.js` scripts re-exercise real logic at the service boundary; here the "boundary" is the pure sanitizer config, re-hosted on jsdom.)*
    2. **If the owner refuses even a dev-only `jsdom`:** fall back to **manual browser verification** for the whole security matrix on `/pulse/timeline/3044` + a crafted hostile fixture (Group D), and keep only the pure-string checks automated. This is strictly weaker (a human must eyeball each strip) and is the fallback, not the plan.
  - **Do NOT** prescribe `@jest-environment jsdom` — `jest-environment-jsdom` is not installed and the root jest also excludes this worktree path.

- **Group B — `linkifyToHtml` (pure `string→string`, NO DOM):**
  **Vehicle = the SAME `scripts/verify-email-html-render-001.js`, section `linkify`** (no DOM needed — plain string assertions), OR equivalently the root **node-env jest** if the pure fn is exercised via a tiny CJS port. Since `linkifyText.ts` is also TS-ESM (can't be `require`d), the script uses the **verbatim CJS port** of the escape-then-wrap logic with the same **config-parity assertion** (TC-EHR-B03) so the automated check and the shipped `.ts` stay in lockstep. `linkify` needs no jsdom → it runs even under fallback option 2.

- **Group C — backend read/type/mapping + build gates:**
  **Vehicle = the existing node-env root jest** (`tests/…`, zero new deps) for the mapping/shape/scoping unit assertions, **plus** `[build]` static checks (`cd frontend && npm run build` = `tsc -b && vite build`; the **prod Docker build is the real tsc gate**, stricter — `noUnusedLocals`), a `package.json` dep-diff check, and a no-new-migration repo check. Backend mapping cases run in jest because the backend is CJS and needs no DOM.

- **Group D — render fidelity / shadow isolation / network suppression / layout / no-jank / workspace parity:**
  **Vehicle = MANUAL browser verification** on a **real prod-DB copy** at `/pulse/timeline/3044` + `/email` (house lesson: never trust mocked/headless render for shadow-DOM layout, live network beacons, or scroll jank). Called out explicitly as manual below; **not** jest.

> **House lesson (LIST-PAGINATION-001 / created_by-FK / PULSE-PERF-001, BINDING):** a headless matrix proves the sanitizer's *string output* (what tag/attr survives) but **cannot** prove shadow-DOM two-way style isolation, that a remote `<img>` truly fires **no network beacon** until "Show images", or that a ~39 KB email doesn't jank the timeline. Those are **Group D manual**. Ship only when Group A (headless matrix + sabotage) is green **and** Group D was eyeballed on a prod-copy in a real browser. **Prod deploy is owner-consent-gated.**

---

## Scenario map (spec S-id / AC → coverage)

| S / AC | Meaning | Priority | Vehicle & where PROVEN |
|--------|---------|----------|------------------------|
| **S5 / AC-2** | Hostile HTML neutralized (the security matrix) — assert EXACTLY what remains | **P0** | **headless script** (`security` section) — the core |
| **S3 / AC-5** | no-HTML inbound → escape-then-linkify (URL/email/phone), no injection, no new dep | **P0** | **headless script** (`linkify`) + `[build]` dep-diff |
| **S1 / AC-1** | inbound Google-LSA HTML renders formatted, links/buttons clickable, new-tab | **P0** | **manual** (render fidelity) + headless (anchors preserved + forced target/rel) |
| **S4 / AC-1** | outbound → linkify even if `body_html` present (sanitize never called) | **P0** | unit (M3 branch never calls sanitize) + manual (side-by-side) |
| **S2 / AC-4** | remote images blocked by default → "Show images" reveals; `data:` allowed | **P0** | headless (`src`→`data-blanc-src` / toggle) + **manual** (no beacon in devtools) |
| **S6 / AC-3** | style isolation both directions (email `<style>`/classes vs app CSS) | **P0** | **manual** (shadow isolation — DOM/runtime) |
| **S7 / AC-3, AC-9** | ~39 KB + wide table: no jank, horizontal scroll inside the bubble, no `max-height`/expand | **P0** | **manual** (layout + no-jank) + unit (memo key) |
| **S8 / AC-10** | sanitizer throw → `''` → fall-safe to linkify, no crash, no raw HTML | **P0** | headless (throw→`''`) + unit (M5 fall-through) + manual |
| **S9 / AC-8** | multi-tenant: `body_html` only via the company+contact-scoped read (leak = P0) | **P0** | unit (WHERE unchanged) + `[build]` |
| **S10 / AC-6** | `/email` workspace parity after adopting `SafeEmailHtml`; exactly ONE DOMPurify config | **P1** | `[build]`/grep (one config) + **manual** (benign render) |
| **S11** | empty body (no html AND no text) → nothing rendered, chrome stays | P2 | manual + unit (M4 guard) |
| **S12 / AC-7** | backend payload parity for a future SSE append (`toEmailItem`) | P2 | unit (mapping shape) |
| **AC-9 (memo)** | sanitize memoized per `(messageId, allowImages)` — not per scroll/re-render | **P1** | unit (memo-key call-count) + manual (no jank) |
| **AC-7 (BE read/type/search)** | timeline item carries `body_html`; `body_text` + `ILIKE` search intact; NO migration | **P0** | unit (SELECT/mapping/type) + repo no-migration check |

**The P0 gates that MUST be green before ship:** the **headless security matrix** (`security` — proves each hostile payload is stripped/neutralized), its **sabotage negative-control** (remove the sanitize call → matrix goes RED, TC-EHR-SAB), **linkify escape-first** (no injection via crafted `body_text`), the **backend company+contact scoping unchanged** (S9/AC-8 leak = P0), and the **manual browser pass** on 3044 for shadow isolation + no-beacon + no-jank (AC-1/AC-3/AC-4 — headless cannot assert these).

---

## Покрытие / Coverage

- Всего тест-кейсов: **41** (numbered TC-EHR-*) + **6** regression/protected = **47**.
- **Numbered by priority — P0: 27 | P1: 10 | P2: 4.**
- **By type — headless-script (Node+jsdom, `scripts/verify-email-html-render-001.js`): 22 (H01–H21 security/images/links/failsafe/linkify + SAB) | unit-node (root jest, backend + extracted-branch helpers): 6 | build/static: 5 | manual-browser: 8.** (Several headless cases are parametrized, so raw assertion count is higher.)
- Every spec scenario **S1–S12** covered; positive + negative per scenario. **Fail-safe** (sanitize→`''`) covered headless (TC-EHR-H14) + unit (M5, TC-EHR-U04) + manual (TC-EHR-M06). **Multi-tenant** = backend WHERE-unchanged unit (TC-EHR-U01) — the `body_html` add introduces **no new route/param/middleware**, so there is no new 401/403 surface (the timeline read keeps `authenticate`+`requireCompanyAccess`+`pulse.view`; asserted as "unchanged"). **Sabotage negative control** = TC-EHR-SAB. **Build gate** = TC-EHR-B01…B05.

**headless-vs-manual split at a glance (explicit, per the constraint):**
- **Headless script (Node+jsdom) — sufficient because the assertion is sanitizer *string output* / DSL, not live-DOM/network/layout truth:** the whole **security strip matrix** (`<script>`/`on*`/`<form>`/`<iframe>`/`javascript:`/`data:` link/ remote `<img>`/protocol-relative/`cid:`/`data:` image / `<style>` retained), **every surviving `<a>` has target+rel**, the **image toggle** output diff (`data-blanc-src`↔`src`), the **fail-safe** throw→`''`; and the **linkify** contract (escape-first, URL/email/phone wrap, line-breaks, no-injection, anchor target/rel).
- **Manual browser (NOT headless) — MANDATORY because a headless string check cannot see runtime/DOM/network:** shadow-DOM **two-way style isolation** (S6), **remote-image network truly suppressed** until "Show images" (devtools Network — S2), **inline no-`max-height` + wide-table horizontal scroll contained in the bubble** (S7), **no scroll jank** on a long timeline of ~39 KB emails (S7/AC-9), **render fidelity** of the 3044 mail (S1), `/email` **workspace parity** after the refactor (S10), and `tsc -b`/`npm run build` visual confirmation.

---

## Shared harness (headless section)

House pattern of `scripts/verify-contact-email-merge-001.js` — but **no DB and no mocks of app logic**; the "unit under test" is the **pure sanitizer/linkify config**, re-hosted on jsdom (NOT a network/DB test):

- **Script:** `scripts/verify-email-html-render-001.js`, sections `security` / `images` / `links` / `failsafe` / `linkify` / `sab`, selectable via `--section=<id>|all`. Exit code 0 only when **no case FAILs**. Reuse the tiny assert kit (`check`/`eq`/`record`, `CheckError`) verbatim.
- **DOM:** `const { JSDOM } = require('jsdom'); const { window } = new JSDOM(''); const DOMPurify = require(path.join(ROOT,'frontend/node_modules/dompurify'))(window);` — DOMPurify's supported headless factory form. (If the Implementer chooses to import the compiled sanitizer instead of the CJS port, add a TS/ESM loader; absent one today, the **CJS port + parity assertion (TC-EHR-B03)** is the working default.)
- **Port + parity:** the script holds a **verbatim CommonJS port** of the `sanitizeEmailHtml` config object + `afterSanitizeAttributes` hook and of `linkifyToHtml`. **TC-EHR-B03** (build/static) asserts the ported config literal is **character-identical** to the one exported from `frontend/src/lib/sanitizeEmailHtml.ts` (a `grep`/normalized-string compare in the PR), so the headless matrix can never certify a config that differs from what ships.
- **Fixtures:** a single `HOSTILE` HTML blob containing every strip-matrix row (below) + a `BARE` `<p>Hello <a href="https://x.io">link</a></p>` + the real ~39 KB 3044 blob (checked in under `scripts/fixtures/email-html-render/lsa-3044.html`, sanitized of any real PII) for the size/normalization case.
- **Assertions are structural, not brittle-string:** parse the sanitized output back into a jsdom fragment and assert via `querySelectorAll` (`fragment.querySelector('script') === null`, `img.getAttribute('src')` null while `data-blanc-src` set, `a.getAttribute('rel') === 'noopener noreferrer'`), so DOMPurify serialization quirks (attribute order, quoting) don't cause false FAILs.
- **Sabotage (section `sab`):** run the `security` assertions against a variant where the sanitize step is a **pass-through** (`html=>html`) and confirm the harness **throws `CheckError` / records FAIL** on every neutralize assertion; then restore. This proves the matrix is load-bearing (a removed sanitize call turns it red — the exact "green suite that proves nothing" failure mode).

---

## 1. Headless script — `scripts/verify-email-html-render-001.js` (Node + jsdom; the security core)

> **Why this section is non-negotiable:** the frontend has no runner and no jsdom-jest env; this script is the ONLY automated proof that each hostile payload is neutralized. A green run here + a green Group D manual pass is the ship bar for AC-2/AC-4/AC-5/AC-10.

### TC-EHR-H01: `<script>alert(1)</script>` → node removed, no execution
- **Приоритет:** P0
- **Тип:** headless (Node+jsdom)
- **Связанный сценарий:** S5; AC-2; NFR-SEC-2; strip-matrix row 1
- **Вход:** `sanitizeEmailHtml('<div>a<script>alert(1)</script>b</div>', {allowImages:false})`.
- **Ожидаемый результат:** parsed output has **no `<script>` element** (`fragment.querySelector('script') === null`) and the text `a…b` survives. No `alert` ever defined (DOMPurify default strip).
- **Файл:** `scripts/verify-email-html-render-001.js` (`security`)

### TC-EHR-H02: `<img src=x onerror="alert(1)">` → `onerror` stripped; `<img>` kept but `src` neutralized
- **Приоритет:** P0
- **Тип:** headless
- **Связанный сценарий:** S5; AC-2, AC-4; strip-matrix row 2; FR-5
- **Вход:** `sanitizeEmailHtml('<img src="x" onerror="alert(1)">', {allowImages:false})`.
- **Ожидаемый результат:** the `<img>` remains **but** `getAttribute('onerror') === null`, `getAttribute('src') === null` (moved), `getAttribute('data-blanc-src')` holds the neutralized `x`. No handler survives. (With `{allowImages:true}` the `onerror` is STILL stripped — negative sub-assert.)
- **Файл:** `scripts/verify-email-html-render-001.js` (`security`)

### TC-EHR-H03: any `on*=` inline handler (`onclick`, `onmouseover`, `onload`) → attribute stripped
- **Приоритет:** P0
- **Тип:** headless (parametrized)
- **Связанный сценарий:** S5; AC-2; NFR-SEC-2; strip-matrix row 3
- **Вход:** `<div onclick="x()">c</div>`, `<a href="https://x.io" onmouseover="x()">l</a>`, `<body onload="x()">`.
- **Ожидаемый результат:** every `on*` attribute is **absent** on the surviving node; the element/text otherwise survives; the `<a>` still gets forced `target`/`rel` (cross-check with TC-EHR-H10).
- **Файл:** `scripts/verify-email-html-render-001.js` (`security`)

### TC-EHR-H04: `<form>` + `<input>` + submit-`<button>` (phishing form) → all removed
- **Приоритет:** P0
- **Тип:** headless
- **Связанный сценарий:** S5; AC-2; US-5; strip-matrix row 4
- **Вход:** `<form action="https://evil"><input name="pw"><button type="submit">Login</button></form>`.
- **Ожидаемый результат:** `querySelector('form') === null`, `querySelector('input') === null`, no submit `<button>`; no credential-capture surface remains. (A non-submit textual `<button>` inside body content — DOMPurify default keeps `<button>` unless configured; assert the shipped config's actual behavior: per spec "form controls" are stripped → assert `button[type=submit]`/`input`/`select`/`textarea` gone.)
- **Файл:** `scripts/verify-email-html-render-001.js` (`security`)

### TC-EHR-H05: `<iframe src="…">` → removed
- **Приоритет:** P0
- **Тип:** headless
- **Связанный сценарий:** S5; AC-2; strip-matrix row 5
- **Вход:** `<iframe src="https://evil"></iframe><p>ok</p>`.
- **Ожидаемый результат:** `querySelector('iframe') === null`; the `<p>ok</p>` survives.
- **Файл:** `scripts/verify-email-html-render-001.js` (`security`)

### TC-EHR-H06: `<a href="javascript:alert(1)">` → href nulled/dropped (anchor may remain inert)
- **Приоритет:** P0
- **Тип:** headless
- **Связанный сценарий:** S5; AC-2; FR-3, NFR-SEC-3; strip-matrix row 6
- **Вход:** `sanitizeEmailHtml('<a href="javascript:alert(1)">x</a>', {…})`.
- **Ожидаемый результат:** the surviving `<a>` has **no `javascript:` href** (`getAttribute('href')` is null/empty/`about:blank` per DOMPurify+the explicit block); if it remains it STILL carries `target="_blank" rel="noopener noreferrer"`. No scheme-based execution path.
- **Файл:** `scripts/verify-email-html-render-001.js` (`links`)

### TC-EHR-H07: `<a href="data:text/html,<script>…">` → href nulled (`data:` blocked on LINKS)
- **Приоритет:** P0
- **Тип:** headless
- **Связанный сценарий:** S5; AC-2; FR-3; strip-matrix row 7
- **Вход:** `<a href="data:text/html,<script>alert(1)</script>">x</a>`.
- **Ожидаемый результат:** `getAttribute('href')` does **not** start with `data:` (nulled by the `^\s*(javascript|data):`i hook). This is the load-bearing distinction vs. TC-EHR-H09 (`data:` allowed on **images**).
- **Файл:** `scripts/verify-email-html-render-001.js` (`links`)

### TC-EHR-H08: remote tracking-pixel `<img src="https://track…/pixel.gif">` → `src`→`data-blanc-src`, `srcset` stripped, no fetch
- **Приоритет:** P0
- **Тип:** headless
- **Связанный сценарий:** S2, S5; AC-2, AC-4; D3/FR-5, NFR-SEC-4; strip-matrix row 8
- **Вход:** `sanitizeEmailHtml('<img src="https://track.example/pixel.gif" srcset="https://track.example/2x.gif 2x">', {allowImages:false})`.
- **Ожидаемый результат:** `getAttribute('src') === null`, `getAttribute('data-blanc-src') === 'https://track.example/pixel.gif'`, `getAttribute('srcset') === null`. (Headless proves the **string** has no live `src`; that **no network beacon fires** is the manual TC-EHR-M03 — a string check cannot observe the network.)
- **Файл:** `scripts/verify-email-html-render-001.js` (`images`)

### TC-EHR-H09: `<img src="data:image/png;base64,…">` → kept, `src` intact (self-contained, no beacon)
- **Приоритет:** P0
- **Тип:** headless
- **Связанный сценарий:** S2, S5; AC-4; OQ-1; strip-matrix row 9
- **Вход:** `sanitizeEmailHtml('<img src="data:image/png;base64,iVBORw0KGgo=">', {allowImages:false})`.
- **Ожидаемый результат:** `getAttribute('src')` **still** equals the `data:` URI; **no** `data-blanc-src` moved. A `data:` image renders even with images "off" (no remote beacon). Contrast with TC-EHR-H08.
- **Файл:** `scripts/verify-email-html-render-001.js` (`images`)

### TC-EHR-H10: every surviving `<a href="https://…">` → forced `target="_blank" rel="noopener noreferrer"`
- **Приоритет:** P0
- **Тип:** headless
- **Связанный сценарий:** S1, S5; AC-1, AC-2; NFR-SEC-3; strip-matrix row 11
- **Вход:** `<a href="https://ok.io">a</a><a href="https://ok.io" target="_self" rel="opener">b</a>`.
- **Ожидаемый результат:** **both** anchors end with `target="_blank"` and `rel="noopener noreferrer"` — the hook **overwrites** a pre-existing `target="_self"`/`rel="opener"` (not merely fills a blank). `mailto:`/`tel:`/protocol-relative anchors survive and also get target/rel.
- **Файл:** `scripts/verify-email-html-render-001.js` (`links`)

### TC-EHR-H11: protocol-relative image `//evil/x.png` → treated as remote → neutralized when `!allowImages`
- **Приоритет:** P1
- **Тип:** headless
- **Связанный сценарий:** S5; FR-5; strip-matrix row (protocol-relative)
- **Вход:** `sanitizeEmailHtml('<img src="//evil/x.png">', {allowImages:false})`.
- **Ожидаемый результат:** `src` moved to `data-blanc-src` (the `//` form is caught alongside `http(s)`); with `{allowImages:true}` the `//evil/x.png` `src` survives (loads).
- **Файл:** `scripts/verify-email-html-render-001.js` (`images`)

### TC-EHR-H12: `cid:` inline-attachment image `<img src="cid:abc">` → moved off `src` (hidden, no broken/remote fetch)
- **Приоритет:** P1
- **Тип:** headless
- **Связанный сценарий:** S5; OQ-1; strip-matrix row 10
- **Вход:** `sanitizeEmailHtml('<img src="cid:abc123">', {allowImages:false})` AND `{allowImages:true}`.
- **Ожидаемый результат:** in **both** image states `getAttribute('src')` is **not** `cid:abc123` (moved to `data-blanc-src` — no attachment plumbing on the timeline, so it must never emit a broken/looks-remote fetch even after "Show images"). Distinct from remote (TC-EHR-H08) which DOES restore on toggle.
- **Файл:** `scripts/verify-email-html-render-001.js` (`images`)

### TC-EHR-H13: `<style>body{background:#000}</style>` + class rules → **retained** in the output (shadow-scoping happens at render, not sanitize)
- **Приоритет:** P1
- **Тип:** headless
- **Связанный сценарий:** S6; AC-3; strip-matrix row 12
- **Вход:** `sanitizeEmailHtml('<style>.card{color:red}</style><div class="card">x</div>', {…})`.
- **Ожидаемый результат:** the `<style>` node and the `class="card"` are **kept** in the sanitized string (DOMPurify does not strip `<style>`; isolation is the shadow root's job, TC-EHR-M02). This documents that the string still carries author CSS — the security control does **not** rely on removing `<style>`.
- **Файл:** `scripts/verify-email-html-render-001.js` (`security`)

### TC-EHR-H14: `sanitizeEmailHtml` throw → returns `''` (never raw HTML, never a throw)
- **Приоритет:** P0
- **Тип:** headless
- **Связанный сценарий:** S8; AC-10; NFR-SEC-6
- **Вход:** force a throw inside the sanitize body (e.g. monkeypatch the DOMPurify instance's `sanitize` to throw, or pass an input the hook is stubbed to choke on).
- **Ожидаемый результат:** returns **`''`** (empty string sentinel) — **not** the raw input, **not** a partial, no exception escapes. (Caller-side fall-through to linkify is the unit TC-EHR-U04 / manual TC-EHR-M06.)
- **Файл:** `scripts/verify-email-html-render-001.js` (`failsafe`)

### TC-EHR-H15: empty / whitespace / `null`-ish input → `''` (no crash)
- **Приоритет:** P2
- **Тип:** headless
- **Связанный сценарий:** S11 (empty body); Contract 1 "empty input → `''`"
- **Вход:** `''`, `'   '`, `undefined` (cast), `'<!-- only a comment -->'`.
- **Ожидаемый результат:** returns `''` (or an empty/whitespace string) with no throw; the caller renders nothing for the body.
- **Файл:** `scripts/verify-email-html-render-001.js` (`failsafe`)

### TC-EHR-H16: **global-leak guard** — a plain `DOMPurify.sanitize(x)` call BEFORE/AFTER an email sanitize is unaffected by the email config/hooks
- **Приоритет:** P1
- **Тип:** headless
- **Связанный сценарий:** Contract 1 "config MUST NOT leak globally"; §"Global-leak guard"; AC-6
- **Вход:** on the SAME DOMPurify instance: (1) call `sanitizeEmailHtml('<a href="https://x.io">l</a>')`; (2) then a bare `DOMPurify.sanitize('<a href="https://x.io">l</a>')` (no email config).
- **Ожидаемый результат:** the bare call in step 2 does **NOT** carry the forced `target="_blank" rel="noopener noreferrer"` nor the image-neutralize (i.e. the `afterSanitizeAttributes` hook was **removed** after the email call). Proves the hooks are add/removed around the call and don't poison other app callers.
- **Файл:** `scripts/verify-email-html-render-001.js` (`security`)

---

## 2. Headless script — `linkify` section (pure string; no DOM needed)

### TC-EHR-H17: `linkifyToHtml` escapes `& < > " '` FIRST → no HTML injection from crafted `body_text`
- **Приоритет:** **P0**
- **Тип:** headless (pure string)
- **Связанный сценарий:** S3, S5 (plain-text safety note); AC-5; FR-6
- **Вход:** `linkifyToHtml('<img src=x onerror="alert(1)"> & <script>alert(2)</script> "q" \'p\'')`.
- **Ожидаемый результат:** the output contains **`&lt;img`**, **`&lt;script&gt;`**, **`&amp;`**, **`&quot;`**/`&#39;` (or equivalent entities) as **visible text** — parsed back, `querySelector('img') === null` and `querySelector('script') === null`. No live tag is ever created from `body_text`. This is THE injection-proof for the fallback path.
- **Файл:** `scripts/verify-email-html-render-001.js` (`linkify`)

### TC-EHR-H18: `linkifyToHtml` wraps a URL / bare `www.` into a safe `<a>` with target+rel
- **Приоритет:** P0
- **Тип:** headless
- **Связанный сценарий:** S3; AC-5; FR-6
- **Вход:** `linkifyToHtml('see https://ex.com/a?b=1 and www.ex.org now')`.
- **Ожидаемый результат:** parsed output has an `<a href="https://ex.com/a?b=1">` and an `<a>` for `www.ex.org` (href normalized to `http(s)://www.ex.org`), **each** with `target="_blank" rel="noopener noreferrer"`; the surrounding words remain plain text. The query string `?b=1` is inside the href, not broken.
- **Файл:** `scripts/verify-email-html-render-001.js` (`linkify`)

### TC-EHR-H19: `linkifyToHtml` wraps an email → `mailto:` and a phone → `tel:`
- **Приоритет:** P0
- **Тип:** headless
- **Связанный сценарий:** S3; AC-5; FR-6 (reuses `lib/formatPhone.ts` for display)
- **Вход:** `linkifyToHtml('reach me at jane.doe@relyhome.com or +1 (617) 555-9001')`.
- **Ожидаемый результат:** an `<a href="mailto:jane.doe@relyhome.com">` and an `<a href="tel:+16175559001">` (href digits normalized; **display** may be the `formatPhone` form), both with target+rel. A malformed `@` fragment (`a@`) is NOT wrapped.
- **Файл:** `scripts/verify-email-html-render-001.js` (`linkify`)

### TC-EHR-H20: `linkifyToHtml` preserves `\n` line-break semantics (per-line, no collapse)
- **Приоритет:** P1
- **Тип:** headless
- **Связанный сценарий:** S3; FR-6 ("preserve whitespace-pre-wrap")
- **Вход:** `linkifyToHtml('line1\nline2 https://x.io\nline3')`.
- **Ожидаемый результат:** the output retains the `\n` (or per-line structure) so the consuming `<p class="whitespace-pre-wrap">` shows three lines; the URL on line 2 is linkified without merging lines. Non-URL text is byte-untouched apart from escaping.
- **Файл:** `scripts/verify-email-html-render-001.js` (`linkify`)

### TC-EHR-H21: `linkifyToHtml` — text with no URL/email/phone → escaped-but-otherwise-unchanged (no spurious `<a>`)
- **Приоритет:** P2
- **Тип:** headless
- **Связанный сценарий:** S3; FR-6 ("non-URLs untouched")
- **Вход:** `linkifyToHtml('just a plain sentence, no links here.')`.
- **Ожидаемый результат:** `querySelectorAll('a').length === 0`; the sentence appears verbatim (only entity-escaped). Guards against an over-greedy matcher wrapping plain words.
- **Файл:** `scripts/verify-email-html-render-001.js` (`linkify`)

---

## 3. Unit — root node-env jest (backend + FE-branch logic reachable without a DOM)

`jest.mock('../db/connection')` where a query is involved. These pin **shape / dispatch / SQL string / branch selection** — never live render (that is Group D). Backend cases run today with zero new deps.

### TC-EHR-U01: `getTimelineEmailByContact` — SELECT gains `body_html`; `WHERE company_id=$1 AND contact_id=$2 AND on_timeline=true` UNCHANGED (scoping = P0)
- **Приоритет:** **P0**
- **Тип:** Unit (query builder, db mocked — SQL string)
- **Связанный сценарий:** S9; AC-7, AC-8; backend change point #1; NFR-SEC-5
- **Предусловия:** mock `db.query` capturing the SQL text; call `getTimelineEmailByContact('A','C',{})`.
- **Ожидаемый результат:** the emitted SQL column list **includes `body_html`** (added to the l.594–597 list) AND the `WHERE company_id = $1 AND contact_id = $2 AND on_timeline = true` clause is **byte-identical to today** (params `['A','C']`, `ORDER BY gmail_internal_at ASC, id ASC` unchanged). A cross-tenant contact is impossible because `company_id`/`contact_id` are still both bound — **leak = P0**.
- **Файл:** `tests/emailQueriesTimeline.test.js` (or the existing emailQueries suite)

### TC-EHR-U02: `pulse.js` timeline mapping — email item carries `body_html: row.body_html` (RAW), `body_text` still quote-stripped
- **Приоритет:** **P0**
- **Тип:** Unit (route mapping, db mocked)
- **Связанный сценарий:** S1, S12; AC-7; change point #2
- **Предусловия:** stub the timeline query to return a row with `body_html:'<p>hi</p>'`, `body_text:'hi\n> quoted'`, `snippet:'hi'`.
- **Ожидаемый результат:** the mapped email item has `body_html === '<p>hi</p>'` (passed **RAW**, not quote-stripped, not sanitized server-side) **and** `body_text === toTimelineBody('hi\n> quoted', {snippet:'hi'})` (still quote-stripped). The response envelope is a **superset** of today (no removed field). Company scoping via `req.companyFilter.company_id` is unchanged.
- **Файл:** `tests/pulseTimeline.test.js`

### TC-EHR-U03: `emailTimelineService.toEmailItem` — adds `body_html: row.body_html || null` (SSE-parity)
- **Приоритет:** P2
- **Тип:** Unit
- **Связанный сценарий:** S12; AC-7; change point #3 (parity, NOT required for AC-1)
- **Предусловия:** call `toEmailItem({...row, body_html:'<b>x</b>'})` and `toEmailItem({...row, body_html:null})`.
- **Ожидаемый результат:** returns `body_html:'<b>x</b>'` / `body_html:null` respectively; the item shape is **identical** to the `pulse.js` REST mapping's email item (the l.44–46 parity invariant), so a future append-from-SSE renders the same bubble.
- **Файл:** `tests/emailTimelineService.test.js`

### TC-EHR-U04: `EmailListItem` render matrix — branch selection M1–M5 (logic only; the sanitize/linkify calls are spied)
- **Приоритет:** **P0**
- **Тип:** Unit (branch dispatch) — **see vehicle note**
- **Связанный сценарий:** S1/S3/S4/S8/S11; AC-1, AC-5, AC-10; render matrix M1–M5
- **Предусловия:** *(Vehicle caveat: `EmailListItem` is a React TSX component; there is no FE runner. Realize this as a **pure branch-selector** extracted/exercised as a plain function `pickEmailRender({direction, body_html, sanitized})`, OR — if not extracted — assert M1–M5 by inspection + the headless/manual coverage below. The Planner should extract the matrix decision into a testable pure helper so this is automatable in the headless script's `linkify`/branch section.)*
- **Ожидаемый результат (the contract to pin, however realized):**
  - **M1** inbound + non-empty `body_html` → uses `SafeEmailHtml(body_html,{allowImages})` + renders a "Show images" `<button>`.
  - **M2** inbound + empty `body_html` → `linkifyToHtml(body_text)`.
  - **M3** outbound (**any** `body_html`, even non-empty) → `linkifyToHtml(body_text)`; **sanitize is NEVER called** for outbound.
  - **M4** no html AND no text → renders nothing for the body (existing `hasBody` guard); subject/timestamp still show.
  - **M5** inbound + `body_html` present but `sanitizeEmailHtml`→`''` → **falls through** to `linkifyToHtml(body_text)`.
- **Файл:** `scripts/verify-email-html-render-001.js` (branch section) if extracted; else Group D manual TC-EHR-M01/M04/M06.

### TC-EHR-U05: `SafeEmailHtml` memoization key `(messageId ?? hash(html), allowImages)` — sanitize called ONCE per key, not per re-render
- **Приоритет:** **P1**
- **Тип:** Unit (memo behavior) — **see vehicle note**
- **Связанный сценарий:** S7; AC-9; NFR-PERF-1
- **Предусловия:** *(Vehicle caveat: no FE runner for the React hook. Pin the **memo-key derivation** as a pure function `emailMemoKey(messageId, html, allowImages)` and assert it's stable across identical inputs and changes only when `messageId`/`allowImages` change — automatable headless. The "sanitize invoked once per key on real re-render" half is Group D manual TC-EHR-M05, since it needs a live React tree.)*
- **Ожидаемый результат:** `emailMemoKey('42', html, false)` is equal across calls; differs when `allowImages` flips to `true` or `messageId` changes; when `messageId` is absent, the key is derived from `hash(html)` (same html → same key). This is the key that gates `useMemo` so sanitize runs once per message per images-state (not on scroll).
- **Файл:** `scripts/verify-email-html-render-001.js` (branch section) — key derivation; + manual TC-EHR-M05.

### TC-EHR-U06: backend — `body_text ILIKE` free-text search is UNCHANGED (search stays on `body_text`, not `body_html`)
- **Приоритет:** **P0**
- **Тип:** Unit (query string, db mocked)
- **Связанный сценарий:** S9-adjacent; AC-7; "search untouched" (FR-9)
- **Предусловия:** invoke the email search query (emailQueries l.152–165 region) with a search term; capture SQL.
- **Ожидаемый результат:** the search predicate still references `m.body_text ILIKE $idx` (+ `from_email`/`from_name`/recipients) and does **NOT** add `body_html` to the search — a huge HTML blob never bloats/changes search matching. Byte-identical to today.
- **Файл:** `tests/emailSearch.test.js` (or existing search suite)

---

## 4. Build / static gates

### TC-EHR-B01: `frontend/package.json` diff — ONLY the pinned `"dompurify": "3.2.7"` add; NO new package
- **Приоритет:** **P0**
- **Тип:** build/static
- **Связанный сценарий:** AC-5, AC-6; OQ-HR-C
- **Ожидаемый результат:** `git diff frontend/package.json` shows exactly the `"dompurify": "3.2.7"` dependency line added (matching lockfile l.7773) and **no other new runtime dependency** (no linkify lib, no sanitizer lib). `@types/dompurify` appears **only if** `tsc -b` demanded it. The lockfile is unchanged for dompurify (already present).
- **Файл:** PR diff / CI check

### TC-EHR-B02: exactly ONE DOMPurify config in the frontend — `EmailMessageItem` no longer calls `DOMPurify.sanitize` directly
- **Приоритет:** **P0**
- **Тип:** build/static (grep/import assertion)
- **Связанный сценарий:** S10; AC-6; D5/FR-2
- **Ожидаемый результат:** `grep -rn "DOMPurify.sanitize" frontend/src` returns **only** the call inside `frontend/src/lib/sanitizeEmailHtml.ts` (the old `EmailMessageItem.tsx` l.87–92 call is **gone**, replaced by `<SafeEmailHtml …/>`); `EmailMessageItem` **imports** `SafeEmailHtml`. No second config object exists. This is the "single config" gate.
- **Файл:** PR grep / CI check

### TC-EHR-B03: **config-parity** — the CJS port in the verify script === the shipped `sanitizeEmailHtml.ts` config/hook
- **Приоритет:** **P0**
- **Тип:** build/static
- **Связанный сценарий:** harness integrity (vehicle §Port + parity)
- **Ожидаемый результат:** a normalized-string / structural compare asserts the DOMPurify config (allowed tags/attrs, the `^\s*(javascript|data):`i regex, the `data-blanc-src` move, the forced `target/rel`) encoded in `scripts/verify-email-html-render-001.js` matches the one exported by `frontend/src/lib/sanitizeEmailHtml.ts`. If they diverge the check **FAILs** — so the headless matrix can never certify a config that isn't what ships. *(If the Implementer instead wires a TS/ESM loader so the script imports the real module, this case asserts THAT import path resolves to the real file; pick one.)*
- **Файл:** PR check + `scripts/verify-email-html-render-001.js` (`sab`/startup)

### TC-EHR-B04: TypeScript build green — `cd frontend && npm run build` (`tsc -b && vite build`), stricter prod Docker gate
- **Приоритет:** **P0**
- **Тип:** build
- **Связанный сценарий:** AC-1/AC-7 type add; frontend-build-command lesson
- **Ожидаемый результат:** `npm run build` exits 0 with the new `EmailTimelineItem.body_html` field, the three NEW modules, and the `EmailListItem`/`EmailMessageItem` edits — **no `noUnusedLocals`/type error** (prod Docker build is stricter than `tsc --noEmit`). Confirms `SafeEmailHtml` props/types and the sanitizer signature compile.
- **Файл:** build / CI (+ Docker build)

### TC-EHR-B05: NO new migration ships — max migration unchanged; `body_html` column reused (mig 079)
- **Приоритет:** **P1**
- **Тип:** build/static (repo check)
- **Связанный сценарий:** AC-7; D6 "no migration"
- **Ожидаемый результат:** no new file added under `backend/db/migrations/` for this feature (the `body_html TEXT` column already exists from mig 079); the max migration number is unchanged by this PR. Backend build/`node -c` clean on the three edited files.
- **Файл:** repo check / CI

---

## 5. Manual / browser (NOT jest — MANDATORY; the render/network/layout truths a headless check cannot assert)

Run on a **real prod-DB copy** in a real browser (`/pulse/timeline/3044` + `/email`). House lesson: don't trust headless for shadow render, live network, or jank. **Prod deploy is owner-consent-gated.**

### TC-EHR-M01: S1 render fidelity — inbound Google-LSA HTML at `/pulse/timeline/3044` renders formatted; links AND buttons-as-links are clickable, open in a new tab
- **Приоритет:** **P0**
- **Тип:** manual-browser
- **Связанный сценарий:** S1; AC-1
- **Шаги:** load `/pulse/timeline/3044`; observe the inbound LSA email bubble; click a link and a button-styled link.
- **Ожидаемый результат:** real formatting (not a wall of text); every link/button opens in a **new tab** (verify `rel="noopener noreferrer"` in the shadow DOM via devtools); no console error. An **outbound** email in the same timeline shows plain (linkified) text side-by-side (S4).

### TC-EHR-M02: S6 two-way style isolation — email `<style>`/classes don't restyle app chrome; app CSS doesn't distort the email
- **Приоритет:** **P0**
- **Тип:** manual-browser
- **Связанный сценарий:** S6; AC-3
- **Шаги:** open an email whose `<style>` sets `body{background:#000;color:#0f0}` and uses `.card`/`.header` class collisions; inspect the shadow root; look at the sidebar/list/other bubbles.
- **Ожидаемый результат:** the email's CSS styles **only** content inside its bubble (an **open** `shadowRoot` is present on the host `<div>`); the Pulse sidebar/list/other bubbles are **unchanged**; the email itself is **not** distorted by app global CSS. No class-name collision crosses the boundary.

### TC-EHR-M03: S2 remote-image network suppression — devtools Network shows NO image request until "Show images"
- **Приоритет:** **P0**
- **Тип:** manual-browser (the beacon proof — headless cannot observe the network)
- **Связанный сценарий:** S2; AC-4; NFR-SEC-4
- **Шаги:** open devtools → Network, filter Img; load an inbound email with a remote tracking pixel + content images; confirm **zero** requests to the remote hosts; click **"Show images"**; confirm the requests now fire.
- **Ожидаемый результат:** on first render **no outbound image request** (sender gets no read-beacon); a `data:` image DID render with no request; after the click, remote images load. The neutralize→toggle re-sets `innerHTML` wholesale (no "live remote src then strip" race).

### TC-EHR-M04: S7 containment — ~600 px table + ~39 KB email: no `max-height`, no expand, horizontal scroll stays INSIDE the bubble
- **Приоритет:** **P0**
- **Тип:** manual-browser
- **Связанный сценарий:** S7; AC-3
- **Шаги:** open the 3044 mail (has a wide table); inspect the host `<div>`; try to scroll the wide table.
- **Ожидаемый результат:** the host carries `max-width:100%; overflow-x:auto`; there is **no `max-height`** and **no expand/collapse control** (D2); the wide table scrolls **horizontally inside its own bubble**; the app layout (list width, sidebar) never breaks or gains a page-level horizontal scrollbar.

### TC-EHR-M05: S7/AC-9 no scroll jank — memoized sanitize; a long timeline of several ~39 KB HTML emails scrolls smoothly
- **Приоритет:** **P1**
- **Тип:** manual-browser (+ optional perf trace)
- **Связанный сценарий:** S7; AC-9; NFR-PERF-1/2
- **Шаги:** on a contact timeline with several large HTML emails, scroll up/down repeatedly; toggle "Show images" on one item; optionally record a Performance trace.
- **Ожидаемый результат:** no visible jank/reflow storm; sanitize runs **once per message per images-state** (not on every scroll/re-render — confirm via a `console.count` in `sanitizeEmailHtml` during the trace, or React Profiler); toggling one item does **not** force a synchronous reflow of the whole timeline.

### TC-EHR-M06: S8 fail-safe in the real UI — a forced sanitize failure falls back to linkified text; the timeline does NOT crash or show raw HTML
- **Приоритет:** **P1**
- **Тип:** manual-browser
- **Связанный сценарий:** S8; AC-10; M5
- **Шаги:** temporarily force `sanitizeEmailHtml` to return `''` (or throw) for one message; reload the timeline.
- **Ожидаемый результат:** that bubble shows the **linkified plain-text** render (from `body_text`); the timeline and other bubbles are **unaffected**; **no raw HTML** is ever injected; no React crash/boundary trip.

### TC-EHR-M07: S10 `/email` workspace parity — benign mail unchanged, hostile mail strictly safer after adopting `SafeEmailHtml`
- **Приоритет:** **P1**
- **Тип:** manual-browser
- **Связанный сценарий:** S10; AC-6; NFR-COMPAT-1
- **Шаги:** in `/email`, open a benign HTML email (note `@tailwindcss/typography` is NOT installed → the old `prose prose-sm` were no-ops) and a hostile one; compare to pre-refactor behavior.
- **Ожидаемый результат:** benign mail renders **unchanged** (losing the no-op `prose` costs nothing; the base sheet keeps bare HTML at least as readable); hostile mail is **strictly safer** — forced link `target`/`rel`, remote-image blocking + "Show images", `data:`/`javascript:` link block now applied in the workspace too; `<pre>` `body_text` fallback + attachments gallery still work; no visual regression.

### TC-EHR-M08: S1 bare/unstyled email legibility — the 8-declaration base sheet makes plain `<p>…<a>…</a></p>` legible without flattening a styled email
- **Приоритет:** P2
- **Тип:** manual-browser
- **Связанный сценарий:** OQ-HR-A; §Shadow base stylesheet
- **Шаги:** render a hand-crafted `<p>Hello <a href="https://x.io">link</a></p>` (no author CSS) AND the styled 3044 mail; compare.
- **Ожидаемый результат:** the **bare** email inherits IBM Plex + `--blanc-ink-1`, links use `--blanc-info`, `img/table` are capped to `max-width:100%`, `<p>` has minimal rhythm — legible and native-looking; the **styled** 3044 mail keeps its OWN fonts/colors (author rules win by specificity/order — the base sheet only supplies defaults, no `all:initial`/reset that would flatten it).

---

## 6. Sabotage negative control

### TC-EHR-SAB: replace the sanitize step with a pass-through → the headless security matrix MUST turn RED, then restore
- **Приоритет:** **P0**
- **Тип:** headless (self-check — mirrors `verify-contact-email-merge-001.js` TC-CEM-ISAB)
- **Связанный сценарий:** harness integrity (LIST-PAGINATION-001 "a green run must certify the detector works")
- **Шаги (two prongs):**
  1. **Config sabotage (always runs in `sab`):** run the `security` assertions against a variant where the sanitize is `html => html` (pass-through, no strip/no hook). Confirm the harness **throws `CheckError` / records FAIL** on TC-EHR-H01/H02/H04/H06/H08/H10 (script survives, `onerror` survives, `<form>` survives, `javascript:` href survives, remote `src` stays live, `<a>` lacks `target`/`rel`). Then restore the real sanitize → assert green.
  2. **Code sabotage (documented, run manually in the deploy window):** temporarily delete the `afterSanitizeAttributes` hook body in `sanitizeEmailHtml.ts` (or the whole `DOMPurify.sanitize` call), re-run `--section=security` → the matrix **MUST turn red** (anchors lose target/rel, remote images stay live, `javascript:` href survives). Restore → green.
- **Ожидаемый результат:** prong 1 trips FAILs then restores green in one run; prong 2 shows red-on-removal / green-on-restore. If either does NOT trip a FAIL, the detector is broken and every PASS above is vacuous. This is what makes a green Group-1 run trustworthy for AC-2.
- **Файл:** `scripts/verify-email-html-render-001.js` (`sab`) + a one-line PR note for the manual prong.

---

## Regression / Protected (must stay green)

- **TC-R-1 (P0):** **Timeline company+contact scoping unchanged** — `getTimelineEmailByContact` keeps `WHERE company_id=$1 AND contact_id=$2 AND on_timeline=true`; `body_html` is a SELECT-column add ONLY, no new route/param/middleware, so no new 401/403/cross-tenant surface. A cross-tenant fetch returns nothing (TC-EHR-U01). **Leak = P0.**
- **TC-R-2 (P0):** **`body_text` + `ILIKE` search intact** — the fallback/outbound path still reads quote-stripped `body_text` (`toTimelineBody`), and free-text search stays on `body_text`/`from_*`/recipients, never `body_html` (TC-EHR-U06). Existing pulse/email search suites stay green.
- **TC-R-3 (P1):** **No global DOMPurify leak** — the email config/hooks are add/removed around the call; a non-email `DOMPurify.sanitize` elsewhere is byte-unaffected (TC-EHR-H16). Guards against poisoning other callers when the workspace + timeline share the one config.
- **TC-R-4 (P1):** **`/email` workspace behavior only improves** — after replacing its inline `DOMPurify.sanitize` with `SafeEmailHtml`, benign mail is unchanged and hostile mail is strictly safer; `<pre>` fallback + attachments untouched (TC-EHR-M07, TC-EHR-B02). No second config remains.
- **TC-R-5 (P1):** **Existing chrome untouched** — `EmailListItem`'s eyebrow/subject/timestamp + the bubble's `max-w-[75%]` cage are unchanged; the new render only swaps the **body** region; `hasBody` empty-guard (M4) preserved. Protected files (`server.js`, `authedFetch.ts`, `useRealtimeEvents.ts`) not edited.
- **TC-R-6 (P2):** **No migration / no new package (shipped)** — the only dep add is the already-locked `dompurify` pin (TC-EHR-B01); `jsdom` (if added) is a **dev/verify-only** root devDependency, never bundled; max migration unchanged (TC-EHR-B05).

## Notes for the Implementer / Tester

- **Vehicle, restated so nobody re-invents it:** there is **no frontend test runner and no jsdom-jest env installed** (verified). Do **not** add a `@jest-environment jsdom` docblock (env package absent). The DOM-needing sanitizer is proven by **`scripts/verify-email-html-render-001.js`** (Node + a **dev-only `jsdom`** + the frontend `dompurify`, DOMPurify's `createDOMPurify(window)` headless factory), running the hostile matrix + linkify + sabotage headless. The **backend** read/type/mapping cases run in the **existing node-env root jest** with zero new deps. **Render fidelity, shadow isolation, remote-image beacon suppression, layout containment, and no-jank are Group D manual-browser on a prod-DB copy** — a headless string check cannot assert them (LIST-PAGINATION-001 / created_by-FK lesson).
- **Worktree jest gotcha (superset of JOBS-UX-RBAC-001):** the root jest config **already** has `testPathIgnorePatterns: ["/node_modules/", "/\\.claude/worktrees/"]`, so a test file placed inside this worktree is **silently not collected**. Run new backend jest from the **real repo root** (or override the pattern deliberately) — otherwise a "green" run ran **zero** of the new cases.
- **The three things a green headless run does NOT prove** (must be eyeballed manually before ship): shadow-DOM style isolation both directions (M02), that remote images fire **no network beacon** until "Show images" (M03), and no scroll jank on ~39 KB emails (M05). Green matrix + green manual = ship bar.
- **Config-parity (TC-EHR-B03) is load-bearing:** because the TS sanitizer can't be `require`d by Node and no TS loader is installed, the verify script uses a CJS **port** of the config; the parity assertion is the only thing stopping the headless matrix from certifying a config that differs from what ships. If the Implementer wires a TS/ESM loader (adds `tsx`/`esbuild` as a dev dep) so the script imports the real `.ts`, that's cleaner — pin THAT and drop the port. Either way, **the headless matrix must exercise the exact shipped config.**
- **Sabotage (TC-EHR-SAB) is what makes green trustworthy** — if `html=>html` pass-through does NOT turn the matrix red, the matrix isn't asserting anything. Keep it in `--section=sab` and run it every time.
- **AC-6 single-config gate (TC-EHR-B02):** after the refactor, `grep -rn "DOMPurify.sanitize" frontend/src` must show ONLY `sanitizeEmailHtml.ts` — the old `EmailMessageItem` call is removed. A lingering second call = AC-6 fail.
- **Backend is additive only:** change point #3 (`toEmailItem`) is **parity hygiene, NOT required for AC-1** — the bubble is built from the REST projection (`getTimelineEmailByContact` → `pulse.js`), and SSE `message.added` **refetches** rather than appends. AC-1 = #1 + #2 (backend) + #4 (type) + the FE work.
