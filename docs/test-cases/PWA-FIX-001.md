# Тест-кейсы: PWA-FIX-001 — keep the installed Albusto PWA standalone on iOS

**Spec:** `Docs/specs/PWA-FIX-001-SPEC.md` · **Requirements:** `## PWA-FIX-001` in `Docs/requirements.md` · **Architecture:** `## PWA-FIX-001` in `Docs/architecture.md`
**Scope:** frontend-only (`frontend/`, Vite + React SPA). NO backend, NO migration, NO company_id/tenant-isolation surface (frontend-only → the standard 401/403 + cross-tenant middleware suite from the agent checklist is **N/A** and intentionally omitted — see "Not applicable" below).

---

## Harness reality (verified 2026-07-07)

- `frontend/package.json` scripts = `dev` / `build` (`tsc -b && vite build`) / `lint` / `preview`. **No `test` script.**
- **No jest / vitest** anywhere: no config file, no `*.test.*` / `*.spec.*` under `frontend/src`, no `vitest`/`jest` binary in `frontend/node_modules/.bin`.
- The only guaranteed automated gate is **`npm run build`** (tsc -b + vite build, prod-strict `noUnusedLocals`).
- `sips` present at `/usr/bin/sips` (pixel-dimension check works); `node` at `/usr/local/bin/node`. `rsvg-convert`/`librsvg` are a **build-time** icon tool only (not asserted at CI).

### Recommendation for the one unit-testable module (`frontend/src/auth/refreshPolicy.ts`)

The pure classifier + backoff constant is genuinely unit-testable, but there is no runner. Two options were on the table:

- **(a)** Introduce a minimal vitest setup (add `vitest` devDep + `"test": "vitest run"` + one `refreshPolicy.test.ts`).
- **(b)** A standalone Node assertion script `frontend/scripts/verify-pwa-refresh-policy.mjs` that imports the pure logic and asserts the truth-table, plus a sabotage negative-control, run via `node`.

**Recommendation → option (b).** Rationale: project memory + repo state say the frontend has historically had **no test harness**; adding vitest is net-new tooling/config the Implementer + Reviewer must carry, and the module is a single pure function + one constant. A `.mjs` assertion script (a) needs zero new dependency, (b) runs on the already-present `node`, (c) can be added to the build/verify flow as `node frontend/scripts/verify-pwa-refresh-policy.mjs`, and (d) still gives a real automated truth-table gate with a negative control. The Planner may still choose (a) if they want `import`-from-`.ts` ergonomics; if so, the same UNIT cases below apply verbatim as vitest `it()` blocks. **The test CASES are runner-agnostic** — written once below; TYPE `UNIT` means "assert with the chosen runner (b default)".

> Note on `.mjs` importing `.ts`: the pure module has **no runtime deps** and is trivially portable — the Implementer should either author `refreshPolicy` so the classifier logic is importable by the script (e.g. keep a `.mjs`/`.js`-consumable copy of the pattern list + function, or have the script import the compiled `dist/` output after `tsc -b`, or duplicate the tiny pure logic in the verify script and assert it stays in sync). Simplest robust path: **the verify script imports from the built output** (`frontend/dist/assets/…` is hashed → instead point the script at a `tsc`-emitted `.js`, or re-declare the 4 `DEAD_GRANT_PATTERNS` + rule order inside the script and assert against them). Planner to pin the exact import seam; the assertions themselves are fixed by §3.3.1.

---

## Покрытие

- **Всего тест-кейсов: 41**
- **P0: 17 | P1: 15 | P2: 7 | P3: 2**
- **UNIT: 15 | STATIC: 13 | BUILD: 1 | MANUAL: 8 | DEPLOY: 4**

Type legend:
- **UNIT** — pure `refreshPolicy` classifier / backoff / orchestrator-decision, asserted by the chosen runner (option b default).
- **STATIC** — grep / JSON-parse / file-exists / `sips` pixel-dimension check against repo files.
- **BUILD** — `npm run build` exits 0.
- **MANUAL** — owner-gated on-device iOS check (no automated iOS-standalone harness exists).
- **DEPLOY** — post-deploy `curl -I` content-type check against prod (§5).

---

## A. `refreshPolicy.ts` classifier — 8-row truth-table (§3.3.1, §1.4.1–1.4.8)

> Runner: option (b) `verify-pwa-refresh-policy.mjs` (default) or vitest. Input shape = `{ hasRefreshToken, online, error }` → output `'transient' | 'dead'`. Rule order: (1) offline⇒transient short-circuit; (2) no refresh token⇒dead; (3) DEAD_GRANT pattern⇒dead; (4) else⇒transient.

### TC-PWA-001: Offline dominates — row 1 (offline ⇒ transient, regardless of everything)
- **Приоритет:** P0
- **Тип:** UNIT
- **Связанный сценарий:** §3.3.1 row 1, §1.4.7 (offline flag dominates)
- **Входные данные:** `{ online:false, hasRefreshToken:false, error:{error:'invalid_grant'} }` — deliberately combines the two strongest *dead* signals with `online:false`.
- **Ожидаемый результат:** `classifyRefreshFailure(...)` === `'transient'`. Proves rule-1 short-circuits BEFORE the no-refresh-token and grant-pattern checks (an offline blip must never eject even when the error looks dead).
- **Файл для теста:** `frontend/scripts/verify-pwa-refresh-policy.mjs` (or `refreshPolicy.test.ts`)

### TC-PWA-002: No refresh token while online ⇒ dead — row 2
- **Приоритет:** P0
- **Тип:** UNIT
- **Связанный сценарий:** §3.3.1 row 2, §1.4.4 (adapter cleared token ⇒ real expiry)
- **Входные данные:** `{ online:true, hasRefreshToken:false, error:{} }` (empty error on purpose — the missing token alone must decide dead).
- **Ожидаемый результат:** === `'dead'`.

### TC-PWA-003: `invalid_grant` string ⇒ dead — row 3
- **Приоритет:** P0
- **Тип:** UNIT
- **Связанный сценарий:** §3.3.1 row 3, §1.4.4
- **Входные данные:** `{ online:true, hasRefreshToken:true, error:{error:'invalid_grant'} }`.
- **Ожидаемый результат:** === `'dead'`.

### TC-PWA-004: "session not active" (all separator spellings) ⇒ dead — row 4
- **Приоритет:** P0
- **Тип:** UNIT
- **Связанный сценарий:** §3.3.1 row 4, §1.4.4; pattern `/session[_\s-]*not[_\s-]*active/i`
- **Входные данные:** three sub-asserts, each `online:true, hasRefreshToken:true`: `error:{error_description:'Session not active'}`, `error:new Error('session_not_active')`, `error:{message:'session-not-active'}`.
- **Ожидаемый результат:** all three === `'dead'` (proves the `[_\s-]*` flexibility + `.error_description`/`.message`/`Error` extraction all reach the pattern).

### TC-PWA-005: "token expired" ⇒ dead — row 5
- **Приоритет:** P0
- **Тип:** UNIT
- **Связанный сценарий:** §3.3.1 row 5; pattern `/token[_\s-]*(is[_\s-]*)?expired/i`
- **Входные данные:** two sub-asserts (`online:true, hasRefreshToken:true`): `error:{message:'token expired'}` and `error:{message:'token is expired'}` (exercises the optional `is` group).
- **Ожидаемый результат:** both === `'dead'`.

### TC-PWA-006: "refresh token" signal ⇒ dead — row 6
- **Приоритет:** P0
- **Тип:** UNIT
- **Связанный сценарий:** §3.3.1 row 6; pattern `/refresh[_\s-]*token/i`
- **Входные данные:** `{ online:true, hasRefreshToken:true, error:{error_description:'Refresh token expired'} }`.
- **Ожидаемый результат:** === `'dead'`.

### TC-PWA-007: Empty / ambiguous reject while online+token-present ⇒ transient — row 7
- **Приоритет:** P0
- **Тип:** UNIT
- **Связанный сценарий:** §3.3.1 row 7, §1.4.8 (never eject on ambiguity)
- **Входные данные:** three sub-asserts (`online:true, hasRefreshToken:true`): `error:undefined`, `error:{}`, `error:new Error('')` — i.e. `extractErrorText` returns `''`.
- **Ожидаемый результат:** all three === `'transient'`.

### TC-PWA-008: Non-matching generic error ⇒ transient — row 8
- **Приоритет:** P0
- **Тип:** UNIT
- **Связанный сценарий:** §3.3.1 row 8, §1.4.8
- **Входные данные:** `{ online:true, hasRefreshToken:true, error:new Error('Network request failed: 503') }` (real text, no grant signal).
- **Ожидаемый результат:** === `'transient'`.

### TC-PWA-009: `extractErrorText` field precedence & shapes
- **Приоритет:** P1
- **Тип:** UNIT
- **Связанный сценарий:** §3.3 (`extractErrorText` pulls `.error` / `.error_description` / `.message` / `String()`; `''` for undefined/`{}`)
- **Входные данные:** feed classifier errors that force each extraction branch to matter: `{error:'invalid_grant'}` (`.error`), `{error_description:'session not active'}` (`.error_description`), `new Error('token expired')` (`.message`), `'invalid_grant'` (raw string → `String()`), `{}`/`undefined` (⇒ `''`).
- **Ожидаемый результат:** the four populated shapes classify `'dead'`; `{}`/`undefined` classify `'transient'` (online, token present). Confirms extraction reaches the pattern from every documented shape.

### TC-PWA-010: DEAD_GRANT patterns are case-insensitive & substring
- **Приоритет:** P2
- **Тип:** UNIT
- **Связанный сценарий:** §3.3 `DEAD_GRANT_PATTERNS` (all `/i`)
- **Входные данные:** `{online:true, hasRefreshToken:true, error:{error:'ERROR: INVALID_GRANT during token exchange'}}` (uppercase, embedded in a longer sentence).
- **Ожидаемый результат:** === `'dead'` (proves `/i` + non-anchored substring match, so real Keycloak sentences still classify).

### TC-PWA-011: NEGATIVE CONTROL (sabotage) — a benign-network string must NOT be dead
- **Приоритет:** P0
- **Тип:** UNIT
- **Связанный сценарий:** §1.4.8 anti-regression / meta-check that the truth-table isn't trivially "always dead"
- **Входные данные:** `{online:true, hasRefreshToken:true, error:new Error('timeout of 60000ms exceeded')}`.
- **Ожидаемый результат:** === `'transient'`. **Sabotage assertion:** if a future edit broadens `DEAD_GRANT_PATTERNS` (e.g. adds `/token/i` or `/failed/i`) this case flips to `'dead'` and the script must FAIL — it is the guard that the classifier stays *biased-to-transient*. (This is the negative-control the harness note requires.)

---

## B. `refreshPolicy.ts` backoff constant (§3.3, §1.4.2–1.4.3, §4.2)

### TC-PWA-012: Backoff schedule is exactly [2000, 5000, 10000]
- **Приоритет:** P0
- **Тип:** UNIT
- **Связанный сценарий:** §3.3, §1.4.2 (2000/5000/10000 ms)
- **Входные данные:** import `REFRESH_RETRY_BACKOFF_MS`.
- **Ожидаемый результат:** deep-equals `[2000, 5000, 10000]` (order + values). Guards the silent-retry cadence.

### TC-PWA-013: Backoff length == retry budget (3), ceiling ≈17s
- **Приоритет:** P0
- **Тип:** UNIT
- **Связанный сценарий:** §1.4.3 (`attempt >= REFRESH_RETRY_BACKOFF_MS.length` ⇒ redirect), §4.2 (bounded ~17s)
- **Входные данные:** `REFRESH_RETRY_BACKOFF_MS`.
- **Ожидаемый результат:** `.length === 3`; `reduce((a,b)=>a+b,0) === 17000`. Guards the self-terminating budget the orchestrator's exhaustion branch depends on.

---

## C. `refreshTokenOrLogin` orchestrator — decision seam (§3.4, §4b, §1.4.1–1.4.6, §1.4.9)

> The orchestrator is impure (Keycloak + timers). Per the architecture's testability recommendation it should be extracted with `sleep` injectable and driven by a **fake `kc`** (scripted `updateToken`, spy `login`, settable `token`/`refreshToken`) + a no-op/instant `sleep`. Model these as pure-logic decision cases. If the Implementer does NOT extract it, these become MANUAL (note per case). Preferred: extract → UNIT.

### TC-PWA-014: Live token — resolves refreshed=false, applyToken no-op-safe, ZERO login()
- **Приоритет:** P0
- **Тип:** UNIT (fake-kc; MANUAL if not extracted)
- **Связанный сценарий:** §1.4.1 (a), §3.4 (`if (refreshed || attempt===0) onRefreshed()`)
- **Предусловия:** fake `kc.updateToken` resolves `false` (still valid); `sleep` spy.
- **Шаги:** call `refreshTokenOrLogin(kc, applyToken)`.
- **Ожидаемый результат:** `kc.login` called **0** times; `applyToken` called (attempt===0 path) with `kc.token` current → harmless. No `sleep`. Standalone preserved.

### TC-PWA-015: Transient once then success — retries, applies token, ZERO login()
- **Приоритет:** P0
- **Тип:** UNIT (fake-kc; MANUAL if not extracted)
- **Связанный сценарий:** §1.4.2 (b) + §1.4.5 (e), FR-AUTH-3
- **Предусловия:** fake `kc.updateToken` sequence: attempt0 rejects (`online:true`, `refreshToken` present, empty error ⇒ transient), attempt1 resolves `true`; `kc.token` set on success; `sleep` = injected no-op spy.
- **Шаги:** call orchestrator; await.
- **Ожидаемый результат:** `kc.login` called **0** times; `sleep` called once with `2000`; on the resolving attempt `applyToken` runs → `setToken(kc.token)` + `fetchAuthzContext(kc.token)` fire exactly as today. No user-visible eject.

### TC-PWA-016: Retries exhausted (all transient) — EXACTLY ONE login(), bounded
- **Приоритет:** P0
- **Тип:** UNIT (fake-kc; MANUAL if not extracted)
- **Связанный сценарий:** §1.4.3 (c), §4.2, AC-3
- **Предусловия:** fake `kc.updateToken` rejects transiently every call (online:true, refreshToken present, empty error); `sleep` = no-op spy.
- **Шаги:** call orchestrator; await full chain.
- **Ожидаемый результат:** `sleep` called exactly **3** times with `2000,5000,10000` in order; `kc.login` called **exactly once** (on `attempt===3 >= length`); function returns (no further recursion / no infinite loop).

### TC-PWA-017: Dead session — IMMEDIATE single login(), no retry, no sleep
- **Приоритет:** P0
- **Тип:** UNIT (fake-kc; MANUAL if not extracted)
- **Связанный сценарий:** §1.4.4 (d), AC-3 (story 3)
- **Предусловия:** fake `kc.updateToken` rejects with `{error:'invalid_grant'}`, `kc.refreshToken` cleared (undefined), `online:true`; `sleep` spy.
- **Шаги:** call orchestrator.
- **Ожидаемый результат:** `kc.login` called **exactly once**, immediately; `sleep` called **0** times; no retry recursion.

### TC-PWA-018: Offline reject then reconnect+success — no eject during outage
- **Приоритет:** P1
- **Тип:** UNIT (fake-kc; MANUAL if not extracted)
- **Связанный сценарий:** §1.4.2 + §1.4.7, story 2
- **Предусловия:** attempt0 rejects while `navigator.onLine` fake=false (⇒ transient), attempt1 resolves true with online true; `sleep` no-op.
- **Ожидаемый результат:** `kc.login` **0** times; one `sleep(2000)`; token applied on success.

### TC-PWA-019: Both call-sites share ONE policy (no divergent copy-paste)
- **Приоритет:** P1
- **Тип:** STATIC
- **Связанный сценарий:** §1.4.6 (f), FR-AUTH-4
- **Шаги:** grep `frontend/src/auth/AuthProvider.tsx` — assert BOTH the interval site (`setInterval(...30000)`) and `kc.onTokenExpired = ...` invoke the same `refreshTokenOrLogin(kc, applyToken)` helper; assert `kc.login()` no longer appears *inside* the interval `.catch` or the `onTokenExpired` `.catch` (the two removed sites).
- **Ожидаемый результат:** exactly one `refreshTokenOrLogin` definition; both timer seams call it; the two old `.catch(() => kc.login())` / `.catch(() => { ...kc.login() })` bodies are gone.

### TC-PWA-020: Protected no-session login() sites REMAIN
- **Приоритет:** P0
- **Тип:** STATIC
- **Связанный сценарий:** §0.1 / §4.5 / §6 (protected `:172` handleSessionExpired, `:294` security-fallback)
- **Шаги:** grep `AuthProvider.tsx` — assert `kc.login()` still present in `handleSessionExpired` (401/403 bridge) and in the security-fallback effect.
- **Ожидаемый результат:** both protected `kc.login()` calls still exist. (Guards against over-zealous removal.)

### TC-PWA-021: applyToken success side-effect preserved verbatim
- **Приоритет:** P1
- **Тип:** STATIC
- **Связанный сценарий:** §1.4.5, §3.4 (`applyToken = () => { setToken(kc.token || null); if (kc.token) fetchAuthzContext(kc.token); }`)
- **Шаги:** grep `AuthProvider.tsx` for the `applyToken` definition.
- **Ожидаемый результат:** it contains `setToken(kc.token || null)` and `if (kc.token) fetchAuthzContext(kc.token)` — byte-equivalent to the pre-fix `.then` body; `onAuthRefreshSuccess` (`:275`) block still present and unchanged.

### TC-PWA-022: Every refreshPolicy export is consumed (noUnusedLocals guard)
- **Приоритет:** P1
- **Тип:** STATIC
- **Связанный сценарий:** §3.3 build-gate note, §4.3
- **Шаги:** grep `AuthProvider.tsx` for imports from `./refreshPolicy` — assert both `classifyRefreshFailure` and `REFRESH_RETRY_BACKOFF_MS` are imported AND referenced.
- **Ожидаемый результат:** both symbols imported and used (pre-empts the prod `noUnusedLocals` build failure that a written-but-unused export would cause).

### TC-PWA-023: Concurrent interval + onTokenExpired — no double-login on a live token
- **Приоритет:** P2
- **Тип:** UNIT (fake-kc; MANUAL if not extracted)
- **Связанный сценарий:** §1.4.9 (concurrent, no double-login)
- **Предусловия:** first `refreshTokenOrLogin` call refreshes the token (resolves true, sets `kc.token` valid); second call's `updateToken(60)` then sees a still-valid token → resolves `false` (no-op).
- **Ожидаемый результат:** across both concurrent chains `kc.login` called **0** times (live-token no-op dominates). Documents that correctness rests on the live-token no-op + `login()` navigation idempotency, NOT a new guard.

---

## D. Manifest — `frontend/public/manifest.webmanifest` (§1.1, §3.1)

### TC-PWA-024: Manifest file exists & is valid JSON
- **Приоритет:** P0
- **Тип:** STATIC
- **Связанный сценарий:** §1.1.1, FR-MAN-1
- **Шаги:** file exists at `frontend/public/manifest.webmanifest`; `JSON.parse` its contents (or `node -e` / `jq .`).
- **Ожидаемый результат:** file present; parses as valid JSON without error; `.webmanifest` extension.

### TC-PWA-025: Required install/standalone fields present with exact values
- **Приоритет:** P0
- **Тип:** STATIC
- **Связанный сценарий:** §1.1.1, §3.1, FR-MAN-2, AC-1
- **Шаги:** parse manifest; assert field values.
- **Ожидаемый результат:** `name==="Albusto"`, `short_name==="Albusto"`, `start_url==="/"`, **`scope==="/"`**, `display==="standalone"`, `background_color==="#fffdf9"`, `theme_color==="#fffdf9"`, `orientation==="portrait"`. (scope/start_url/display are the AC-1 heart.)

### TC-PWA-026: Icons array = 192/512/512-maskable with type+purpose
- **Приоритет:** P0
- **Тип:** STATIC
- **Связанный сценарий:** §1.1.4, §3.1, FR-MAN-3, §1.3.4
- **Шаги:** parse `manifest.icons`.
- **Ожидаемый результат:** exactly 3 entries: `{src:"/icons/icon-192.png", sizes:"192x192", type:"image/png", purpose:"any"}`, `{.../icon-512.png, "512x512", image/png, any}`, `{.../icon-512-maskable.png, "512x512", image/png, maskable}`. Every `type==="image/png"`; one `purpose:"maskable"` present.

### TC-PWA-027: apple-touch-icon-180 is NOT in manifest icons[]
- **Приоритет:** P2
- **Тип:** STATIC
- **Связанный сценарий:** §3.1 note ("iOS reads it from the `<link>`, not the manifest")
- **Шаги:** parse `manifest.icons`.
- **Ожидаемый результат:** no icon `src` references `apple-touch-icon-180.png` (it belongs in `index.html` only — a duplicate here is the documented anti-pattern).

### TC-PWA-028: Manifest src paths resolve to real files
- **Приоритет:** P1
- **Тип:** STATIC
- **Связанный сценарий:** §1.3.4 (each referenced path resolves)
- **Шаги:** for each `manifest.icons[].src`, strip leading `/` and check `frontend/public/<src>` exists.
- **Ожидаемый результат:** all 3 files exist on disk (no dangling reference).

---

## E. `index.html` `<head>` (§1.2, §3.2)

### TC-PWA-029: manifest link present, root-absolute
- **Приоритет:** P0
- **Тип:** STATIC
- **Связанный сценарий:** §1.1.1, §3.2, FR-META-1, AC-6
- **Шаги:** grep `frontend/index.html`.
- **Ожидаемый результат:** `<link rel="manifest" href="/manifest.webmanifest" />` present (href root-absolute, not relative).

### TC-PWA-030: Apple PWA meta trio present with exact content
- **Приоритет:** P0
- **Тип:** STATIC
- **Связанный сценарий:** §1.2.1–§1.2.3, §3.2, FR-META-1, AC-6
- **Шаги:** grep `index.html`.
- **Ожидаемый результат:** `apple-mobile-web-app-capable` content `yes`; `apple-mobile-web-app-status-bar-style` content **`default`** (NOT `black-translucent`); `apple-mobile-web-app-title` content `Albusto`.

### TC-PWA-031: theme-color == #fffdf9 (matches manifest)
- **Приоритет:** P1
- **Тип:** STATIC
- **Связанный сценарий:** §1.2.6, §3.2, AC-6/AC-7
- **Шаги:** grep `index.html`; cross-check manifest `theme_color`.
- **Ожидаемый результат:** `<meta name="theme-color" content="#fffdf9" />` present and equal to manifest `theme_color`.

### TC-PWA-032: apple-touch-icon link 180 present & path correct
- **Приоритет:** P0
- **Тип:** STATIC
- **Связанный сценарий:** §1.2.4, §3.2, FR-META-2, §1.3.4
- **Шаги:** grep `index.html`.
- **Ожидаемый результат:** `<link rel="apple-touch-icon" href="/icons/apple-touch-icon-180.png" />` present; the referenced file exists on disk.

### TC-PWA-033: viewport meta has viewport-fit=cover
- **Приоритет:** P0
- **Тип:** STATIC
- **Связанный сценарий:** §1.2.5, §3.2, FR-META-3, AC-6
- **Шаги:** grep `index.html` viewport meta.
- **Ожидаемый результат:** `content="width=device-width, initial-scale=1.0, viewport-fit=cover"` — `viewport-fit=cover` present; existing width/initial-scale preserved; only ONE viewport meta (replaced in place, not duplicated).

### TC-PWA-034: Existing head elements preserved (no regression)
- **Приоритет:** P2
- **Тип:** STATIC
- **Связанный сценарий:** §3.2, §4.1 backward-compat
- **Шаги:** grep `index.html`.
- **Ожидаемый результат:** `<meta charset="UTF-8" />`, `<link rel="icon" ... /vite.svg>`, and `<title>Albusto</title>` all still present. Nothing renamed/removed.

---

## F. Brand icons — pixel-dimension & existence (§1.3, §3.1)

### TC-PWA-035: Four PNGs exist at declared paths
- **Приоритет:** P1
- **Тип:** STATIC
- **Связанный сценарий:** §1.3.1, FR-ICON-2, AC-5
- **Шаги:** stat each: `frontend/public/icons/{icon-192.png, icon-512.png, icon-512-maskable.png, apple-touch-icon-180.png}`.
- **Ожидаемый результат:** all four exist and are non-empty.

### TC-PWA-036: PNG pixel dimensions match declarations (sips)
- **Приоритет:** P1
- **Тип:** STATIC
- **Связанный сценарий:** §1.3.1, §4.3, AC-5
- **Шаги:** `sips -g pixelWidth -g pixelHeight <file>` for each.
- **Ожидаемый результат:** `icon-192.png` = 192×192; `icon-512.png` = 512×512; `icon-512-maskable.png` = 512×512; `apple-touch-icon-180.png` = 180×180. (Each is a real PNG sips can read — proves valid raster, not an SVG/HTML placeholder.)

### TC-PWA-037: Source SVG committed but not runtime-referenced
- **Приоритет:** P3
- **Тип:** STATIC
- **Связанный сценарий:** §1.3.1 (`albusto-mark.svg` committed, not referenced)
- **Шаги:** file `frontend/public/icons/albusto-mark.svg` exists; grep manifest + index.html for `albusto-mark.svg`.
- **Ожидаемый результат:** source SVG present on disk; NOT referenced from `manifest.webmanifest` or `index.html`.

### TC-PWA-038: Maskable safe-zone — "A" not clipped under mask (visual)
- **Приоритет:** P1
- **Тип:** MANUAL
- **Связанный сценарий:** §1.3.3, AC-5 (≥20% safe inset)
- **Шаги:** open `icon-512-maskable.png`; overlay a circle + squircle mask (or install on Android/iOS and inspect the tile). Confirm the "A" sits inside the safe inset.
- **Ожидаемый результат:** the "A" is never clipped by circle/squircle/iOS masking; plate is full-bleed. *Manual because it is a visual/geometric judgment no static check captures.*

### TC-PWA-039: Icon renders Albusto "A" brand mark (never "Blanc")
- **Приоритет:** P2
- **Тип:** MANUAL
- **Связанный сценарий:** §1.3.2, product-name-albusto memory
- **Шаги:** visually inspect the 4 PNGs.
- **Ожидаемый результат:** capital "A" (near-white `#fffdf9`) on rounded ink plate (`#030213`); reads as a real app tile; the word "Blanc" appears **nowhere**. *Manual — visual brand judgment.*

---

## G. Build gate (§4.3)

### TC-PWA-040: `npm run build` exits 0 (tsc -b + vite, prod-strict)
- **Приоритет:** P0
- **Тип:** BUILD
- **Связанный сценарий:** §4.3, AC-4
- **Предусловия:** all frontend changes in place (refreshPolicy.ts + AuthProvider wiring + index.html + manifest + icons).
- **Шаги:** `cd frontend && npm run build`.
- **Ожидаемый результат:** exit code 0; no TS errors; **no `noUnusedLocals` failure** from any refreshPolicy export (couples to TC-PWA-022). `dist/manifest.webmanifest` and `dist/icons/*.png` emitted (public/ copied verbatim). *This is the only guaranteed automated CI gate — verify with `npm run build`, not `tsc --noEmit`.*

---

## H. Manual iOS on-device (§1.1.2, §1.2, §1.4) — owner-gated

> No automated iOS-standalone harness exists; these are unavoidably MANUAL and owner-gated (documented in requirements §"Verification note").

### TC-PWA-M1: Add-to-Home-Screen shows Albusto icon + name
- **Приоритет:** P1 · **Тип:** MANUAL · **Сценарий:** §1.1.4, §1.2.3, AC-5
- **Шаги:** on iPhone Safari, open `app.albusto.com` → Share → Add to Home Screen.
- **Ожидаемый результат:** proposed tile = the Albusto "A" letter-mark (NOT a page screenshot); label reads "Albusto".

### TC-PWA-M2: Launch is standalone (no Safari chrome)
- **Приоритет:** P0 · **Тип:** MANUAL · **Сценарий:** §1.2.1, AC-2
- **Шаги:** tap the installed Home-Screen icon.
- **Ожидаемый результат:** app opens full-screen standalone; no Safari address bar / toolbar; status bar = dark text on `#fffdf9`.

### TC-PWA-M3: Navigate Pulse→lead→job→Schedule→Settings stays in-window (no eject)
- **Приоритет:** P0 · **Тип:** MANUAL · **Сценарий:** §1.1.2, AC-1/AC-2
- **Шаги:** from launch, navigate across deep routes (`/pulse`, a lead `/leads/:id`, a job, `/schedule`, `/settings`).
- **Ожидаемый результат:** every route stays in the standalone window; NO SFSafariViewController overlay (no top bar / bottom toolbar / ✕ overlay) appears.

### TC-PWA-M4: Safe-area correct with viewport-fit=cover
- **Приоритет:** P1 · **Тип:** MANUAL · **Сценарий:** §1.2.5, AC-6
- **Шаги:** on a notched / Dynamic-Island device, inspect header, bottom nav, and any BottomSheet.
- **Ожидаемый результат:** layout extends to physical edges; existing `env(safe-area-inset-*)` gets non-zero insets — chrome sits correctly, nothing clipped under the notch/home-indicator.

### TC-PWA-M5: Transient blip mid-session does NOT eject (retry heals)
- **Приоритет:** P0 · **Тип:** MANUAL · **Сценарий:** §1.4.2, story 2, AC-2/AC-3
- **Шаги (how to force):** open the standalone app; toggle Airplane Mode briefly (or throttle) so a `updateToken` interval tick fails transiently, then restore connectivity within the ~17s budget.
- **Ожидаемый результат:** no flash to `auth.albusto.com`, no SFSafariViewController; the app self-heals on reconnect and stays standalone.

### TC-PWA-M6: Token-expiry mid-session does NOT eject on a still-refreshable session
- **Приоритет:** P1 · **Тип:** MANUAL · **Сценарий:** §1.4.1/§1.4.5, AC-3
- **Шаги (how to force — hard to force):** leave the app **backgrounded past the access-token lifetime** (accessTokenLifespan 300s) but within the refresh-token window, then foreground it; the resume handler + interval fire `updateToken`.
- **Ожидаемый результат:** token silently refreshes; user stays in the standalone window; NO full redirect. *Genuinely hard to force deterministically — note the backgrounding method; this is why the decision seam (TC-PWA-014/015) is unit-tested instead of relying on manual.*

### TC-PWA-M7: Genuinely dead session STILL redirects to login exactly once
- **Приоритет:** P1 · **Тип:** MANUAL · **Сценарий:** §1.4.4, story 3, AC-3
- **Шаги (how to force):** revoke/expire the session server-side (or leave backgrounded past the **refresh** token lifetime), then foreground.
- **Ожидаемый результат:** the app performs ONE deliberate `kc.login()` redirect to `auth.albusto.com`; after sign-in returns to the app. (The one legitimate eject — must still work.)

### TC-PWA-M8: Desktop & normal Safari tab unaffected (backward compat)
- **Приоритет:** P2 · **Тип:** MANUAL · **Сценарий:** §4.1, AC-7
- **Шаги:** open `app.albusto.com` in a desktop browser and a normal (non-installed) mobile Safari tab; exercise auth + navigation.
- **Ожидаемый результат:** unchanged layout and auth behavior; Apple meta ignored harmlessly; push SW (`sw-push.js`) + SSE unaffected.

---

## I. Deploy / prod content-type (§5) — DEPLOY gate

> Run post-deploy against prod. These are the make-or-break checks: if the manifest returns `text/html`, iOS silently ignores it and the whole fix is **inert on prod**. Owner-gated deploy.

### TC-PWA-D1: /manifest.webmanifest served as application/manifest+json (NOT text/html)
- **Приоритет:** P0 · **Тип:** DEPLOY · **Сценарий:** §5, deploy constraint
- **Шаги:** `curl -sI https://app.albusto.com/manifest.webmanifest | grep -i content-type`.
- **Ожидаемый результат:** `content-type: application/manifest+json`. **FAIL if `text/html`** (SPA catch-all swallowed it → add `.webmanifest` MIME to Caddy). Also `curl -s .../manifest.webmanifest | head -c 40` starts with `{ "name": "Albusto"` (real JSON, not index.html).

### TC-PWA-D2: /icons/*.png served as image/png (NOT text/html)
- **Приоритет:** P0 · **Тип:** DEPLOY · **Сценарий:** §5
- **Шаги:** `curl -sI` each of `/icons/icon-192.png`, `/icons/icon-512.png`, `/icons/icon-512-maskable.png`, `/icons/apple-touch-icon-180.png` | grep content-type.
- **Ожидаемый результат:** each `content-type: image/png` (none `text/html`).

### TC-PWA-D3: Manifest body is the real JSON, not the SPA index.html
- **Приоритет:** P1 · **Тип:** DEPLOY · **Сценарий:** §5
- **Шаги:** `curl -s https://app.albusto.com/manifest.webmanifest | head -c 40`.
- **Ожидаемый результат:** output begins with `{` and contains `"name": "Albusto"` (proves file_server matched before the `try_files … /index.html` fallback).

### TC-PWA-D4: apple-touch-icon reachable at its linked path
- **Приоритет:** P1 · **Тип:** DEPLOY · **Сценарий:** §5, §1.2.4
- **Шаги:** `curl -sI https://app.albusto.com/icons/apple-touch-icon-180.png`.
- **Ожидаемый результат:** HTTP 200, `content-type: image/png` (the exact path `index.html` links resolves on prod).

---

## Матрица покрытия FR / AC → TC

| Requirement | TC ids |
|---|---|
| FR-MAN-1 (ship manifest) | TC-PWA-024, -029, D1, D3 |
| FR-MAN-2 (install/standalone fields) | TC-PWA-025 |
| FR-MAN-3 (icons array) | TC-PWA-026, -028 |
| FR-META-1 (manifest+Apple capability) | TC-PWA-029, -030 |
| FR-META-2 (theme-color + apple-touch-icon) | TC-PWA-031, -032, D4 |
| FR-META-3 (viewport-fit=cover) | TC-PWA-033 |
| FR-ICON-1 (4 PNGs, brand) | TC-PWA-035, -036, -038, -039 |
| FR-ICON-2 (placement & wiring) | TC-PWA-028, -032, -037 |
| FR-AUTH-1 (no redirect on transient) | TC-PWA-001, -007, -008, -011, -015, -016, -018, M5 |
| FR-AUTH-2 (redirect only when dead) | TC-PWA-002..006, -017, M7 |
| FR-AUTH-3 (silent success unchanged) | TC-PWA-015, -021 |
| FR-AUTH-4 (single shared policy) | TC-PWA-019 |
| AC-1 (scope covers all routes) | TC-PWA-025, M3 |
| AC-2 (no eject on standalone nav) | TC-PWA-016, -017, M2, M3, M5 |
| AC-3 (live never full-redirects; dead once) | TC-PWA-014..018, -023, M5, M6, M7 |
| AC-4 (build green) | TC-PWA-040, -022 |
| AC-5 (icons valid & branded) | TC-PWA-026, -035, -036, -038, -039, M1 |
| AC-6 (meta present) | TC-PWA-029..033 |
| AC-7 (backward compatible) | TC-PWA-031, -034, M8 |
| Deploy constraint (§5) | TC-PWA-D1..D4 |

### ACs coverable ONLY manually (+ why)

- **AC-2** (no SFSafariViewController eject on standalone navigation) — the eject is an iOS-runtime standalone-window behavior with no DOM/JS signal a headless harness can read; the *decision* that avoids it is unit-tested (TC-PWA-014/015/016/017), but the end-to-end "no eject" is **TC-PWA-M2/M3/M5 (MANUAL, owner-gated)**.
- **AC-5 visual half** (branded, non-clipped) — pixel dims are STATIC (TC-PWA-036) but "reads as the Albusto A / safe-zone not clipped / no Blanc" is a visual judgment → **TC-PWA-M1/-038/-039 (MANUAL)**.
- **AC-6 safe-area effect** — presence of `viewport-fit=cover` is STATIC (TC-PWA-033), but that insets actually become non-zero on a notched device is **TC-PWA-M4 (MANUAL)**.
- **§5 deploy content-type** — only observable against a running prod host → **DEPLOY (TC-PWA-D1..D4)**, owner-gated.

### Not applicable (documented, per agent-04 checklist)

- **401/403 middleware, cross-tenant data-isolation, direct-access-by-foreign-id (404-not-200), company_id SQL filtering** — **N/A**: PWA-FIX-001 is frontend-only; it adds no backend route, no DB query, no `company_id` surface (spec §2: "No backend route, SSE event, or DB/company-isolation surface is involved"). The auth change touches only the client-side Keycloak silent-refresh branch, not any server authorization. These otherwise-mandatory API tests have no target here.
