# Спецификация: PWA-FIX-001 — keep the installed Albusto PWA standalone on iOS (stop the SFSafariViewController eject)

**Status:** Spec · **Type:** bug-fix + hardening, **frontend only** (`frontend/`, Vite + React SPA) · **NO backend, NO migration** (count stays 155)
**Source of truth:** `## PWA-FIX-001` in `Docs/requirements.md` (FR-MAN-1..3, FR-META-1..3, FR-ICON-1..2, FR-AUTH-1..4; AC-1..7) + `## PWA-FIX-001` in `Docs/architecture.md` (file map, exact manifest JSON, head order, `refreshPolicy.ts` design, icon commands, Caddy constraint).
**On conflict, real code wins** — §0 records the verification. Section numbers (§1.1…) are stable anchors for Test-Cases (agent 04) and Planner (agent 05).

### Общее описание

An "Add to Home Screen"-installed `app.albusto.com` on iOS must launch and stay in a full-screen **standalone** window across all client-side navigation. Today it ejects into an in-app `SFSafariViewController` (its own chrome + different safe-area insets = "broken layout"). Two reinforcing triggers: (1) **no manifest with `scope`** ships, so iOS has no standalone contract; (2) both silent-refresh reject-sites in `AuthProvider.tsx` fire `kc.login()` (a full cross-origin redirect to `auth.albusto.com`) on **any** `updateToken` failure — including a transient network blip. The fix ships a scoped manifest + Apple/PWA `<head>` meta + brand PNG icons, and reroutes the two `.catch` sites through one shared policy that **retries transient failures and redirects only on a genuinely dead session**.

---

## §0. Ground truth — verified against real code (2026-07-07)

Code was read and confirms the architecture's line references. **No discrepancies found** that change the design; two clarifications noted.

### §0.1 `frontend/src/auth/AuthProvider.tsx` — the two catch-sites (exact current code)

Both live inside the `kc.init(...).then(async (auth) => { if (auth) { ... } })` block. Exact lines:

**Interval site — `AuthProvider.tsx:261-266`** (the `kc.login()` to remove is line **264**):
```ts
setInterval(() => {
    kc.updateToken(60).catch(() => {
        console.warn('[Auth] Token refresh failed, redirecting to login');
        kc.login();
    });
}, 30000);
```

**`onTokenExpired` site — `AuthProvider.tsx:268-273`** (the `kc.login()` to remove is inside the `.catch` on line **272**):
```ts
kc.onTokenExpired = () => {
    kc.updateToken(60).then(() => {
        setToken(kc.token || null);
        if (kc.token) fetchAuthzContext(kc.token);
    }).catch(() => kc.login());
};
```

**Success side-effect (the `applyToken` body to preserve verbatim)** = the two statements currently inside the `onTokenExpired` `.then` (`:270-271`): `setToken(kc.token || null); if (kc.token) fetchAuthzContext(kc.token);`. This matches the initial-load success path (`:253` `setToken`, `:257-259` `fetchAuthzContext`).

**`onAuthRefreshSuccess` — `AuthProvider.tsx:275-277` (UNTOUCHED):**
```ts
kc.onAuthRefreshSuccess = () => {
    setToken(kc.token || null);
};
```

**Keycloak singleton:** `getKeycloak()` (`:86-95`) returns a module-scope singleton; `kc.updateToken`, `kc.token`, `kc.refreshToken`, `kc.login()` are all called on it. `fetchAuthzContext` (`:190-208`) is an async closure over React setters — reachable from a module-scope helper only if passed in as a callback (hence the `onRefreshed`/`applyToken` seam in §4).

**Protected `kc.login()` sites that MUST remain (no-session redirects, not refresh-failure):**
- `AuthProvider.tsx:172` — `handleSessionExpired` (401/403 event bridge from API interceptors).
- `AuthProvider.tsx:294` — security fallback effect (init resolved/threw without a session).

Also present and untouched: `refreshOnResume` visibility/focus handler (`:303-319`, AUTH-SESSION-001) which already does a best-effort `updateToken(60)` with a swallowed catch (`:311`) — it does NOT call `kc.login()`, so it needs no change; the interval/`onTokenExpired` policy is its recovery net.

### §0.2 `frontend/index.html` — current state (13 lines, confirmed)

```html
<meta charset="UTF-8" />
<link rel="icon" type="image/svg+xml" href="/vite.svg" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Albusto</title>
```
No `<link rel="manifest">`, no Apple meta, no `theme-color`, no `apple-touch-icon`, no `viewport-fit`. Confirmed missing → all additive.

### §0.3 `frontend/public/` — current state (confirmed)

Contains exactly `sse-debug.html`, `sw-push.js`, `vite.svg`. No manifest, no `icons/` directory. `sw-push.js` (push SW, scope `/`) is present and **protected**.

### §0.4 No existing spec (duplication check)

`Docs/specs/` has no PWA/manifest/install spec. Not a duplicate. Adjacent-but-distinct: MOBILE-NO-SOFTPHONE-001 (softphone desktop-only), MOBILE-TECH-APP-001 (a *native* iOS app in a separate repo), and the push SW (`sw-push.js`) — all orthogonal.

### §0.5 Clarifications (non-blocking)

- The architecture's "interval `.catch` at `:264`" refers to the `kc.login()` **line** (264); the `.catch(` opens on line 262. The `onTokenExpired` `.catch(() => kc.login())` is one expression on line 272. Both match.
- `refreshPolicy.ts` and the maskable source (`albusto-mark-maskable.svg`, if the Implementer uses two files) do not yet exist — they are new per the file map.

---

## §1. Behavior scenarios (Given / When / Then)

### §1.1 Manifest & scope

- **§1.1.1 Manifest ships & is valid.** *Given* the built site, *when* a client requests `/manifest.webmanifest`, *then* a real file is served (in prod, `content-type: application/manifest+json` — see §5) whose body is valid JSON containing `name`,`short_name`,`start_url`,`scope`,`display`,`background_color`,`theme_color`,`orientation`,`icons[]` (exact copy in §3.1). Referenced from `index.html` via `<link rel="manifest" href="/manifest.webmanifest">`.
- **§1.1.2 Scope covers every route.** *Given* `scope:"/"` and SPA = React Router `BrowserRouter` with all navigation client-side (`/` → `<Navigate>` to `/pulse`), *when* the installed PWA navigates to `/pulse`, a lead, a job, `/schedule`, `/settings`, any deep route (`/leads/:id`), *then* every URL is prefix-matched by `scope:"/"` and stays **in the standalone window** — iOS does not treat it as an out-of-scope navigation and does not open Safari. (AC-1.)
- **§1.1.3 start_url launches Pulse.** *Given* `start_url:"/"`, *when* the user taps the Home-Screen icon, *then* the app loads `/` which client-redirects to `/pulse`, in-window.
- **§1.1.4 Install-prompt fields.** *Given* `name`/`short_name` = "Albusto", `icons[]` with a 192 and a 512, `display:"standalone"`, *then* an install prompt / Home-Screen entry shows "Albusto" + the branded icon (not a page screenshot). (AC-5.)

### §1.2 Apple / PWA `<head>` meta

- **§1.2.1 Standalone launch capability.** *Given* `<meta name="apple-mobile-web-app-capable" content="yes">`, *when* the site is added to the Home Screen on iOS, *then* it launches full-screen standalone (no Safari address bar / toolbar). (Pairs with the manifest for AC-2.)
- **§1.2.2 Status-bar style.** *Given* `<meta name="apple-mobile-web-app-status-bar-style" content="default">`, *when* the standalone app is open, *then* the status bar shows dark text on the light `#fffdf9` surface (NOT `black-translucent`, which would draw content under the bar and fight the app's own safe-area handling).
- **§1.2.3 App title.** *Given* `<meta name="apple-mobile-web-app-title" content="Albusto">`, *then* the Home-Screen label reads "Albusto".
- **§1.2.4 apple-touch-icon.** *Given* `<link rel="apple-touch-icon" href="/icons/apple-touch-icon-180.png">` (180×180), *when* installed, *then* iOS uses that PNG as the Home-Screen tile (iOS reads apple-touch-icon from the `<link>`, **not** from the manifest `icons[]`).
- **§1.2.5 viewport-fit=cover / safe-area.** *Given* the viewport meta becomes `width=device-width, initial-scale=1.0, viewport-fit=cover`, *when* standalone on a notched/Dynamic-Island device, *then* the layout extends to the physical edges and the app's existing `env(safe-area-inset-*)` usage (AppLayout.css, BottomSheet.tsx) receives non-zero insets — chrome sits correctly. (AC-6.)
- **§1.2.6 theme-color.** *Given* `<meta name="theme-color" content="#fffdf9">` matching manifest `theme_color`, *then* the standalone status-bar backdrop / UI accent uses the warm surface. Desktop & normal Safari tabs ignore all Apple meta and read theme-color harmlessly (AC-7).

### §1.3 Brand icons

- **§1.3.1 Four PNGs at exact sizes.** *Given* the build, *then* these valid PNGs exist at their declared pixel dimensions: `icon-192.png` (192×192), `icon-512.png` (512×512), `icon-512-maskable.png` (512×512), `apple-touch-icon-180.png` (180×180). Source `albusto-mark.svg` (512 viewBox) is committed but **not referenced** at runtime. (AC-5.)
- **§1.3.2 Brand mark.** *Given* the icon art = capital "A" (near-white `#fffdf9`) on a rounded-square ink plate (`#030213`, `rx≈112`), *then* it reads as a real app tile (inverse of the on-canvas UI). Product identity = **Albusto** only (never render "Blanc").
- **§1.3.3 Maskable safe-zone.** *Given* `icon-512-maskable.png` places the "A" inside a **≥20% safe inset** on a full-bleed plate, *when* Android circle/squircle or iOS masking crops it, *then* the "A" is never clipped. (AC-5, manual.)
- **§1.3.4 Correct references.** *Given* the manifest `icons[]` lists 192 / 512 / 512-maskable and `index.html` links apple-touch-180, *then* each referenced path resolves to the matching file; no icon is referenced from the wrong surface.

### §1.4 Auth "no-eject" (behavioral heart)

The two reject-sites share ONE policy backed by the pure `classifyRefreshFailure` (§4.3). Enumerated refresh outcomes:

- **§1.4.1 (a) Live token — no-op, no redirect.** *Given* a still-valid access token, *when* the 30s interval (or `onTokenExpired`) calls `updateToken(60)`, *then* it resolves `refreshed=false` (no HTTP call needed), `applyToken` runs at most a harmless no-op, and **no `kc.login()`** fires. Standalone preserved.
- **§1.4.2 (b) Transient network failure — retry, silent, NO redirect.** *Given* `navigator.onLine === false` OR an ambiguous/empty rejection with a still-present `kc.refreshToken`, *when* `updateToken(60)` rejects, *then* `classifyRefreshFailure` returns `'transient'`, the helper `sleep`s `REFRESH_RETRY_BACKOFF_MS[attempt]` (2000 / 5000 / 10000 ms) and retries. **No redirect.** The standalone window is never left. (AC-3.)
- **§1.4.3 (c) Retries exhausted — single redirect.** *Given* every attempt (attempts 0..3, i.e. after the 3 backoff waits) still rejects as transient, *when* `attempt >= REFRESH_RETRY_BACKOFF_MS.length` (== 3), *then* the helper falls through to **exactly one** `kc.login()` and returns. Bounded (~17s total), self-terminating — never an infinite loop. (AC-3.)
- **§1.4.4 (d) Dead session — immediate single redirect.** *Given* a genuinely dead refresh (`navigator.onLine === true` AND `kc.refreshToken` is undefined/empty, OR the error text matches a DEAD_GRANT pattern — `invalid_grant`, "session not active", "token expired", "refresh token"), *when* `updateToken(60)` rejects, *then* `classifyRefreshFailure` returns `'dead'` and the helper fires **exactly one** `kc.login()` immediately (no retry) — the one legitimate cross-origin re-auth. (AC-3, story 3.)
- **§1.4.5 (e) Success after retry — token applied as before.** *Given* attempt N (N≥1) resolves after prior transient rejects, *when* `updateToken` returns `refreshed=true`, *then* `onRefreshed`/`applyToken` runs **exactly as today**: `setToken(kc.token || null)` then `if (kc.token) fetchAuthzContext(kc.token)`. No user-visible interruption. `onAuthRefreshSuccess` (`:275`) still fires on Keycloak's own refresh event. (AC-3, FR-AUTH-3.)
- **§1.4.6 (f) Both call-sites share ONE policy.** *Given* both the interval site and the `onTokenExpired` site call `void refreshTokenOrLogin(kc, applyToken)`, *then* their transient-vs-dead behavior is byte-identical — the decision is defined once (FR-AUTH-4). No divergent copy-paste.

**Edge cases (auth):**
- **§1.4.7 Offline flag dominates.** `navigator.onLine === false` ⇒ `'transient'` regardless of error content or refresh-token presence (an offline blip must never redirect).
- **§1.4.8 Ambiguous / empty error ⇒ transient.** A rejection of `undefined`, `{}`, or an `Error` with no grant signal (while online, refresh token present) ⇒ `'transient'` — never eject on ambiguity. Such a genuinely-dead-but-silent session is still caught by retry-budget exhaustion (§1.4.3) → one redirect after ~17s.
- **§1.4.9 Concurrent interval + `onTokenExpired` (no double-login).** *Given* both fire close together, *then* the FIRST successful `updateToken` refreshes the token so the SECOND `updateToken(60)` sees a still-valid token and no-ops (§1.4.1) — no second redirect. On a genuinely dead session both chains would independently reach `kc.login()`; `kc.login()` is a browser navigation (idempotent — the second navigation replaces the first in-flight redirect), so the user is not double-logged-in. The pre-existing `loginPending` guard (`:168`) covers only the 401/403 event path, not these two sites; correctness here rests on the live-token no-op + `kc.login()` navigation idempotency. **No new guard is required**, but the Implementer MUST NOT reintroduce an unbounded retry that could stack across the 30s interval (mitigated because a live token makes `updateToken(60)` a no-op — §1.4.1).

---

## §2. Component interaction

- `frontend/index.html` `<head>` → `<link rel="manifest" href="/manifest.webmanifest">` → browser fetches `/manifest.webmanifest` (static, `public/`) → iOS reads `scope`/`display`/`icons`.
- `index.html` → `<link rel="apple-touch-icon" href="/icons/apple-touch-icon-180.png">` → iOS Home-Screen tile.
- `AuthProvider.tsx` (impure orchestrator `refreshTokenOrLogin`) → imports `classifyRefreshFailure` + `REFRESH_RETRY_BACKOFF_MS` from `frontend/src/auth/refreshPolicy.ts` (pure) → on success calls `applyToken` closure (`setToken` + `fetchAuthzContext`) → on dead/exhausted calls `getKeycloak().login()`.
- Both timer seams (interval, `onTokenExpired`) → single `refreshTokenOrLogin(kc, applyToken)` call.
- **No** backend route, SSE event, or DB/company-isolation surface is involved (frontend-only; no `company_id` filtering applies).

---

## §3. Contracts

### §3.1 Canonical manifest JSON — `frontend/public/manifest.webmanifest`

```json
{
  "name": "Albusto",
  "short_name": "Albusto",
  "start_url": "/",
  "scope": "/",
  "display": "standalone",
  "background_color": "#fffdf9",
  "theme_color": "#fffdf9",
  "orientation": "portrait",
  "icons": [
    { "src": "/icons/icon-192.png", "sizes": "192x192", "type": "image/png", "purpose": "any" },
    { "src": "/icons/icon-512.png", "sizes": "512x512", "type": "image/png", "purpose": "any" },
    { "src": "/icons/icon-512-maskable.png", "sizes": "512x512", "type": "image/png", "purpose": "maskable" }
  ]
}
```
- `theme_color`/`background_color` = **`#fffdf9`** (warm near-white `--blanc-surface-strong`, matches the top-of-page surface — NOT `#030213`, which is ink).
- `apple-touch-icon-180.png` is **NOT** in `icons[]` (iOS reads it from the `<link>`).
- `orientation:"portrait"` (portrait-first CRM; harmless on desktop/tablet). `id` omitted (defaults to `start_url`).

### §3.2 `index.html` `<head>` — exact tag list & order

Replace the existing `viewport` meta in place; add the rest. Root-absolute hrefs (never relative — a relative href breaks on deep routes like `/leads/:id`). Final order:
```html
<meta charset="UTF-8" />
<link rel="icon" type="image/svg+xml" href="/vite.svg" />
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
<link rel="manifest" href="/manifest.webmanifest" />
<meta name="theme-color" content="#fffdf9" />
<meta name="apple-mobile-web-app-capable" content="yes" />
<meta name="apple-mobile-web-app-status-bar-style" content="default" />
<meta name="apple-mobile-web-app-title" content="Albusto" />
<link rel="apple-touch-icon" href="/icons/apple-touch-icon-180.png" />
<title>Albusto</title>
```

### §3.3 `refreshPolicy.ts` — exported API (pure module)

```ts
export const REFRESH_RETRY_BACKOFF_MS = [2000, 5000, 10000] as const; // length = max retries (3)

export type RefreshFailureKind = 'transient' | 'dead';

export interface RefreshFailureInput {
  hasRefreshToken: boolean; // kc.refreshToken AFTER the failed updateToken (undefined ⇒ adapter gave up ⇒ dead)
  online: boolean;          // navigator.onLine at failure time (false ⇒ transient)
  error: unknown;           // the rejection keycloak handed us (may be undefined / {} / Error)
}

export function classifyRefreshFailure(input: RefreshFailureInput): RefreshFailureKind;
```
Internal helper `extractErrorText(error: unknown): string` pulls `.error` / `.error_description` / `.message` / `String()`; returns `''` when the error is undefined/`{}`. `DEAD_GRANT_PATTERNS` = `[/invalid_grant/i, /session[_\s-]*not[_\s-]*active/i, /token[_\s-]*(is[_\s-]*)?expired/i, /refresh[_\s-]*token/i]`.

**Build-gate note:** every export (`REFRESH_RETRY_BACKOFF_MS`, `classifyRefreshFailure`, and the types as needed) MUST be consumed by `AuthProvider.tsx` — prod `noUnusedLocals` fails otherwise (§4 NFR).

#### §3.3.1 Classifier truth-table (canonical — this is the spec of `classifyRefreshFailure`)

Rule order: (1) offline ⇒ transient; (2) no refresh token ⇒ dead; (3) error text matches a DEAD_GRANT pattern ⇒ dead; (4) otherwise ⇒ transient. Bias: **ambiguous ⇒ transient** (never eject on ambiguity).

| # | `online` | `hasRefreshToken` | `error` (extracted text) | ⇒ Result | Rationale |
|---|----------|-------------------|--------------------------|----------|-----------|
| 1 | `false`  | any               | any                      | `transient` | offline blip — retry (rule 1 short-circuits) |
| 2 | `true`   | `false`           | any                      | `dead`      | adapter cleared refresh token ⇒ real expiry |
| 3 | `true`   | `true`            | `"invalid_grant"`        | `dead`      | grant signal from token endpoint |
| 4 | `true`   | `true`            | `"session not active"`   | `dead`      | Keycloak session-expiry signal |
| 5 | `true`   | `true`            | `"token expired"`        | `dead`      | expiry signal |
| 6 | `true`   | `true`            | `"...refresh token..."`  | `dead`      | refresh-token signal |
| 7 | `true`   | `true`            | `""` (undefined / `{}`)  | `transient` | empty reject ⇒ retry (never eject on ambiguity) |
| 8 | `true`   | `true`            | non-matching text        | `transient` | generic error ⇒ retry |

### §3.4 `refreshTokenOrLogin` — impure orchestrator (module-scope in `AuthProvider.tsx`)

```ts
async function refreshTokenOrLogin(
  kc: Keycloak,
  onRefreshed: () => void,   // applyToken: setToken(kc.token||null) + (kc.token ? fetchAuthzContext(kc.token) : void)
  attempt = 0,
): Promise<void>;
```
- Calls `kc.updateToken(60)`; on resolve, `if (refreshed || attempt === 0) onRefreshed()`.
- On reject: `classifyRefreshFailure({ hasRefreshToken: !!kc.refreshToken, online: navigator.onLine, error: err })`; if `'dead'` OR `attempt >= REFRESH_RETRY_BACKOFF_MS.length` ⇒ `kc.login()` and return; else `await sleep(REFRESH_RETRY_BACKOFF_MS[attempt])` then recurse `attempt+1`.
- Wiring — interval: `setInterval(() => { void refreshTokenOrLogin(kc, applyToken); }, 30000)`; `onTokenExpired`: `kc.onTokenExpired = () => { void refreshTokenOrLogin(kc, applyToken); }`.
- `applyToken = () => { setToken(kc.token || null); if (kc.token) fetchAuthzContext(kc.token); }`.
- `sleep = (ms:number) => new Promise(r => setTimeout(r, ms))` — local; kept impure in the provider (the *decision* stays pure in `refreshPolicy.ts`).
- **Testability recommendation:** extract `refreshTokenOrLogin` to a module with `sleep` injectable so AC-3 (dead OR exhausted ⇒ exactly one `login()`; N transient then success ⇒ zero `login()`) is a unit test, not just manual.

---

## §4. Non-functional requirements

- **§4.1 Backward compatible (additive).** Desktop browsers & ordinary mobile Safari tabs ignore Apple meta and read the manifest without behavior change; icon files are new; nothing existing is renamed/removed. The auth change touches **only** the two `.catch` branches — the happy path (valid token / clean refresh) is byte-for-byte the same, and a genuinely dead session STILL redirects exactly once. (AC-7, stories 3 & 5.)
- **§4.2 Bounded, self-terminating retry.** Max 3 retries (2/5/10s ≈ 17s ceiling) per reject event; live token makes `updateToken(60)` a no-op so the 30s interval never stacks. **Never an infinite loop.** Existing safety nets (interval, `onTokenExpired`, 401-interceptor `handleSessionExpired`) remain.
- **§4.3 Build gate.** `npm run build` (`tsc -b` + vite) stays green, incl. prod-strict `noUnusedLocals` — every `refreshPolicy.ts` export must be consumed. Manifest = valid JSON, `.webmanifest` extension. Icons = valid PNGs at declared pixel sizes (`sips -g pixelWidth -g pixelHeight`). (AC-4.) *House lesson: verify with `npm run build`, not just `tsc --noEmit`.*
- **§4.4 No backend / migration / new runtime dep.** Migration count stays 155. `librsvg` is a **local build-time tool only** (icons committed as static PNGs; prod Docker needs no `librsvg`). No secrets, no new app dependency.
- **§4.5 Protected — must not break.** Keycloak init options (`pkceMethod:'S256'`, `onLoad:'login-required'`, `checkLoginIframe:false`), the silent-refresh mechanism itself, `onAuthRefreshSuccess` (`:275`), `fetchAuthzContext`-on-token-update, the genuine no-session redirects (`:172`, `:294`), `sw-push.js` (push SW, scope `/`) + `pushNotificationService.ts`, SSE bridge, `authedFetch.ts`, desktop/normal-tab behavior, MOBILE-NO-SOFTPHONE-001.

---

## §5. Deploy constraint (owner/deploy step — NOT code in this feature; REQUIRED for the fix to work on prod)

Prod static serving (Caddy, `/etc/caddy/Caddyfile`) MUST return `/manifest.webmanifest` as a **real file with `content-type: application/manifest+json`** and `/icons/*.png` as `image/png` — i.e. matched by the static `file_server` **BEFORE** the SPA `try_files … /index.html` catch-all. If `/manifest.*` returns `text/html` (current behavior), iOS silently ignores the manifest and the fix is **inert on prod**. Vite copies `public/` into `dist/` verbatim, so a `file_server` with `try_files {path} /index.html` already serves the real file first — but the `.webmanifest` MIME may need adding to Caddy's MIME map. **Flag at deploy; no repo change here.**

**Post-deploy curl checks (run against prod):**
```bash
# manifest must be application/manifest+json (NOT text/html):
curl -sI https://app.albusto.com/manifest.webmanifest | grep -i content-type
# expect: content-type: application/manifest+json

# icons must be image/png (NOT text/html):
curl -sI https://app.albusto.com/icons/icon-192.png            | grep -i content-type
curl -sI https://app.albusto.com/icons/icon-512.png            | grep -i content-type
curl -sI https://app.albusto.com/icons/icon-512-maskable.png   | grep -i content-type
curl -sI https://app.albusto.com/icons/apple-touch-icon-180.png| grep -i content-type
# expect each: content-type: image/png

# manifest body is real JSON (not the SPA index.html):
curl -s https://app.albusto.com/manifest.webmanifest | head -c 40   # expect it to start with {  "name": "Albusto" ...
```

---

## §6. Out of scope / protected

- **`frontend/public/sw-push.js`** — push service worker (scope `/`), untouched; a manifest neither registers nor claims a service worker. No offline/app-shell/fetch-handling SW in this feature.
- **Backend, Caddy code, DNS, migrations** — none (the Caddy MIME step in §5 is a deploy action, not a repo change).
- **Genuine no-session `kc.login()`** at `AuthProvider.tsx:172` (401/403 bridge) and `:294` (security fallback) — must remain.
- **Auth flow rework** beyond the transient-vs-dead branch: login screen, session lifetimes, Keycloak realm, PKCE init — unchanged.
- **Android/Chrome install polish, push-notification changes** — beyond what the same manifest already yields.

---

## §7. Acceptance-criteria trace

| AC | Covered by |
|----|-----------|
| AC-1 scope covers all routes | §1.1.2, §3.1 |
| AC-2 no eject on standalone nav | §1.1.2, §1.2.1, §1.4.2 |
| AC-3 live session never full-redirects; dead redirects once | §1.4.1–§1.4.5, §3.3.1, §3.4 |
| AC-4 build green | §4.3 |
| AC-5 icons valid & branded | §1.3.1–§1.3.4 |
| AC-6 meta present | §1.2, §3.2 |
| AC-7 backward compatible | §4.1, §4.5 |
