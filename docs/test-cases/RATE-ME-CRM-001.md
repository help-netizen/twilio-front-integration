# Test Cases: RATE-ME-CRM-001 — multi-tenant Rate Me (tokens, public rating page, dedicated + custom-domain hosting, marketplace settings)

**Spec (AUTHORITATIVE):** `Docs/specs/RATE-ME-CRM-001.md` (85 scenarios: T1–T10, P1–P19, H1–H12, D1–D19, S1–S10, U1–U11, C1–C4; pinned decisions PD-1…PD-10; §3 isolation matrix; §5 exact contracts; §8 invariants 1–20). **Architecture:** `Docs/architecture.md` §RATE-ME-CRM-001 (D0–D9 + test seams, line 7490+). **Requirements:** `Docs/requirements.md` §RATE-ME-CRM-001 (US-1..8, FR-1..14, NFR-1..10, line 6484+).
**Builds on:** RELY-LEADS-SETTINGS-001 cases (`Docs/test-cases/RELY-LEADS-SETTINGS-001.md`) — their suites are the S1/S2 byte-identical pin and re-run UNCHANGED; SEND-DOC-001 public-token cases (`tests/publicEstimates.test.js` — the `/api/public` precedent suite, stays green as-is).

## Locked design facts these cases assert against (from spec/arch — do not re-litigate)

1. **Token:** `crypto.randomBytes(24)` → base64url, 32 chars; guard `RATE_TOKEN_RE = /^[A-Za-z0-9_-]{22,64}$/` runs BEFORE any DB read; minted tokens match `/^[A-Za-z0-9_-]{32}$/`; unique-violation retry ≤3 then honest 500 (T6/NFR-1). Estimate 64-bit mint explicitly NOT copied.
2. **Uniform 404 (exact body):** `404 {ok:false,error:{code:'NOT_FOUND',message:'Invalid link'}}` — byte-identical for ALL FIVE public failure classes: malformed / unknown / expired / foreign-host / app-disconnected (NFR-2; invariant 1 = deep-equal quintet). Gate 404s are DIFFERENT: `/api/*` → `{ok:false,error:{code:'NOT_FOUND',message:'Not found'}}`, page paths → plain-text `Not found` (H3).
3. **Identity rule zero:** company/job/tech identity derives ONLY from the token row; Host can only CONSTRAIN resolution (`AND ($2::uuid IS NULL OR t.company_id = $2)` INSIDE `getTokenContext`, never a post-filter); request body NEVER contributes identity (P14, invariant 2). §3 matrix (5 host classes × 6 token classes) is authoritative for every combination.
4. **GET DTO = exactly 5 keys:** `{company_name, company_logo_url, technician_name, already_rated, five_star_redirect}` — a 6th key is a spec violation (NFR-6, invariant 11). No ids, no Google URL in GET; ≤2 queries + 1 presign (NFR-7).
5. **`redirect_url` appears in exactly ONE shape:** first-record POST + `stars===5` + link configured → `{recorded:true, next:'google_redirect', redirect_url}`. Otherwise `{recorded:true, next:'thanks'}`. **Replay (exact):** `200 {recorded:false, already_recorded:true, next:'thanks'}` — no overwrite, no error, never `redirect_url` (P15/PD-9, invariants 3–4). Race anchor = `technician_ratings.rate_token_id UNIQUE` + `INSERT … ON CONFLICT (rate_token_id) DO NOTHING` (P16/T8).
6. **Stars/feedback (PD-7/PD-8):** `stars` must be `Number.isInteger` 1–5 — `"5"`, `4.5`, `0`, `6`, missing, `null` → `400 INVALID_STARS`; feedback non-string → `400 INVALID_FEEDBACK`; both BEFORE any DB read (P19: 400 never confirms token existence). Feedback: trim → empty ⇒ `null` → cap 2000 silently.
7. **Rate limits (PD-5, exact numbers):** window **60 s**, GET **60**/min, POST **10**/min; key = first `X-Forwarded-For` hop (v8 `ipKeyGenerator`), fallback `req.ip`; 429 body `{ok:false,error:{code:'RATE_LIMITED',message:'Too many requests'}}` + `RateLimit-*` standard headers. Ask endpoint NOT rate-limited (loopback + 60 s cache instead).
8. **Gate (H-group):** rating-surface allowlist `^/r/`, `^/api/public/rate(/|-domain-ask)`, `^/assets/`, `^/icons/`, `^/vite\.svg$`; `manifest.webmanifest` deliberately excluded. Pass-through: Albusto family + `RATE_ME_PASSTHROUGH_SUFFIXES` (default `localhost,127.0.0.1,::1,.fly.dev`) with ZERO DB/cache work (invariant 13). Custom-host lookup memoized 60 s (negatives too, cap 1000, full clear on overflow AND on every domain mutation). DB error on the custom-host branch ONLY → 503 fail-closed.
9. **Domain state machine (§6):** `(no row) →PUT→ pending →verify-ok→ verified →first-positive-ask→ active`; wrong-target/NXDOMAIN → `failed`; transport error → status UNCHANGED (PD-4); `verified`/`active` NEVER demote on any verify outcome — DELETE is the only kill switch. Serve-authorized = `{verified, active}`. Humane copy (exact strings): apex → "Use a subdomain like rate.bostonmasters.com — root domains can't carry a CNAME record."; taken → "This domain is already in use." (never the holder, PD-2, HTTP **400** `DOMAIN_TAKEN`); wrong target → "The CNAME points to foo.vercel.app — it needs to point to rate.albusto.com."; NXDOMAIN → "We can't see the CNAME record yet — DNS changes can take up to an hour. Check the record and try again. If your DNS provider proxies traffic (e.g. Cloudflare's orange cloud), switch the record to DNS-only."; transport → "We couldn't check DNS just now — please try again in a minute."
10. **Ask (D14–D17/NFR-4):** bare `200` empty body iff domain `verified`/`active` AND owner connected; else bare `404` empty body; XFF present OR non-loopback remoteAddress → 404 regardless; first positive ask flips `verified→active` + `domain_activated` event (actor **null**) EXACTLY once; deny never mutates.
11. **Settings dispatch (S-group):** `SETTINGS_ENABLED_APP_KEYS = {'rely-leads','rate-me'}`; scaffold trio order/codes unchanged (`SETTINGS_NOT_SUPPORTED`/`APP_NOT_FOUND`/`APP_NOT_INSTALLED`); rely GET/PUT byte-identical (rely suites re-run green, ZERO edits — THE S1/S2 pin); `validateRelySettingsInput` keeps name AND export; rate-me GET = `{success, app_key:'rate-me', installation_id, settings:{google_review_url}, domain:<row|null>, public_host:'rate.albusto.com', request_id}` — NO `catalogs`/`territory`. PD-1: https-only + URL-parseable + ≤500 chars + ANY host; empty/whitespace → `null`. Event payload `{app_key:'rate-me', has_google_review_url:boolean}` — URL value never in the audit trail. PD-3: ALL four authed rate-me endpoints (domain PUT/verify/DELETE + tokens POST) 404 `APP_NOT_INSTALLED` while disconnected.
12. **server.js (NFR-10, invariant 6):** exactly TWO flagged `RATE-ME-CRM-001` additions — gate immediately after the CORS middleware (BEFORE the raw-body webhook mounts `/api/billing/webhook`, `/api/stripe-payments/webhook`, `/api/email/push` at src/server.js:75-90) + public-rate router beside the existing `/api/public` mounts (:236-246). Protected: `authedFetch.ts`, `useRealtimeEvents.ts`, existing public routers, `backend/db/` only via migration 177 (+rollback).
13. **Envelopes:** public = `{ok:true,data}` / `{ok:false,error:{code,message}}`; authed = marketplace `handleError` `{success:false, code, message, request_id}`; `RateMeServiceError(message, code, httpStatus)` unwraps like `MarketplaceServiceError`.
14. **Logs (FR-14/D9):** mint `[RateMe] … {company_id, job_id, tech_id, token_prefix(8)}` — NEVER the full token; rating `{company_id, rate_token_id, stars, has_feedback, replay}`; public-404 reason classes `bad_format|not_found|host_mismatch|app_disconnected|expired`; every ask decision `{domain, allow}`.
15. **Testability exports (rely precedent "exported for tests"):** `RATE_TOKEN_RE` from `public-rate.js`; the domain-normalization helper and the ask loopback predicate from `rateMeService.js`/`public-rate.js`; `validateRateMeSettingsInput` from `marketplaceService.js`. Pure fns are required directly, no mocks.

## Harness & conventions (verified in-repo)

- Jest files in top-level `tests/*.test.js`; mocks by relative path `jest.mock('../backend/src/…')` with `mock*`-prefixed factory closures (`tests/relyLeadsSettings.test.js:6-40`); `supertest@7` devDependency; route harness = bare `express()` + injector middleware + REAL router (`tests/relyLeadIngest.test.js:64-75`, `tests/publicEstimates.test.js:44-49`).
- **Worktree run form (L-012/L-013):** worktrees have NO local `node_modules` — run via the main checkout with the Keychain flag:
  `node --use-bundled-ca /Users/rgareev91/contact_center/twilio-front-integration/node_modules/jest/bin/jest.js tests/<file> --rootDir . --testPathIgnorePatterns "/node_modules/" --forceExit` (from the worktree root; the explicit ignore overrides package.json's worktree skip). `unset NODE_USE_SYSTEM_CA` first (Node-25 segfault). Report the EXACT command executed (L-011).
- **L-014:** any verify command combining TWO OR MORE `*.db.test.js` files MUST add `--runInBand` — mig-172 replays + `ensureMarketplaceSchema` rebuild shared objects; parallel workers on the shared dev DB → `tuple concurrently updated`.
- **Public-route harness (`tests/publicRate.routes.test.js`):** bare `express()` mounting, in order: REAL `backend/src/middleware/rateHostGate.js` → sentinel raw-webhook route (`POST /api/billing/webhook` → 200 `'webhook-sentinel'`) → `express.json()` → REAL `backend/src/routes/public-rate.js` at `/api/public` → sentinel authed route (`GET /api/marketplace/apps` → 200 `'marketplace-sentinel'`) → catch-all page sentinel (200 `'spa-sentinel'`, stands in for the prod SPA fallback). Mocks at the query seam ONLY: `rateMeQueries` (faithful-replica `getTokenContext` implementing the host-bind contract `(token, hostCompanyId) => rows.find(r => r.token===token && r.not_expired && (hostCompanyId==null || r.company_id===hostCompanyId))`, `getConnectedRateMeMeta`, `getServableDomain`, `insertRating`, `stampTokenUsed`, domain fns), `storageService.getPresignedUrl`, `db/connection` (`pool`/`getClient` → `{query: jest.fn(), release: jest.fn()}`), `marketplaceQueries` (`writeEvent`). Host simulation via `.set('Host', 'rate.albusto.com')` (Express `req.hostname` reads the Host header — no `trust proxy`); client IP keying via `.set('X-Forwarded-For', '1.1.1.1')`. Rate-limiter isolation: every limit case uses a UNIQUE XFF value so cases never consume each other's window; the 61-request case gets its own `describe` with `jest.resetModules()`.
- **Cache isolation:** `rateMeService` keeps the 60 s host/ask cache at module scope — `jest.resetModules()` + re-require in `beforeEach` of cache-sensitive describes; cache-clear-on-mutation is exercised through the PUBLIC mutation fns (that IS the behavior under test), never by poking internals.
- **DNS mocking (`tests/rateMeDomains.test.js`):** `jest.mock('dns')` replacing `promises.Resolver` with a class whose `resolveCname = mockResolveCname`; success = resolve `['rate.albusto.com']` (variants `['RATE.ALBUSTO.COM.']`); NXDOMAIN = reject `Object.assign(new Error('queryCname ENOTFOUND'), {code:'ENOTFOUND'})` (also `ENODATA`); transport = reject with `code:'ETIMEOUT'`/`'ECONNREFUSED'`. The literal 5 s race is pinned STRUCTURALLY (service source contains `Promise.race` and `5000` in `verifyDomain`) — no wall-clock/fake-timer test (flake budget).
- **Ask loopback:** supertest always connects over loopback → the XFF-present deny leg runs via supertest; the non-loopback `remoteAddress` leg runs as a unit call of the exported loopback predicate with a stub `{socket:{remoteAddress:'10.0.0.9'}, headers:{}}` (fact 15).
- **FE = NO test harness** (no vitest/jsdom): U-group + C-group are source-STRUCTURAL jest checks + faithful-replica logic (`tests/relyLeadsUi.structural.test.js` precedent), each paired with a manual/browser verification step.
- **Real-PG suite (`tests/rateMe.db.test.js`):** `beforeAll` probe → apply `backend/db/migrations/177_rate_me.sql` via `db.query(fs.readFileSync(…))` **TWICE** (the double-apply IS the idempotency proof) → `dbReady`; every case self-skips `SKIPPED-NEEDS-DB` without a DB (relyLeadsSettings.db pattern); fixture companies/jobs tagged `RM-${Date.now()}-${pid}` and deleted in `afterAll`; structural halves of db cases run even when skipped (they read source files, not the DB).
- **Baseline rule (order of work):** the Implementer's change must FIRST pass the UNTOUCHED stay-green list below; only THEN are the new suites added.

## Coverage

- **Total test cases: 95**
- **P0: 48 · P1: 43 · P2: 4 · P3: 0**
- **unit-pure: 2 · unit-mocked service: 35 · supertest route: 33 · structural (+replica logic): 19 · db (real PG, self-skip): 6**
- Scenario matrix: **85/85** spec scenarios covered (T 10/10, P 19/19, H 12/12, D 19/19, S 10/10, U 11/11, C 4/4) — table at the end. §3 isolation matrix additionally swept whole (TC-M3-01) and at real-SQL level (TC-ISO-DB-01).
- 401/403 on the authed surface are enforced by the UNTOUCHED `src/server.js:268` mount chain — pinned structurally (TC-S8-02), not driven end-to-end (no Keycloak in jest; same deviation as every marketplace suite). Tenant addressing is driven at route level (TC-S8-01).

### Named sabotage controls (first-class; procedure: apply the sabotage manually, confirm RED, revert)

| # | Property | Control case(s) | Sabotage | Exact red-condition |
|---|---|---|---|---|
| 1 | Host-company bind lives INSIDE the context query | TC-ISO-DB-01 (+TC-M3-01) | **SAB-TOKEN-CROSS-TENANT** — delete `AND ($2::uuid IS NULL OR t.company_id = $2)` from `rateMeQueries.getTokenContext` | TC-ISO-DB-01 RED: real `getTokenContext(TOKEN_A, COMPANY_B)` returns company-A's row where `undefined` expected (matrix row «Custom domain of X × valid token of Y» flips 404ᵁ→200); its always-on structural half RED: `rateMeQueries.js` source no longer matches `/\$2::uuid IS NULL OR t\.company_id = \$2/` |
| 2 | Ask authorizes ONLY verified/active + connected | TC-D15-01 (+TC-D14-01, TC-D5-DB-01) | **SAB-ASK-OPEN** — `authorizeAskDomain` skips the null/connected checks, or `getServableDomain` drops `status IN ('verified','active')` | TC-D15-01 RED: ask for the `pending` domain returns 200 empty (expected bare 404); TC-D14-01 RED: `domain_activated` event fires for a pending row; TC-D5-DB-01 RED: real `getServableDomain` returns the `pending` row (expected undefined) |
| 3 | Custom host binds the served company | TC-H6-01 (+TC-M3-01, TC-H5-01) | **SAB-HOST-NO-BIND** — router calls `getPublicContext(token, null)` on custom hosts (drops `req.rateHost.companyId` plumbing) | TC-H6-01 RED: company-Y token on `rate.bostonmasters.com` answers 200 with Y's branding where the uniform 404 (`Invalid link`) is expected; assertion `getTokenContext called with (TOKEN_Y, COMPANY_X)` fails — called with `(TOKEN_Y, null)` |
| 4 | Body can never inject identity | TC-P14-01 | **SAB-RATING-BODY-COMPANY** — `submitRating`/route honors `req.body.company_id`/`tech_id`/`job_id` when present | TC-P14-01 RED: `insertRating` receives `companyId:'99999999-9999-9999-9999-999999999999'` / `techId:'zb-99'` / `jobId:1` from the body where the TOKEN row's `company_id`/`tech_id='zb-77'`/`job_id=41` are expected |
| 5 | Rating hosts expose ONLY the rating surface | TC-H3-01 (+TC-H10-01) | **SAB-GATE-ALLOW-ALL** — `rateHostGate` `next()`s every path on rating hosts (allowlist check removed) | TC-H3-01 RED: `GET /api/marketplace/apps` with Host `rate.albusto.com` reaches the marketplace sentinel (200 `'marketplace-sentinel'`) instead of gate-404 `{ok:false,error:{code:'NOT_FOUND',message:'Not found'}}`; `/pulse` returns `'spa-sentinel'` instead of plain-text `Not found`; TC-H10-01 RED: `POST /api/billing/webhook` on the rate host reaches `'webhook-sentinel'` |
| 6 | One rating per token EVER — replay never overwrites | TC-P15-01 (+TC-T8-DB-01) | **SAB-REPLAY-OVERWRITE** — second submit UPDATEs the rating row (or insert loses `ON CONFLICT (rate_token_id) DO NOTHING`) | TC-P15-01 RED: second POST answers `recorded:true` where `{recorded:false, already_recorded:true, next:'thanks'}` is expected, and/or `insertRating` is invoked on the already-rated path; TC-T8-DB-01 RED: after a second submit `stars` reads 1 where the original 5 must survive byte-unchanged |

### Stay-green list (run after implementation; all must pass UNCHANGED)

| Suite | Why it must stay green |
|---|---|
| `tests/relyLeadsSettings.test.js` · `tests/relyLeadFilter.test.js` · `tests/relyLeadIngest.test.js` · `tests/relyLeadsUi.structural.test.js` · `tests/relyLeadsSettings.db.test.js` | **THE S1/S2 pin.** Re-run green with **ZERO edits** — byte-identical proof: `git diff --stat master -- tests/relyLead*` prints nothing. They import `marketplaceService.getAppSettings/updateAppSettings` (dispatch must keep rely behavior verbatim), the `validateRelySettingsInput` export (must keep name AND export), and pin the `/api/marketplace` mount line + `companyId(req)` helper (additions elsewhere in server.js are tolerated by their regexes). |
| `tests/marketplaceLeadgenSplit.test.js` · `tests/marketplaceLeadgenSplit.db.test.js` | Whitelist/scaffold/disconnect flows untouched; TC-G4-02's `revokeCredentialById` count must not change when extending `marketplaceService.js`; the rate-me FE strings contain none of `pro-referral-leads|nsa-leads|lhg-leads`. |
| `tests/googleEmailMarketplace.test.js` · `tests/marketplaceTelephonyOverlay.test.js` | `marketplaceService`/`marketplace.js` additions are new registry entries + new routes only; existing install/credential flows call none of them. |
| `tests/publicEstimates.test.js` | Invariant 7: `public-estimates.js` byte-identical; the new `/api/public` sibling mount must not shadow `/api/public/estimates/*` (distinct path prefixes). |
| Yelp set (`tests/yelp*.test.js`, 24 files) + `tests/yelpFixtures.js` | Untouched — rate-me shares no seam with mail/timelines/leads; any red here means an accidental cross-edit. |
| `tests/routes/marketplaceMount.test.js` · `tests/routes/crmServerMount.test.js` | `toContain` pins on server.js mounts — tolerant of the two ADDED flagged lines, intolerant of edits to existing ones. |
| `tests/tenantSafetyLint.test.js` | ⚠️ Auto-scans `backend/src/routes|db|services` — the NEW `public-rate.js`/`rateMeQueries.js`/`rateMeService.js` are IN SCOPE: no `req.user.company_id` in routes, no `req.companyId`, no template-interpolated company ids in SQL (parameterized only). `rateHostGate.js` sits in `backend/src/middleware/` (outside the scan) but must follow the same rule. |
| `npm run build` (frontend, tsc -b) | RatePage/RateMeSettingsDialog/App/AuthProvider/AppLayout/marketplaceApi edits compile under prod-strict `noUnusedLocals`. |

## Proposed test files

| File | Kind | Contents |
|---|---|---|
| `tests/rateMeService.test.js` (NEW) | unit-mocked service | mint T1–T6; context/rating service legs P5, P9, P12(normalization), P16, P18; host-cache H11. Mocks: `rateMeQueries`, `marketplaceQueries` (`writeEvent`), `storageService`, `db/connection` (txn client). Real crypto. |
| `tests/publicRate.routes.test.js` (NEW) | supertest route (+2 pure/structural legs) | REAL gate + REAL public-rate router harness: P-group route behavior (P1–P4, P6–P8, P10–P15, P17, P19), T7 multi-open, H-group H1–H10, H12, ask D14–D16, §3 matrix sweep TC-M3-01. |
| `tests/rateMeDomains.test.js` (NEW) | unit-mocked service + supertest route | Domain lifecycle D1–D13, D17, D18 (DNS mocked); settings dispatch S1–S7, S10 (incl. rely-dispatch smoke — the real pin is the stay-green rely suites); authed-surface tenancy S8 + mint route T1(route leg) through REAL `routes/marketplace.js`. |
| `tests/rateMeUi.structural.test.js` (NEW) | structural + replica-logic | RatePage U1–U11; dialog D19 + S9 (+FORM-CANON); server.js two-mount pin + mount order (S8/H10/NFR-10); Caddyfile fragments C1–C3 + README C4; PUBLIC_AUTH_PATHS/App route/AppLayout pins. |
| `tests/rateMe.db.test.js` (NEW) | db (real PG, self-skip, L-014 `--runInBand` when combined) | Migration-172 objects/idempotency/seed/rollback (T10 ×3), UNIQUE(rate_token_id) anchor + ON CONFLICT idempotency (T8), real `getTokenContext` isolation matrix + expiry + PD-9 (ISO), UNIQUE(domain)/UNIQUE(company_id) semantics + `getServableDomain` status filter (D5/D6). |

Fixtures shared inside each file: `COMPANY_X`/`COMPANY_Y` UUIDs, `TOKEN_X = 'Xtok_'.padEnd(32,'x')`-style 32-char base64url strings, token rows `{id:501, company_id:COMPANY_X, job_id:41, tech_id:'zb-77', tech_name:'Alex Petrov', expires_at:null, used_at:null, company_name:'Boston Masters', logo_storage_key:'logos/x.png', technician_name:'Alex Petrov', already_rated:false}`, meta `{metadata:{settings:{google_review_url:'https://g.page/r/abc/review'}}, installation_id:7, app_id:'app-rate'}`, domain rows per status.

---

## T — Tokens & migration (`tests/rateMeService.test.js` unless noted)

### TC-T1-01 · mint happy path with job — P0 · unit-mocked service · covers T1
- **Setup:** `getConnectedRateMeMeta(COMPANY_X)` → meta; job-ownership read resolves job 41 of COMPANY_X with `assigned_techs=[{id:'zb-77', name:'Alex Petrov'}]`; `insertToken` echoes its arg with `id:501`. `console.log` spy.
- **Steps:** `mintToken(COMPANY_X, {jobId:41, techId:'zb-77'})`.
- **Expected:** returns `{token:<32-char, matches /^[A-Za-z0-9_-]{32}$/>, url:'https://rate.albusto.com/r/<token>'}` (host = `RATE_ME_PUBLIC_HOST` default). `insertToken` called ONCE with `{companyId:COMPANY_X, jobId:41, techId:'zb-77', techName:'Alex Petrov'}` (snapshot auto-resolved from `assigned_techs` since not supplied) — `expires_at`/`used_at` not set. Log: exactly one `[RateMe]` mint line whose payload has `company_id, job_id, tech_id` and `token_prefix` of length 8; `JSON.stringify(all log args)` does NOT contain the full token (fact 14).

### TC-T1-02 · mint route leg — 201 envelope + RateMeServiceError unwrap — P1 · supertest route · covers T1 (§5.2) — `tests/rateMeDomains.test.js`
- **Setup:** injector `req.companyFilter={company_id:COMPANY_X}; req.user={crmUser:{id:'crm-1'}}; req.requestId='req-rm'` + REAL `routes/marketplace.js`; service mocks as TC-T1-01.
- **Steps:** `POST /apps/rate-me/tokens` `{tech_id:'zb-77'}`; then force `mintToken` to throw `RateMeServiceError('…','JOB_NOT_FOUND',400)`.
- **Expected:** first → `201 {success:true, token:{token, url}}`; second → `400 {success:false, code:'JOB_NOT_FOUND', message, request_id:'req-rm'}` — `handleError` unwraps `RateMeServiceError` identically to `MarketplaceServiceError` (fact 13).

### TC-T2-01 · mint without job — tech_name from body / from nowhere — P1 · unit-mocked service · covers T2
- **Steps/table:** (a) `mintToken(COMPANY_X, {techId:'zb-77', techName:'Alex'})` → `insertToken` gets `{jobId:null, techName:'Alex'}`; (b) `{techId:'zb-77'}` only → `techName:null` (page falls back to "our technician", U10); both return 201-shape `{token,url}`.

### TC-T3-01 · mint validates job ownership — P0 · unit-mocked service · covers T3
- **Setup:** job-ownership read (`SELECT 1 FROM jobs WHERE id=$1 AND company_id=$2` seam) returns empty for `(41, COMPANY_X)` when the job belongs to COMPANY_Y, and for a non-existent id.
- **Expected:** both reject `RateMeServiceError {code:'JOB_NOT_FOUND', httpStatus:400}`; `insertToken` `.not.toHaveBeenCalled()` — no row created.

### TC-T4-01 · mint gated on installation (PD-3) — P0 · unit-mocked service · covers T4
- **Setup:** `getConnectedRateMeMeta` → `null` (never installed OR disconnected — same read).
- **Expected:** `mintToken` rejects `{code:'APP_NOT_INSTALLED', httpStatus:404}`; no job read, no `insertToken`.

### TC-T5-01 · mint input validation — P1 · unit-mocked service · covers T5
- **Steps/table:** `tech_id` missing / `''` / `42` (non-string) → `{code:'INVALID_TECH_ID', httpStatus:400}`; `job_id:'abc'` / `-1` / `1.5` (not a positive integer) → 400; extra body fields (`company_id`, `stars`) silently ignored (still 201-path).
- **Expected:** every 400 row: no `insertToken`, no event.

### TC-T6-01 · token format, entropy source & collision retry — P1 · unit-mocked service · covers T6
- **Setup:** real `crypto`; `insertToken` rejects twice with `Object.assign(new Error('duplicate key value violates unique constraint'), {code:'23505'})`, resolves on 3rd call.
- **Expected:** mint succeeds; `insertToken` called 3 times, each with a DIFFERENT 32-char base64url token. Second leg: rejects 4× → honest 500-class `RateMeServiceError` (httpStatus 500) after ≤3 retries. Structural: `rateMeService.js` contains `randomBytes(24)` and `'base64url'` (NOT `randomBytes(8)` — the estimate mint trap, invariant 14).

### TC-T7-01 · multi-open GET is stateless — P1 · supertest route · covers T7 — `tests/publicRate.routes.test.js`
- **Steps:** `GET /api/public/rate/:TOKEN_X` ×3 on the shared host (distinct XFF per call).
- **Expected:** three IDENTICAL `200 {ok:true, data:{…}}` bodies (deep-equal); `insertRating`/`stampTokenUsed` never called; `getTokenContext` called 3× (no caching of token reads); opening never consumes the link.

### TC-T8-DB-01 · rating-once anchor — UNIQUE(rate_token_id) + ON CONFLICT idempotency — P0 · db (self-skip) · covers T8 (P16 DB half, invariant 4) — `tests/rateMe.db.test.js` · **SAB-REPLAY-OVERWRITE control**
- **Setup:** seed tagged company + `rate_tokens` row; real `rateMeQueries`.
- **Steps:** (1) `insertRating({stars:5})` → returns id; (2) `insertRating({stars:1})` for the SAME `rate_token_id`; (3) raw second `INSERT` without ON CONFLICT; (4) `stampTokenUsed` twice.
- **Expected:** (2) returns NO row (`ON CONFLICT (rate_token_id) DO NOTHING`), stored row still `stars=5, feedback` byte-unchanged; (3) raises SQLSTATE `23505`; (4) second stamp is a no-op (`WHERE … used_at IS NULL` — `used_at` unchanged from the first stamp). One rating per token EVER; no update path exists.

### TC-T9 · expiry semantics — covered by TC-P4-01 (route) + TC-ISO-DB-01 (real `expires_at <= NOW()` guard leg) — expired ≡ nonexistent with zero behavioral difference.

### TC-T10-DB-01 · migration 177 objects + idempotent double-apply + seed upsert — P0 · db (self-skip) · covers T10 — `tests/rateMe.db.test.js`
- **Setup:** `beforeAll` applied `177_rate_me.sql` TWICE already (harness note) — reaching the test at all proves re-run is a no-op.
- **Expected:** `rate_tokens` (`token` UNIQUE, `tech_id` NOT NULL TEXT, `expires_at`/`used_at` nullable TIMESTAMPTZ, `job_id` BIGINT); `technician_ratings` (`rate_token_id` BIGINT NOT NULL **UNIQUE**, `stars SMALLINT` + CHECK `stars BETWEEN 1 AND 5` — insert `stars=6` raises `23514`); `rate_me_domains` (**UNIQUE(company_id)** AND **UNIQUE(domain)**, status CHECK `IN ('pending','verified','active','failed')`, `updated_at` trigger `trg_rate_me_domains_updated_at` bumps on UPDATE via pre-existing `update_updated_at_column()`); `marketplace_apps` row `app_key='rate-me'` with `provider_name='Albusto'`, `app_type='internal'`, `provisioning_mode='none'`, `status='published'`, `metadata.requires_credential_input=false`. Seed upsert: `UPDATE marketplace_apps SET name='X' WHERE app_key='rate-me'` → re-apply migration → name restored (`ON CONFLICT (app_key) DO UPDATE`). Structural half (always runs): filename `177_rate_me.sql` exists; the FILENAME is authoritative over any header-comment number.

### TC-T10-DB-02 · FK behavior — job SET NULL, company CASCADE — P1 · db (self-skip) · covers T10 — `tests/rateMe.db.test.js`
- **Steps:** seed tagged company + job + token(+rating) referencing both; `DELETE FROM jobs …`; then `DELETE FROM companies …` for a second fixture set.
- **Expected:** job delete → token AND rating rows survive with `job_id IS NULL`; `tech_name` snapshot intact (page keeps working); company delete → its tokens/ratings/domain rows GONE (CASCADE).

### TC-T10-DB-03 · rollback file — drop order + app row removal — P2 · db (self-skip) · covers T10 — `tests/rateMe.db.test.js`
- **Steps:** apply `rollback_177_rate_me.sql`; then re-apply `177_rate_me.sql` (leave the DB migrated for other suites).
- **Expected:** rollback executes without FK errors (order ratings → tokens → domains pinned by successful execution); after rollback the 3 tables are absent and `app_key='rate-me'` row deleted; re-apply restores everything (idempotent).

---

## P — Public API (`tests/publicRate.routes.test.js` unless noted; shared host unless stated)

### TC-P1-01 · GET context happy — exactly 5 keys — P0 · supertest route · covers P1 (NFR-6/NFR-7, invariant 11)
- **Setup:** token row X (logo key set, no rating); meta with `google_review_url` configured; `getPresignedUrl` → `'https://s3.example/presigned'`.
- **Steps:** `GET /api/public/rate/:TOKEN_X` with Host `rate.albusto.com`.
- **Expected:** `200`, body `{ok:true, data:{company_name:'Boston Masters', company_logo_url:'https://s3.example/presigned', technician_name:'Alex Petrov', already_rated:false, five_star_redirect:true}}`; `Object.keys(body.data).sort()` deep-equal `['already_rated','company_logo_url','company_name','five_star_redirect','technician_name']` — **exactly 5 keys, a 6th is a failure**. `JSON.stringify(body)` contains NO uuid, NO `g.page`, NO job/tech ids. Query budget: `getTokenContext` ×1 + `getConnectedRateMeMeta` ×1 + presign ×1, nothing else.

### TC-P2-01 · GET unknown token — P0 · supertest route · covers P2
- **Steps:** well-formed 32-char token with no row.
- **Expected:** `404 {ok:false, error:{code:'NOT_FOUND', message:'Invalid link'}}` (the uniform body, byte-exact).

### TC-P3-01 · GET malformed token — pre-DB guard — P0 · supertest route · covers P3
- **Steps/table:** `abc` (too short) · 65 `a`s · `..%2F..%2Fetc` · `Ab$……` (non-base64url chars, 32 long).
- **Expected:** each → the uniform 404; `getTokenContext` `.not.toHaveBeenCalled()` for the whole table (format guard precedes ANY DB read).

### TC-P3-02 · RATE_TOKEN_RE table — P1 · unit-pure · covers P3
- **Steps:** require `RATE_TOKEN_RE` from `public-rate.js` (fact 15): accepts 22–64 chars of `[A-Za-z0-9_-]` (22-char min = ≥128-bit base64url, our 32-char mint, 64-char max); rejects 21 chars, 65 chars, `+`, `/`, `=`, ` `, empty.

### TC-P4-01 · GET expired token — P1 · supertest route · covers P4 (T9)
- **Setup:** faithful `getTokenContext` mock treats the `expires_at:<past>` fixture as no-row (mirrors the SQL guard `expires_at IS NULL OR expires_at > NOW()` — real guard proven in TC-ISO-DB-01).
- **Expected:** GET AND POST both → the uniform 404 — expired ≡ nonexistent.

### TC-P5-01 · GET token of app-disconnected company + reconnect — P0 · unit-mocked service · covers P5 — `tests/rateMeService.test.js`
- **Setup:** `getTokenContext` → row X; `getConnectedRateMeMeta(COMPANY_X)` → `null`.
- **Expected:** `getPublicContext(TOKEN_X, null)` → `null` (router turns it into the uniform 404); NO presign attempted. Reconnect leg: meta restored → full DTO again — nothing was deleted, tokens survive disconnect.

### TC-P6-01 · uniform-404 QUINTET byte-identical — P0 · supertest route · covers P6 (P2–P6 pin, NFR-2/NFR-3, invariant 1)
- **Steps:** collect the five failure responses: malformed / unknown / expired / foreign-host (company-Y token on X's `active` custom host `rate.bostonmasters.com`) / app-disconnected.
- **Expected:** all five: status `404`, `content-type` identical, bodies **deep-equal** to each other and to `{ok:false,error:{code:'NOT_FOUND',message:'Invalid link'}}` — no timing/text/shape oracle across classes. Foreign-host leg additionally asserts `getTokenContext` was called with `(TOKEN_Y, COMPANY_X)` (host bind reached the query seam).

### TC-P7-01 · GET after rating — P1 · supertest route · covers P7
- **Setup:** row with `already_rated:true`.
- **Expected:** `200` with `already_rated:true`; the other 4 keys still present (page renders thank-you, U6).

### TC-P8-01 · five_star_redirect flag truth — P0 · supertest route · covers P8
- **Steps/table:** meta with `google_review_url` set → `five_star_redirect:true`; meta with `settings:{}` or `google_review_url:null` → `false`.
- **Expected:** flag boolean only; the URL string appears NOWHERE in any GET body (record-before-redirect lives in POST, invariant 3).

### TC-P9-01 · logo presign failure best-effort — P1 · unit-mocked service · covers P9 (NFR-8) — `tests/rateMeService.test.js`
- **Steps/table:** (a) `getPresignedUrl` rejects → DTO `company_logo_url:null`, everything else intact (no throw); (b) `logo_storage_key IS NULL` → `company_logo_url:null` AND `getPresignedUrl` `.not.toHaveBeenCalled()`.

### TC-P10-01 · POST 5★ with link — P0 · supertest route · covers P10
- **Setup:** token X un-rated; link configured; txn client mock; `insertRating` returns `{id:900}`; log spy.
- **Steps:** `POST /api/public/rate/:TOKEN_X/rating` `{stars:5}`.
- **Expected:** `200 {ok:true, data:{recorded:true, next:'google_redirect', redirect_url:'https://g.page/r/abc/review'}}`; `insertRating` called with `{companyId:COMPANY_X, rateTokenId:501, jobId:41, techId:'zb-77', stars:5, feedback:null}`; `stampTokenUsed(501, client)` called; one `[RateMe]` rating log with `{company_id, rate_token_id, stars:5, has_feedback:false, replay:false}`.

### TC-P11-01 · POST 5★ without link — P0 · supertest route · covers P11 (US-6)
- **Expected:** `200 {ok:true, data:{recorded:true, next:'thanks'}}`; `'redirect_url' in body.data === false` (key ABSENT, not null); rating stored.

### TC-P12-01 · POST 1–4★ with feedback — P0 · supertest route · covers P12
- **Steps:** `{stars:3, feedback:'  late arrival  '}` with the link CONFIGURED.
- **Expected:** `200 {recorded:true, next:'thanks'}`; `insertRating` receives `feedback:'late arrival'` (trimmed); `redirect_url` key ABSENT even though the link exists (stars ≤ 4 never redirect).

### TC-P12-02 · feedback normalization (PD-7) — P1 · unit-mocked service · covers P12 — `tests/rateMeService.test.js`
- **Steps/table:** `'   '` → stored `null`; `''` → `null`; 2001-char string → stored EXACTLY 2000 chars (silently truncated — the rating never fails for a long rant); 2000-char → unchanged.

### TC-P13-01 · POST body validation before DB — P0 · supertest route · covers P13 (PD-8)
- **Steps/table:** `stars` missing / `0` / `6` / `4.5` / `"5"` (string) / `null` → `400 {ok:false,error:{code:'INVALID_STARS',…}}`; `{stars:3, feedback:42}` and `{stars:3, feedback:{}}` → `400 INVALID_FEEDBACK`.
- **Expected:** every row: `getTokenContext`/`insertRating` `.not.toHaveBeenCalled()` (validation precedes ANY DB read).

### TC-P14-01 · body cannot inject identity — P0 · supertest route · covers P14 (FR-5, invariant 2) · **SAB-RATING-BODY-COMPANY control**
- **Steps:** `POST …/rating` body `{stars:5, company_id:'99999999-9999-9999-9999-999999999999', tech_id:'zb-99', job_id:1, token:'ZZZ…', rate_token_id:777}`.
- **Expected:** 200; extra fields silently ignored; `insertRating` called with the TOKEN row's identity EXACTLY: `{companyId:COMPANY_X, rateTokenId:501, jobId:41, techId:'zb-77'}` — the test pins the stored row against the token row, NOT the body.

### TC-P15-01 · POST replay — 200-idempotent, no overwrite — P0 · supertest route · covers P15 (PD-9) · **SAB-REPLAY-OVERWRITE control**
- **Setup:** token row with `already_rated:true` (rating row EXISTS — the truth; `used_at` irrelevant per PD-9). First rating was 5★, link configured.
- **Steps:** `POST …/rating` `{stars:1, feedback:'changed my mind'}`.
- **Expected:** `200 {ok:true, data:{recorded:false, already_recorded:true, next:'thanks'}}` — byte-exact; NO `redirect_url` even though the first rating was 5★+link; `insertRating` `.not.toHaveBeenCalled()` on this path (no overwrite path exists); rating log has `replay:true`.

### TC-P16-01 · concurrent-race POST — conflict loser returns replay — P0 · unit-mocked service · covers P16 — `tests/rateMeService.test.js`
- **Setup:** `getTokenContext` → un-rated row (both racers read `already_rated:false`); `insertRating` resolves `{id:900}` on 1st call, resolves **no row** (conflict swallowed by `ON CONFLICT … DO NOTHING`) on 2nd.
- **Steps:** two `submitRating(TOKEN_X, {stars:5}, null)` calls.
- **Expected:** winner → `{recorded:true, next:'google_redirect', redirect_url}`; loser → `{recorded:false, already_recorded:true, next:'thanks'}` (no error, no redirect); txn discipline: `BEGIN`/`COMMIT` on the mocked client both times, `ROLLBACK` never; exactly one `stampTokenUsed` effective (guarded `used_at IS NULL` — DB half in TC-T8-DB-01).

### TC-P17-01 · rate limits — XFF-keyed 60/10 per 60 s — P1 · supertest route · covers P17 (PD-5)
- **Setup:** fresh module registry (own describe, `jest.resetModules()`).
- **Steps/table:** (a) 60 GETs with `X-Forwarded-For: 1.1.1.1` → all pass; 61st → `429 {ok:false,error:{code:'RATE_LIMITED',message:'Too many requests'}}` + `RateLimit-*` standard headers present; (b) same instant, GET with `X-Forwarded-For: 2.2.2.2` → `200`-class (keys independent — first XFF hop, NOT `req.ip` which is always `127.0.0.1` behind Caddy); (c) POST limit: 10 pass, 11th → 429; (d) no XFF (direct localhost smoke) → keys on `req.ip`, still passes.
- **Expected:** exact 429 body above. Structural pin (same case): `public-rate.js` source contains `windowMs` = 60 000, GET `max` 60, POST `max` 10, and references the v8 `ipKeyGenerator` helper (deliberate deviation from the publicAuth verbatim copy — documented in D4).

### TC-P18-01 · POST storage failure — honest 500, never a redirect — P0 · unit-mocked service · covers P18 (NFR-8) — `tests/rateMeService.test.js`
- **Setup:** `insertRating` rejects with a non-23505 error.
- **Expected:** `submitRating` rejects → route answers `500 {ok:false,error:{code:'INTERNAL',…}}`; txn client got `ROLLBACK` (no COMMIT); `stampTokenUsed` not committed; the rejection value/route body contains NO `redirect_url` — an unrecorded customer is never sent to Google (page half = TC-U8-01).

### TC-P19-01 · guard ordering leaks nothing — P1 · supertest route · covers P19
- **Steps/table:** (a) malformed token + invalid body `{stars:99}` → **404** uniform (format guard first); (b) well-formed-but-unknown token + `{stars:99}` → **400 INVALID_STARS** with `getTokenContext` `.not.toHaveBeenCalled()` (body check precedes the DB lookup — a 400 does NOT confirm token existence).

### TC-M3-01 · §3 isolation-matrix sweep — P0 · supertest route · covers §3 (rows of P2–P6/H2/H5–H8/H12; FR-8/NFR-3, invariant 16)
- **Setup:** fixtures: tokens {valid-X, valid-Y, malformed, unknown, expired, disconnected-co}; hosts {`rate.albusto.com` shared · `rate.bostonmasters.com` = X `verified` · same host with row `pending` · `evil.example.com` no row · `app.albusto.com` pass-through}.
- **Steps:** table-driven GET (and POST spot-checks per row) across all 5×6 combinations.
- **Expected (must reproduce the spec table exactly):** shared → 200/200(Y!)/404ᵁ/404ᵁ/404ᵁ/404ᵁ; custom-X → 200/**404ᵁ**/404ᵁ/404ᵁ/404ᵁ/404ᵁ; pending-host → 404 for EVERYTHING; unknown host → 404 everything; pass-through → 200/200/404ᵁ/404ᵁ/404ᵁ/404ᵁ (token-only scope, `req.rateHost` absent). Every 404ᵁ cell body deep-equals the uniform body; shared-host serves EVERY tenant (FR-8) while custom-X never serves Y.

---

## H — Host gate (`tests/publicRate.routes.test.js`)

### TC-H1-01 · Albusto/pass-through hosts — zero cost — P0 · supertest route · covers H1 (invariant 13)
- **Steps/table:** Hosts `app.albusto.com`, `api.albusto.com`, `albusto.com`, `www.albusto.com`, `localhost:3000`, `127.0.0.1`, `[::1]`, `x.fly.dev` → any CRM path (`/pulse`, `/api/marketplace/apps`).
- **Expected:** every request reaches its sentinel (SPA/marketplace) — gate `next()`s; `getServableDomain` `.not.toHaveBeenCalled()` across the WHOLE table (pure string checks — no DB, no cache; the query-spy pin).

### TC-H2-01 · shared-host allowlist passes — P0 · supertest route · covers H2
- **Steps/table (Host `rate.albusto.com`):** `/r/<token>` → spa-sentinel; `GET/POST /api/public/rate*` → router (real handler status, not gate 404); `/assets/app.js`, `/icons/icon-192.png`, `/vite.svg` → spa-sentinel (static class); probe middleware records `req.rateHost` deep-equal `{mode:'shared'}`.

### TC-H3-01 · shared-host blocks everything else + KC silence — P0 · supertest route · covers H3 (NFR-5, invariant 12) · **SAB-GATE-ALLOW-ALL control**
- **Steps/table (Host `rate.albusto.com`):** `/`, `/pulse`, `/login`, `/settings`, `/api/marketplace/apps`, `/api/crm/contacts`, `/api/calls`, `/events`, `/webhooks/twilio`, `/health`, `/twiml`, and `/r` (NO trailing slash — fails `^/r/`).
- **Expected:** ALL → `404` from the gate: `/api/*` paths body deep-equal `{ok:false,error:{code:'NOT_FOUND',message:'Not found'}}`; page paths body === `Not found` (plain text); NO response carries a `Location` header; no body contains `auth.albusto.com` or any Keycloak URL; neither `marketplace-sentinel` nor `spa-sentinel` text appears (SPA never boots for CRM routes → no KC redirect, no CRM cookies).

### TC-H4-01 · manifest not allowlisted — P2 · supertest route · covers H4
- **Expected:** `GET /manifest.webmanifest` and `GET /apple-touch-icon.png` on a rating host → gate 404 (deliberate; Albusto PWA identity must not surface on tenant domains); `/icons/apple-touch-icon.png` (inside `/icons/`) → passes.

### TC-H5-01 · verified/active custom domain binds company — P0 · supertest route · covers H5
- **Setup:** `getServableDomain('rate.bostonmasters.com')` → `{company_id:COMPANY_X, status:'verified'}` (repeat with `'active'`).
- **Expected:** probe sees `req.rateHost` deep-equal `{mode:'custom', companyId:COMPANY_X}`; company-X token GET → 200 with X's branding AND POST → 200 recorded; `getTokenContext` received `(TOKEN_X, COMPANY_X)` end-to-end.

### TC-H6-01 · foreign token on custom domain — P0 · supertest route · covers H6 (US-5) · **SAB-HOST-NO-BIND control**
- **Steps:** same host, company-Y token, GET + POST.
- **Expected:** both → uniform 404 body IDENTICAL to TC-P2-01's (deep-equal — no distinguishable error, no partial resolve); `getTokenContext` called with `(TOKEN_Y, COMPANY_X)` — the bind reached the single context query, not a post-filter.

### TC-H7-01 · pending/failed/removed domain host — P0 · supertest route · covers H7
- **Setup:** `getServableDomain` → `null` (query only returns `verified`/`active`; pending/failed/deleted all resolve null).
- **Expected:** mode `unknown` → 404 for EVERY path INCLUDING `/r/<valid-token>` and `/api/public/rate/<valid-token>` (gate 404 shapes per H3); valid tokens are irrelevant on a non-serving host.

### TC-H8-01 · unknown host — P1 · supertest route · covers H8
- **Expected:** Host `evil.example.com` (no row, not Albusto, not a pass-through suffix) → 404 everything; `getServableDomain('evil.example.com')` called (it IS a custom-domain candidate — contrast TC-H1-01).

### TC-H9-01 · fail-closed 503, scoped — P1 · supertest route · covers H9
- **Setup:** `getServableDomain` rejects (DB down).
- **Expected:** request on `rate.unknown-host.com` → `503`; SAME failure state, request on `app.albusto.com` → sentinel 200 (Albusto branch is structurally incapable of the 503 — no lookup on that path).

### TC-H10-01 · gate precedes every mount incl. raw-body webhooks — P0 · supertest route + structural · covers H10 (NFR-5/NFR-10, invariant 6)
- **Route half:** `POST /api/billing/webhook` with Host `rate.albusto.com` → gate 404 (`webhook-sentinel` NOT reached); same POST with Host `app.albusto.com` → `webhook-sentinel` (pass-through unchanged).
- **Structural half (src/server.js):** `indexOf` order: CORS middleware block < `rateHostGate` mount < `'/api/billing/webhook'` mount < `'/api/stripe-payments/webhook'` < `'/api/email/push'`; exactly **2** occurrences of the `RATE-ME-CRM-001` flag comment (gate + public-rate router — the ONLY two additions); the public-rate mount sits beside the existing `/api/public` mounts.

### TC-H11-01 · host-resolution cache — memoize/negatives/mutation-clear/cap — P1 · unit-mocked service · covers H11 (invariants 19–20) — `tests/rateMeService.test.js`
- **Steps/table (fresh module per leg):** (a) `resolveDomainCompany('rate.a.com')` ×5 → `getServableDomain` called ONCE (60 s memo); (b) null result ×5 → also ONE query (negatives cached); (c) `setCustomDomain`/`removeDomain`/verify-SUCCESS each followed by `resolveDomainCompany` → fresh query (cache cleared by EVERY domain mutation — removal takes effect within one request, never after 60 s of stale serving; a just-verified domain serves immediately); (d) 1001 distinct hosts → cache fully cleared on overflow (cap 1000; 1002nd lookup of host #1 re-queries) — bounded memory under host enumeration.

### TC-H12-01 · app-host smoke path — P1 · supertest route · covers H12
- **Expected:** `GET /r/<TOKEN_X>` with Host `app.albusto.com` → spa-sentinel (gate pass-through); `GET /api/public/rate/<TOKEN_X>` same host → 200, `getTokenContext` called with `(TOKEN_X, null)` (`req.rateHost` absent ⇒ token-only scope — the `/e/:token`-equivalent smoke path); CRM stays fully reachable on app hosts.

---

## D — Custom domains & ask (`tests/rateMeDomains.test.js` unless noted)

### TC-D1-01 · set domain happy path — P0 · unit-mocked service · covers D1
- **Steps:** `setCustomDomain(COMPANY_X, 'crm-1', 'Rate.BostonMasters.com.')`.
- **Expected:** `upsertDomainForCompany(COMPANY_X, 'rate.bostonmasters.com')` (trim → hostname-parse → lowercase → trailing dot stripped); returned `domain` object exactly `{domain:'rate.bostonmasters.com', status:'pending', verified_at:null, activated_at:null, last_checked_at:null, last_error:null}`; ONE `writeEvent` `{eventType:'domain_added', payload:{app_key:'rate-me', domain:'rate.bostonmasters.com'}, actorId:'crm-1'}`; host/ask cache cleared (next `resolveDomainCompany` re-queries).

### TC-D1-02 · normalization table — P1 · unit-pure · covers D1
- **Steps (exported normalize helper, fact 15):** `'  Rate.BostonMasters.com.  '` → `'rate.bostonmasters.com'`; IDN `'rate.бостон.com'` → punycode-ASCII (`rate.xn--…com`, matches `/^rate\.xn--/`); `'REVIEWS.ACME.CO'` → `'reviews.acme.co'`.

### TC-D2-01 · invalid hostname — P1 · unit-mocked service · covers D2
- **Steps/table:** `'not a host'` · `'ha!.com'` · 254-char hostname · `'rate..double.com'` → each rejects `{code:'INVALID_DOMAIN', httpStatus:400}` (humane message); `upsertDomainForCompany` and `writeEvent` never called.

### TC-D3-01 · apex rejected with THEIR-domain copy — P1 · unit-mocked service · covers D3
- **Expected:** `'bostonmasters.com'` (2 labels) → `{code:'APEX_DOMAIN_NOT_SUPPORTED', httpStatus:400}`, message EXACTLY `Use a subdomain like rate.bostonmasters.com — root domains can't carry a CNAME record.` (embeds THEIR domain). Known-limitation leg: `'example.co.uk'` (3 labels) PASSES this rule (proceeds to upsert) — multi-label-TLD apexes fail later at Verify with the generic D9 copy, accepted v1.

### TC-D4-01 · reserved domains — P1 · unit-mocked service · covers D4
- **Steps/table:** `'rate.albusto.com'` · `'albusto.com'` · `'foo.albusto.com'` → `{code:'RESERVED_DOMAIN', httpStatus:400}`; no row, no event.

### TC-D5-01 · domain taken — no holder disclosure — P0 · unit-mocked service · covers D5 (PD-2, invariant 10)
- **Setup:** `upsertDomainForCompany` rejects `{code:'23505', constraint:<domain-unique>}` (company B submits A's domain — any status).
- **Expected:** rejects `{code:'DOMAIN_TAKEN', httpStatus:400}` — **HTTP 400, NOT 409**; message EXACTLY `This domain is already in use.`; `message` contains NEITHER company A's id nor name; no event; row untouched.

### TC-D5-DB-01 · real-PG UNIQUE(domain) + UNIQUE(company_id) + getServableDomain status filter — P1 · db (self-skip) · covers D5/D6 (SAB-ASK-OPEN DB half) — `tests/rateMe.db.test.js`
- **Steps:** seed domain `rate.a.com` for company A (`pending`); (1) raw insert of `rate.a.com` for company B → SQLSTATE `23505`; (2) `upsertDomainForCompany(A, 'rate.b.com')` → SAME row id, `domain='rate.b.com'`, `status='pending'`, `verified_at/activated_at/last_checked_at/last_error` all NULL (in-place reset, D6); (3) `getServableDomain('rate.b.com')` while `pending` → undefined; set `status='verified'` → returns the row; `'active'` → returns; `'failed'` → undefined.

### TC-D6-01 · replace own domain — upsert-in-place reset — P1 · unit-mocked service · covers D6
- **Setup:** company has `active` `rate.a.com`; `upsertDomainForCompany` echoes the reset row.
- **Expected:** NOT a conflict; returned row `{domain:'rate.b.com', status:'pending', verified_at:null, activated_at:null, last_checked_at:null, last_error:null}`; `domain_added` event; cache cleared → `rate.a.com` stops serving immediately (`resolveDomainCompany('rate.a.com')` re-queries → null).

### TC-D7-01 · verify success — P0 · unit-mocked service (DNS mocked) · covers D7
- **Setup:** row `pending`; `mockResolveCname` → `['rate.albusto.com']`; variant leg → `['RATE.ALBUSTO.COM.']` (targets normalized: lowercase + trailing dot stripped).
- **Expected:** `verifyDomain` returns row with `status:'verified'`, `verified_at:<now>`, `last_checked_at:<now>`, `last_error:null`; `domain_verified` event; cache cleared; from `failed` → same success path. HTTP is 200 on EVERY verify outcome (status chips, not exceptions — route leg in TC-S8-01's sweep).

### TC-D8-01 · verify wrong target — P1 · unit-mocked service · covers D8
- **Setup:** `mockResolveCname` → `['foo.vercel.app']`.
- **Expected:** row `status:'failed'`, `last_error` EXACTLY `The CNAME points to foo.vercel.app — it needs to point to rate.albusto.com.`; `last_checked_at` updated; NO `domain_verified` event.

### TC-D9-01 · verify NXDOMAIN / no CNAME — P1 · unit-mocked service · covers D9
- **Setup:** reject `code:'ENOTFOUND'`; second leg `code:'ENODATA'` (CDN CNAME-flattening presents as this).
- **Expected:** `status:'failed'`, `last_error` EXACTLY `We can't see the CNAME record yet — DNS changes can take up to an hour. Check the record and try again. If your DNS provider proxies traffic (e.g. Cloudflare's orange cloud), switch the record to DNS-only.`

### TC-D10-01 · verify transport error — status unchanged (PD-4) — P1 · unit-mocked service · covers D10
- **Setup/table:** reject `code:'ETIMEOUT'`, then `code:'ECONNREFUSED'`; run once against a `pending` row, once against a `failed` row.
- **Expected:** status UNCHANGED (`pending` stays `pending`, `failed` stays `failed`); `last_error` EXACTLY `We couldn't check DNS just now — please try again in a minute.`; `last_checked_at` updated; resolves normally (never a crash, never a 5xx for DNS weather). Structural pin: `verifyDomain` source contains `Promise.race` and `5000` (the 5 s timeout).

### TC-D11-01 · re-verify & no-demote — P0 · unit-mocked service · covers D11 (invariant 9)
- **Steps/table:** (a) `failed` + CNAME ok → `verified`; (b) `verified` + wrong target → STILL `verified`, `verified_at` unchanged, only `last_checked_at` (+`last_error`); (c) `verified` + ENOTFOUND → still `verified`; (d) `active` + CNAME ok → stays `active` (never regresses to `verified`), NO duplicate `domain_verified` event; (e) `active` + ENOTFOUND → still `active`. Removal (TC-D13-01) is the ONLY kill switch.

### TC-D12-01 · verify without a row — P2 · unit-mocked service · covers D12
- **Expected:** `getDomainByCompany` → null ⇒ `verifyDomain` rejects `{code:'DOMAIN_NOT_FOUND', httpStatus:404}`; resolver never invoked.

### TC-D13-01 · remove domain — P0 · unit-mocked service · covers D13
- **Expected:** `removeDomain` → `deleteDomain(COMPANY_X)` + `domain_removed` event + cache cleared (next `resolveDomainCompany`/`authorizeAskDomain` re-query → null → H7/H8 behavior + ask deny within ONE request); route answers `200 {success:true}` (leg in TC-S8-01 sweep). Delete without a row → `{code:'DOMAIN_NOT_FOUND', httpStatus:404}`.

### TC-D14-01 · ask allow + activation exactly once — P0 · supertest route · covers D14 (FR-11) — `tests/publicRate.routes.test.js`
- **Setup:** domain row `verified` for COMPANY_X, X connected; requests from supertest loopback WITHOUT XFF.
- **Steps:** `GET /api/public/rate-domain-ask?domain=rate.bostonmasters.com` ×3; then same for an `active` row.
- **Expected:** every ask → `200` with **empty body** (`res.text === ''`); side effect EXACTLY once: `setDomainStatus(…,'active', activated_at)` ×1 and ONE `writeEvent {eventType:'domain_activated', actorId:null}` (system actor) — asks 2/3 hit the decision cache: no further UPDATE/event; `active`-row asks → plain 200, zero mutations. Ask log `{domain, allow:true}` per decision.

### TC-D15-01 · ask deny matrix — P0 · supertest route · covers D15 (NFR-4, invariant 8) — `tests/publicRate.routes.test.js` · **SAB-ASK-OPEN control**
- **Steps/table:** domain `pending` · `failed` · removed/never-existed · `verified` but owner DISCONNECTED (`getConnectedRateMeMeta` → null) · missing `domain` param · `?domain=<garbage!>`.
- **Expected:** every row → `404` with **empty body** — no JSON, no detail in either direction; `setDomainStatus` and `writeEvent` `.not.toHaveBeenCalled()` (deny NEVER mutates). Structural leg (always on): `rateMeQueries.js` `getServableDomain` source matches `/status IN \('verified',\s*'active'\)/`.

### TC-D16-01 · ask loopback guard — P0 · supertest route + unit-pure leg · covers D16 — `tests/publicRate.routes.test.js`
- **Steps:** (a) ask for a `verified` domain WITH header `X-Forwarded-For: 8.8.8.8` (anything through Caddy carries XFF) → `404` empty, regardless of real status; (b) unit leg: exported loopback predicate with `{socket:{remoteAddress:'10.0.0.9'}, headers:{}}` → false; `'127.0.0.1'`/`'::1'`/`'::ffff:127.0.0.1'` with no XFF → true.
- **Expected:** public probing of the ask endpoint is indistinguishable from a nonexistent route.

### TC-D17-01 · ask decision cache — P1 · unit-mocked service · covers D17
- **Steps/table (fresh module per leg):** (a) `authorizeAskDomain('rate.a.com')` ×10 within TTL → ONE `getServableDomain` round (storm of asks ⇒ ≤1 DB round per 60 s; Caddy `interval 2m / burst 5` is the secondary throttle, C1); (b) `removeDomain` then ask → cache MISS → fresh query → deny (no 60 s stale-allow window); (c) same store as H11: cap 1000, full clear on overflow.

### TC-D18-01 · disconnect / reconnect semantics — P1 · unit-mocked service · covers D18 (PD-3)
- **Steps/table:** with `getConnectedRateMeMeta` → null: (a) `authorizeAskDomain` → false (D15 leg); (b) `getPublicContext` → null (P5 leg); (c) ALL FOUR management ops — `setCustomDomain`, `verifyDomain`, `removeDomain`, `mintToken` — reject `{code:'APP_NOT_INSTALLED', httpStatus:404}`; (d) `deleteDomain` NEVER called by the disconnect path — the row SURVIVES with its status. Reconnect leg (meta restored): ask allows and management resumes WITHOUT re-verification (status preserved, no new `domain_verified`).

### TC-D19-01 · settings-dialog domain pane — literal copy — P1 · structural (+replica) · covers D19 — `tests/rateMeUi.structural.test.js`
- **Structural (`RateMeSettingsDialog.tsx`):** monospace instruction block containing EXACTLY `Type: CNAME` · `Host/Name:` · `Target:` with target bound to `public_host` from the GET (no hardcoded `rate.albusto.com` fallback string when `public_host` exists is acceptable — assert the `public_host` reference); Host/Name derives from the FIRST label of the entered domain (source contains a `split('.')` first-label expression). Status chips literals: `Waiting for DNS` (pending) · `Verified` (verified) · `Live at https://` (active, interpolating the domain) · failed renders the row's `last_error` + a Retry (re-verify) affordance; a Remove affordance present whenever a row exists.
- **Replica-logic:** firstLabel(`'rate.bostonmasters.com'`) → `'rate'`; firstLabel(`'reviews.acme.co'`) → `'reviews'` — so the rendered line for the D1 fixture reads `Type: CNAME · Host/Name: rate · Target: rate.albusto.com`.
- **Manual:** enter `reviews.acme.co` → pane shows `Host/Name: reviews`; failed state shows the humane `last_error` line and Retry re-fires verify.

---

## S — Settings dispatch & authed surface (`tests/rateMeDomains.test.js` unless noted)

### TC-S1-01 · rely GET byte-identical through the dispatch — P0 · unit-mocked service (+ stay-green pin) · covers S1 (invariant 5)
- **Primary pin:** the five rely suites re-run green with ZERO edits (stay-green table — `git diff --stat master -- tests/relyLead*` empty).
- **In-suite smoke:** with rely mocks copied verbatim from `tests/relyLeadsSettings.test.js:79-113`, `marketplaceService.getAppSettings(COMPANY,'rely-leads')` deep-equals the EXACT pre-refactor shape (`app_key`, `installation_id:7`, `settings` defaults, `catalogs{unit_types(12),brands(15)}`, `territory{active_mode,has_data}`); `marketplaceService.validateRelySettingsInput` is still an exported function (name AND export kept — the suites import it).

### TC-S2-01 · rely PUT byte-identical incl. event payload — P0 · unit-mocked service · covers S2
- **Steps:** `updateAppSettings(COMPANY, 'crm-user-1', 'rely-leads', {zone:{mode:'custom', custom_zips:['02301']}}, {requestId:'req-audit'})` with rely mocks.
- **Expected:** stored settings + response identical to the pre-refactor behavior; `writeEvent` payload deep-equal `{app_key:'rely-leads', zone_mode:'custom', custom_zip_count:1, unit_type_count:0, brand_count:0}` (moved verbatim into the rely `buildEventPayload`); `updated_at`/`updated_by` stamped.

### TC-S3-01 · whitelist & scaffold trio preserved — P0 · unit-mocked service · covers S3
- **Steps/table:** `getAppSettings(COMPANY,'garbage-key')` → `{code:'SETTINGS_NOT_SUPPORTED',404}` with `getPublishedAppByKey` never called; `'rate-me'` + `getPublishedAppByKey` → null → `APP_NOT_FOUND`; app found + `findActiveInstallation` → null → `APP_NOT_INSTALLED` (GET and PUT); `provisioning_failed` installation → `APP_NOT_INSTALLED`.
- **Expected:** `SETTINGS_ENABLED_APP_KEYS` (exported set) deep-equals `new Set(['rely-leads','rate-me'])`; `resolveSettingsInstallation` untouched (order: whitelist → published → connected).

### TC-S4-01 · rate-me settings GET shape — P0 · unit-mocked service · covers S4
- **Setup:** connected rate-me installation `{id:7, metadata:{settings:{google_review_url:'https://g.page/r/abc/review'}}}`; `getDomainByCompany` → the D1 row.
- **Expected:** result keys sort-equal `['app_key','domain','installation_id','public_host','settings']` (+`success`/`request_id` added by the route); `settings` deep-equal `{google_review_url:'https://g.page/r/abc/review'}`; `domain` embeds the row `{domain,status,verified_at,activated_at,last_checked_at,last_error}`; `public_host:'rate.albusto.com'`; **NO `catalogs`, NO `territory`** (those are rely-shaped); domainless company → `domain:null`.

### TC-S5-01 · google_review_url validation (PD-1) — P0 · unit-mocked service (+pure leg) · covers S5
- **Steps/table (PUT):** `'https://g.page/r/abc/review'` → stored+echoed; `'https://maps.app.goo.gl/xyz'` and `'https://search.google.com/local/writereview?placeid=1'` → stored (ANY https host — NO Google allowlist); `'  '` / `''` / `null` → stored `null` (clears the link); `'http://g.page/x'` / `'javascript:alert(1)'` / `'not a url'` / 501-char https URL / `42` → reject `{code:'INVALID_GOOGLE_REVIEW_URL', httpStatus:400}`.
- **Expected:** every 400: no `setInstallationSettings`, no `writeEvent`. Pure leg: `validateRateMeSettingsInput` called directly reproduces the table.

### TC-S6-01 · PUT wholesale replace + seeded-key survival — P1 · unit-mocked service · covers S6
- **Setup:** installation metadata `{seeded_by:'X', settings:{google_review_url:'https://old'}}`; `setInstallationSettings` mock echoes `metadata:{seeded_by:'X', settings:<arg>}`.
- **Expected:** PUT `{google_review_url:'https://g.page/new'}` → `setInstallationSettings` called ONCE with the COMPLETE settings object (`google_review_url` + stamped `updated_at` ISO + `updated_by:'crm-1'`); seeded `seeded_by` survives (top-level `||` merge seam — real-PG semantics already proven by `tests/relyLeadsSettings.db.test.js` TC-S3-DB-01, not duplicated); FE always sends the full object, never a patch.

### TC-S7-01 · rate-me settings_updated event — P1 · unit-mocked service · covers S7
- **Expected:** successful PUT with a URL → ONE `writeEvent` `{eventType:'settings_updated', payload:{app_key:'rate-me', has_google_review_url:true}}`; clearing (null) → `has_google_review_url:false`; `JSON.stringify(payload)` does NOT contain `'g.page'` — the URL VALUE never enters the audit trail.

### TC-S8-01 · authed-surface tenancy sweep — company from `req.companyFilter` ONLY — P0 · supertest route · covers S8 (NFR-3)
- **Setup:** injector `req.companyFilter={company_id:COMPANY_B}; req.user={crmUser:{id:'crm-b'}}; req.requestId='req-b'` + REAL `routes/marketplace.js`; resolution mocks per endpoint.
- **Steps/table (all SIX endpoints):** `GET/PUT …/rate-me/settings`, `PUT/DELETE …/rate-me/domain`, `POST …/domain/verify`, `POST …/tokens` — each with poisoned `?company_id=COMPANY_A` and body `{company_id:COMPANY_A}`.
- **Expected:** every service/query call receives COMPANY_B (never COMPANY_A — assert on `findActiveInstallation`/service-arg mock calls); responses carry `request_id:'req-b'`; with no installation each → `404 {success:false, code:'APP_NOT_INSTALLED'}` whose message does NOT contain COMPANY_A; verify-failed outcome still HTTP 200 (`{success:true, domain:{status:'failed', last_error}}` — chips not exceptions); DELETE happy → `200 {success:true}`.

### TC-S8-02 · 401/403 mount pin + two-line server.js discipline — P0 · structural · covers S8 (+H10/NFR-10) — `tests/rateMeUi.structural.test.js`
- **Expected:** `src/server.js` still matches `app.use('/api/marketplace', authenticate, requirePermission('tenant.integrations.manage'), requireCompanyAccess, marketplaceRouter);` (the inherited 401/403 chain for all six endpoints — same jest deviation as every marketplace suite: KC not driven); exactly 2 `RATE-ME-CRM-001` flagged additions (count of flag comments === 2); `routes/marketplace.js` reads company ONLY via the existing `companyId(req)` helper (no new `req.params/body/query` company reads — regex over the added route block); `authedFetch.ts` and `useRealtimeEvents.ts` contain no rate-me reference (untouched, invariant 17).

### TC-S9-01 · hosting radio semantics (PD-10) — P1 · structural · covers S9 — `tests/rateMeUi.structural.test.js`
- **Structural:** radio state DERIVES from domain-row existence (source: checked/selected expression references `domain` truthiness, e.g. `domain !== null`/`Boolean(domain)` — no independent `useState` persisted for hosting mode that survives re-fetch without derivation); the radio `onChange` handlers contain NO mutation/api call (`setRateMeDomain|removeRateMeDomain` absent from them); the Save handler PUTs settings ONLY (`saveRateMeSettings` present, domain fns absent); Remove wired to the DELETE endpoint (D13); reopening re-derives from the GET (`useQuery(['rate-me-settings'])` + `enabled: open`).
- **Manual:** flip radios with devtools network open → zero requests; Save → one PUT settings; Remove → one DELETE then radio returns to "On albusto.com".

### TC-S9-02 · dialog FORM-CANON + api wiring — P1 · structural · covers S9 (§7 interaction) — `tests/rateMeUi.structural.test.js`
- **Structural (`RateMeSettingsDialog.tsx` + `marketplaceApi.ts`):** `variant="panel"`, `DialogPanelHeader`, `DialogBody` + `md:px-8 md:py-7`, `max-w-[740px]`, `space-y-6`, `DialogPanelFooter`, ghost Cancel + primary Save, `FloatingField` for the Google-link + domain inputs, NO `variant="dialog"`, no hand-rolled close button (`aria-label="Close"` absent); `marketplaceApi.ts` exports `fetchRateMeSettings`, `saveRateMeSettings`, `setRateMeDomain`, `verifyRateMeDomain`, `removeRateMeDomain` + `RateMeSettingsResponse` typing `{settings:{google_review_url:string|null}; domain: RateMeDomain|null; public_host:string}` via `authedFetch`; every mutation invalidates `['rate-me-settings']`; errors → `toast.error(error.message` (humane server message); `IntegrationsPage.tsx` gates the Settings button on `app.app_key === 'rate-me' && app.installation?.status === 'connected'` (rely one-liner precedent); new FE sources contain NO `Blanc` and no raw hex outside tokens.

### TC-S10-01 · settings vs domain lifetime asymmetry — P1 · unit-mocked service · covers S10
- **Steps:** simulate disconnect→reinstall: `findActiveInstallation` returns a NEW installation `{id:9, metadata:{}}` (fresh row, no settings); `getDomainByCompany` still returns the OLD domain row (company-keyed).
- **Expected (both facts in ONE test):** GET → `settings.google_review_url === null` (gone with the old installation — rely risk-7 semantics) AND `domain` still embeds the surviving row with its status (no re-verification needed). No UI copy for this — ops-notes only (deliberate).

---

## U — RatePage `/r/:token` (`tests/rateMeUi.structural.test.js`; structural + replica-logic; FE has no jest DOM harness — each case lists a manual/browser step)

### TC-U1-01 · happy render canon — CRM-free, mobile-first, branded — P0 · structural · covers U1 (invariant 15)
- **Structural (`RatePage.tsx`):** uses plain `fetch(` — `authedFetch` ABSENT; imports NOTHING from `components/`, `hooks/useRealtimeEvents`, React Query or sonner (CRM-free by design — §7); inline styles with `IBM Plex Sans`/`Manrope`; logo dimension 52; h1 text template `How did ` + name + ` do?`; star hit targets sized ≥44 (a `44` px dimension on the star buttons); NO string `Blanc` anywhere in the new file; single context fetch (ONE `GET`-building expression for `/api/public/rate/`).
- **Manual:** open a minted link at 375 px — logo+name+h1+5 stars, one-handed reach, no CRM chrome/nav/login affordance.

### TC-U2-01 · branding fallbacks — P1 · structural · covers U2 (NFR-8)
- **Structural:** logo `<img>` rendered ONLY when `company_logo_url` truthy (no broken-img/placeholder box path); `onError` handler hides the img (sets hidden/removes src → name-only render — covers expired presign >1 h and S3 hiccups).
- **Manual:** null-logo token → name-only header; kill the presigned URL in devtools → img disappears, layout intact.

### TC-U3-01 · 5★ flow — immediate POST, replace-redirect, no double-submit — P0 · structural + replica · covers U3
- **Structural:** the 5-star branch POSTs immediately (no textarea in that path); redirect uses `window.location.replace(` (NOT `.href =`, NOT router push — Back must not re-land on the consumed page); stars disabled between tap and redirect (submitting-state guard on the star handlers).
- **Replica:** `next:'google_redirect'` + `redirect_url` → replace called with EXACTLY the server's `redirect_url` (never a client-built Google URL).
- **Manual:** tap 5★ → lands on the Google review page; Back does not return to the star picker.

### TC-U4-01 · 5★ without link — thanks fallback — P1 · structural · covers U4 (US-6)
- **Structural/replica:** `next:'thanks'` branch renders the thank-you view — no error, no redirect, no dead end; thanks copy present (warm tone, e.g. `Thanks! Your feedback means a lot to us.` — tone-level pin, spec marks the copy as tone).

### TC-U5-01 · 1–4★ flow — textarea + Send, only Send records — P0 · structural + replica · covers U5
- **Structural:** 1–4★ selection triggers NO fetch (the POST lives ONLY in the Send handler for this branch); textarea labeled `What could we have done better?`; Send enabled with an EMPTY textarea (text optional); star selection re-changeable before Send (no lock until submit).
- **Replica:** state machine — select 3 → select 2 → Send posts `{stars:2, feedback}`.
- **Manual:** tap 3★ → textarea appears; Send with empty box → thank-you.

### TC-U6-01 · already-rated GET → thanks, no picker — P1 · structural · covers U6 (US-3)
- **Structural:** `already_rated` branch renders the thank-you view DIRECTLY; the star-picker component/markup unreachable in that branch (same view as post-submit thanks).

### TC-U7-01 · replay POST → thanks, never an error — P1 · structural · covers U7
- **Structural:** response handling treats `already_recorded:true` as SUCCESS-class → thank-you view (a stale tab that posts after another device rated sees thanks, not an error).

### TC-U8-01 · POST failure honesty — P0 · structural + replica · covers U8 (NFR-8)
- **Structural:** catch/!ok path renders inline `Something went wrong — please try again.`; star selection state NOT reset in the error path; Send re-enabled; `window.location.replace` UNREACHABLE from the error path (no redirect on failure — pairs with TC-P18-01: the server never sends `redirect_url` on failure either); 429 handled by the SAME inline copy.
- **Manual:** block the POST in devtools → inline error, stars keep the selection, retry works.

### TC-U9-01 · direct-load errors — P1 · structural · covers U9
- **Structural:** context GET → 404 renders full-page `This link is no longer available.` with NO retry affordance (the link is dead by definition); network failure on GET → `Something went wrong — please try again.` WITH a retry affordance (two distinct branches).

### TC-U10-01 · technician-name fallback — P1 · structural + replica · covers U10
- **Structural/replica:** h1 expression `technician_name || 'our technician'`-equivalent: `'Alex Petrov'` → `How did Alex Petrov do?`; `null` → `How did our technician do?`.

### TC-U11-01 · SPA integration pins — P0 · structural · covers U11 (A1)
- **Structural:** `App.tsx` has `<Route path="/r/:token"` beside `/e/:token` AND has NO catch-all `path="*"` route (the `/r/` exact-empty-token edge stays a blank bare page, no redirect loop); `AuthProvider.tsx` `PUBLIC_AUTH_PATHS` literal EXACTLY `['/signup', '/pay', '/e', '/r/']` — **`'/r/'` WITH trailing slash** (`'/r'` bare would startsWith-match nothing needed and `/r` is gate-404ed anyway, H3; the `/e`≻`/estimates` quirk is NOT extended); `AppLayout.tsx` bare-return list gains `startsWith('/r/')` (no header/nav/softphone even on app hosts, H12); `authedFetch.ts`/`useRealtimeEvents.ts` byte-untouched (invariant 17).
- **Manual (console-noise budget):** on a rating host expect ONLY `manifest.webmanifest` 404 (+ possible SSE `/events` retry noise — `/pay` behavior class); RatePage itself must trigger neither KC redirect nor CRM fetches.

---

## C — Caddy & infra (`tests/rateMeUi.structural.test.js`; reference-file structural — live apply is the manual C4 procedure)

### TC-C1-01 · global on_demand_tls fragment — exact text — P1 · structural · covers C1
- **Expected (`infra/Caddyfile`):** the global options block still contains `email help@bostonmasters.com` and gains an `on_demand_tls` block whose normalized text contains EXACTLY `ask http://127.0.0.1:3000/api/public/rate-domain-ask`, `interval 2m`, `burst 5`. (Caddy 2.6.2 on the box: `interval`/`burst` valid there, REMOVED in ≥2.8 — README re-check note pinned in TC-C4-01.)

### TC-C2-01 · dedicated rate.albusto.com block — exact text — P1 · structural · covers C2
- **Expected:** a `rate.albusto.com {` site block containing `encode zstd gzip` and `reverse_proxy 127.0.0.1:3000` and NOT containing `on_demand` (normal managed certificate — option A NEVER depends on the ask path, FR-13).

### TC-C3-01 · https:// catch-all + existing blocks byte-identical — P1 · structural · covers C3
- **Expected:** an `https:// {` block containing `tls {` + `on_demand` + `reverse_proxy 127.0.0.1:3000`; append-only pin: the pre-feature site blocks survive VERBATIM — `albusto.com, www.albusto.com {` (static root), `app.albusto.com, api.albusto.com {` (incl. `handle_path /apps/leads*` → `127.0.0.1:4001`), `auth.albusto.com` → `:8081` — assert their exact existing lines are still contained (explicit host blocks always win over the catch-all).

### TC-C4-01 · README deploy procedure — P2 · structural · covers C4
- **Expected (`infra/README.md`):** a Rate Me section carrying, in order: (1) dark app deploy with mig 172 (CRM byte-identical, NFR-9); (2) owner GoDaddy A-record `rate → 108.61.87.117` (browser-only, no API); (3) Caddyfile apply via the EXISTING `caddy validate` → backup → swap → `sudo systemctl reload caddy` procedure; (4) smoke: `curl -H 'Host: rate.albusto.com' 127.0.0.1:3000/r/x` → uniform 404, then mint via the smoke endpoint (T1) and open the URL; (5) rollback = restore `Caddyfile.bak.<ts>` + reload; plus the Caddy-version note (2.6.2; `interval/burst` removed in ≥2.8 — re-check on upgrade). Prod deploy stays owner-consent-gated («да» per deploy).

---

## ISO — real-SQL isolation (in `tests/rateMe.db.test.js`)

### TC-ISO-DB-01 · real getTokenContext — host bind, expiry, PD-9, COALESCE name — P0 · db (self-skip, structural half always-on) · covers §3 matrix at SQL level (+T9, PD-9) · **SAB-TOKEN-CROSS-TENANT control**
- **Setup:** seed tagged companies A/B, a token of A (with `technician_profiles` override row `name='Alexander P.'` vs snapshot `tech_name='Alex Petrov'`), an EXPIRED token of A (`expires_at = NOW() - interval '1 hour'`), and a rated token (rating row present, `used_at` left NULL deliberately).
- **Steps/expected:** `getTokenContext(TOKEN_A, null)` → row (shared/token-only scope); `(TOKEN_A, A)` → row (own custom host); `(TOKEN_A, B)` → **undefined** (foreign host — the §3 red cell); `(EXPIRED, null)` → undefined (guard `expires_at IS NULL OR expires_at > NOW()`); rated token → `already_rated:true` even though `used_at IS NULL` (**PD-9: the rating row is the truth, `used_at` is a convenience stamp**); `technician_name === 'Alexander P.'` (COALESCE profile.name → tech_name snapshot).
- **Structural half (runs even when DB absent):** `rateMeQueries.js` source matches `/\$2::uuid IS NULL OR t\.company_id = \$2/` AND `/expires_at IS NULL OR expires_at > NOW\(\)/` AND joins `technician_ratings` via `rate_token_id` (LEFT JOIN truth).

---

## Coverage matrix (85/85)

| Spec scenario | Test case(s) | Priority | Type |
|---|---|---|---|
| T1 mint happy | TC-T1-01, TC-T1-02 | P0, P1 | service, route |
| T2 mint without job | TC-T2-01 | P1 | service |
| T3 job ownership | TC-T3-01 | P0 | service |
| T4 mint install gate | TC-T4-01 (+TC-D18-01) | P0 | service |
| T5 mint validation | TC-T5-01 | P1 | service |
| T6 format/collision | TC-T6-01 | P1 | service |
| T7 multi-open | TC-T7-01 | P1 | route |
| T8 rating-once anchor | TC-T8-DB-01 | P0 | db |
| T9 expiry | TC-P4-01 + TC-ISO-DB-01 | P1, P0 | route, db |
| T10 migration 177 | TC-T10-DB-01/02/03 | P0, P1, P2 | db ×3 |
| P1 GET happy 5 keys | TC-P1-01 | P0 | route |
| P2 unknown | TC-P2-01 (+TC-P6-01) | P0 | route |
| P3 malformed | TC-P3-01, TC-P3-02 | P0, P1 | route, pure |
| P4 expired | TC-P4-01 | P1 | route |
| P5 disconnected | TC-P5-01 (+TC-P6-01 leg) | P0 | service |
| P6 foreign-host + quintet | TC-P6-01 | P0 | route |
| P7 GET after rating | TC-P7-01 | P1 | route |
| P8 five_star_redirect | TC-P8-01 | P0 | route |
| P9 presign failure | TC-P9-01 | P1 | service |
| P10 POST 5★ + link | TC-P10-01 | P0 | route |
| P11 POST 5★ no link | TC-P11-01 | P0 | route |
| P12 1–4★ feedback | TC-P12-01, TC-P12-02 | P0, P1 | route, service |
| P13 body validation | TC-P13-01 | P0 | route |
| P14 identity injection | TC-P14-01 | P0 | route |
| P15 replay | TC-P15-01 | P0 | route |
| P16 concurrent race | TC-P16-01 (+TC-T8-DB-01) | P0 | service (+db) |
| P17 rate limits | TC-P17-01 | P1 | route |
| P18 storage failure | TC-P18-01 | P0 | service |
| P19 guard ordering | TC-P19-01 | P1 | route |
| §3 matrix (sweep) | TC-M3-01 + TC-ISO-DB-01 | P0, P0 | route, db |
| H1 pass-through zero-cost | TC-H1-01 | P0 | route |
| H2 shared allowlist | TC-H2-01 | P0 | route |
| H3 shared blocks + KC silence | TC-H3-01 | P0 | route |
| H4 manifest excluded | TC-H4-01 | P2 | route |
| H5 custom binds company | TC-H5-01 | P0 | route |
| H6 foreign token custom host | TC-H6-01 | P0 | route |
| H7 pending/failed/removed host | TC-H7-01 | P0 | route |
| H8 unknown host | TC-H8-01 | P1 | route |
| H9 fail-closed 503 | TC-H9-01 | P1 | route |
| H10 gate precedes mounts | TC-H10-01 (+TC-S8-02) | P0 | route+structural |
| H11 host cache | TC-H11-01 | P1 | service |
| H12 app-host smoke | TC-H12-01 | P1 | route |
| D1 set domain + normalize | TC-D1-01, TC-D1-02 | P0, P1 | service, pure |
| D2 invalid hostname | TC-D2-01 | P1 | service |
| D3 apex + copy | TC-D3-01 | P1 | service |
| D4 reserved | TC-D4-01 | P1 | service |
| D5 taken (PD-2) | TC-D5-01, TC-D5-DB-01 | P0, P1 | service, db |
| D6 replace own | TC-D6-01 (+TC-D5-DB-01) | P1 | service (+db) |
| D7 verify success | TC-D7-01 | P0 | service |
| D8 wrong target | TC-D8-01 | P1 | service |
| D9 NXDOMAIN copy | TC-D9-01 | P1 | service |
| D10 transport (PD-4) | TC-D10-01 | P1 | service |
| D11 no-demote | TC-D11-01 | P0 | service |
| D12 verify no row | TC-D12-01 | P2 | service |
| D13 remove | TC-D13-01 | P0 | service |
| D14 ask allow + activation | TC-D14-01 | P0 | route |
| D15 ask deny matrix | TC-D15-01 | P0 | route |
| D16 loopback guard | TC-D16-01 | P0 | route+pure |
| D17 ask cache | TC-D17-01 | P1 | service |
| D18 disconnect/reconnect | TC-D18-01 | P1 | service |
| D19 dialog CNAME/chips copy | TC-D19-01 | P1 | structural |
| S1 rely GET byte-identical | TC-S1-01 + stay-green rely suites | P0 | service+meta |
| S2 rely PUT byte-identical | TC-S2-01 + stay-green rely suites | P0 | service+meta |
| S3 whitelist/trio | TC-S3-01 | P0 | service |
| S4 rate-me GET shape | TC-S4-01 | P0 | service |
| S5 URL validation (PD-1) | TC-S5-01 | P0 | service+pure |
| S6 wholesale replace | TC-S6-01 | P1 | service |
| S7 event payload | TC-S7-01 | P1 | service |
| S8 auth matrix | TC-S8-01, TC-S8-02 | P0, P0 | route, structural |
| S9 hosting radio (PD-10) | TC-S9-01, TC-S9-02 | P1, P1 | structural ×2 |
| S10 lifetime asymmetry | TC-S10-01 | P1 | service |
| U1 happy render | TC-U1-01 | P0 | structural |
| U2 branding fallbacks | TC-U2-01 | P1 | structural |
| U3 5★ flow | TC-U3-01 | P0 | structural |
| U4 5★ no link | TC-U4-01 | P1 | structural |
| U5 1–4★ flow | TC-U5-01 | P0 | structural |
| U6 already-rated view | TC-U6-01 | P1 | structural |
| U7 replay view | TC-U7-01 | P1 | structural |
| U8 failure honesty | TC-U8-01 | P0 | structural |
| U9 direct-load errors | TC-U9-01 | P1 | structural |
| U10 name fallback | TC-U10-01 | P1 | structural |
| U11 SPA pins | TC-U11-01 | P0 | structural |
| C1 global fragment | TC-C1-01 | P1 | structural |
| C2 dedicated block | TC-C2-01 | P1 | structural |
| C3 catch-all + append-only | TC-C3-01 | P1 | structural |
| C4 README procedure | TC-C4-01 | P2 | structural |

**Deliberate scope notes:** no E2E/browser harness (repo has none — U/C cases are structural + manual steps, the RELY deviation); Keycloak 401/403 not driven in jest (mount-pin TC-S8-02, house-wide deviation); Caddy behavior itself (TLS handshake, ask subrequest, `interval/burst`) is NOT jest-testable — pinned as exact reference-file text (C1–C3) + the README smoke procedure (C4); the 5 s DNS race and 60 s cache TTL are pinned structurally, not with wall-clock timers (flake budget); non-goals (§9: SMS/auto-mint triggers, ratings viewing UI, configurable threshold, multi-domain, apex/ALIAS, periodic re-checks, light bundle, SSE) have NO cases by design.
