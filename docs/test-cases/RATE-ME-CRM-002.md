# Test Cases: RATE-ME-CRM-002 — humane 7-screen Rate Me page personalized from the job + review→job attribution (migration 178) + dispatcher "Send rating link" (SMS/Email/Copy) + `booking_url` rate-me setting (Phase 2, ADDITIVE on deployed 001)

**Spec (AUTHORITATIVE):** `Docs/specs/RATE-ME-CRM-002.md` (64 scenarios: GC1–12, RT1–6, BK1–8, SR1–12, SL1–12, JS1–7, BU1–7; §3 public-context contract; §4 ISO matrix; §5 exact contracts; §6 five named sabotage controls; §10 invariants 1–15; pins PD-RM2-1…11). **Architecture:** `Docs/architecture.md` §RATE-ME-CRM-002 (migration 178, D-EXP, `getPublicContext` flow, jobs-surface gates, `booking_url` setting — line 8089+). **Requirements:** `Docs/requirements.md` §RATE-ME-CRM-002 (US-RM2-1..7, FR-RM2-01..19, NFR-RM2-1..11, SAB list — line 6803+).
**Builds on:** RATE-ME-CRM-001 cases (`Docs/test-cases/RATE-ME-CRM-001.md`) — its suites (`tests/rateMe.db.test.js`, `tests/rateMeService.test.js`, `tests/publicRate.routes.test.js`, `tests/rateMeDomains.test.js`, `tests/rateMeUi.structural.test.js`) are EXTENDED (never rewritten) and every 001 case in them re-runs UNCHANGED (the NFR-RM2-1 regression pin).

## Locked design facts these cases assert against (from spec/arch/requirements — do not re-litigate)

1. **Public context = two HARD whitelists (§3, PD-RM2-9).** LIVE = **exactly 12 keys** `{company_name, company_logo_url, technician_name, first_name, service_label, visit_date, company_phone, company_email, booking_url, five_star_redirect, already_rated, expired:false}`. BRANDED-EXPIRED = **exactly 6 keys** `{expired:true, company_name, company_logo_url, company_phone, company_email, booking_url}`. A 13th/7th key = SAB-CONTEXT-PII-LEAK RED. **Only `first_name` (customer PII) ever leaves the context** — never last name, customer phone/email, any id (contact_id/job_id/token id), any raw timestamp (`start_date`/`used_at`/`opened_at`), or the Google URL.
2. **D-EXP non-oracle (PD-RM2-1).** `getTokenContext` stays **byte-identical** (its `(expires_at IS NULL OR expires_at > NOW())` filter is load-bearing → `submitRating`+beacon reject expired for free). `getPublicContext` gains a SECOND narrow lookup `getExpiredTokenBranding(token, host)` (exists + host-binds + IS expired). A branded-expired **200** (`expired:true`) is emitted ONLY for a real, host-binding, **connected**, expired token. Unknown / malformed / foreign-host / app-disconnected → `null` → **uniform 404, NO company data**. The uniform 404 is never turned into an oracle.
3. **Uniform 404 (byte-exact, 001-preserved):** `404 {ok:false,error:{code:'NOT_FOUND',message:'Invalid link'}}` — identical across malformed/unknown/expired-foreign/foreign-host/app-disconnected on GET, POST-rating, AND the new beacon. Gate 404s differ (001): `/api/*` → `{ok:false,error:{code:'NOT_FOUND',message:'Not found'}}`, page paths → plain-text `Not found`.
4. **`opened_at` (PD-RM2-6):** first-open-only `UPDATE … SET opened_at=NOW() WHERE id=$1 AND opened_at IS NULL`, **live path only**, host already bound by the read that produced `ctx`, **best-effort** (try/catch → stamp failure NEVER fails the GET). Branded-expired path does NOT stamp.
5. **Beacon `POST /api/public/rate/:token/click` (BK, PD-RM2-4):** `postRateLimiter` (reuse 10/min) → `requireRateToken` → `recordGoogleClick(token, req.rateHost?.companyId ?? null)`. Live token → `stampGoogleClick(ctx.id)` (`google_click_at IS NULL` guard, first-click-wins idempotent) → **204 empty body**. Unknown/malformed/expired/foreign/disconnected → uniform 404. Company/job derived from the **token only**, never the body. Rides the existing `rateHostGate` allowlist `/^\/api\/public\/rate(?:\/|-domain-ask)/` → **NO `src/server.js` change**.
6. **5★ new-tab (PD-RM2-4, SR3):** click handler order = `fetch('…/click',{method:'POST',keepalive:true}).catch(()=>{})` THEN `window.open(redirect_url,'_blank','noopener')` **inside the handler** (popup-blocker), then Screen 3. **NEVER `window.location.replace`.** A slow/failed beacon must not block the tab. (001 RatePage used `location.replace` — RM2 rewrites this; TC-U3-01's `location.replace` assertion is REPLACED by the RM2 SR cases.)
7. **Chips inert (FR-RM2-11):** on Screen 2 AND Screen 4 the chips are inert `<button>`s (thought-prompts). Tapping any chip inserts NOTHING into the textarea. Screen 2 fine print "Just prompts — your own words matter most."
8. **Personalization (§3.4):** `first_name` = `contact_first_name` (`jobs.contact_id→contacts.first_name`) || first whitespace token of `jobs.customer_name` || `null`. `service_label` = `jobs.service_name` || `null`. `visit_date` = `formatVisitDate(start_date, company_timezone)` = `Intl.DateTimeFormat('en-US',{timeZone,weekday:'long',month:'short',day:'numeric'})` (e.g. "Friday, Jul 12"), try/catch → `null` on bad tz, `null` when `start_date` null. `getTokenContext` SELECT gains `LEFT JOIN jobs j ON j.id=t.job_id` + `LEFT JOIN contacts ct ON ct.id=j.contact_id` (LEFT so a `job_id NULL` / deleted-job token still resolves) — **WHERE UNCHANGED**.
9. **Jobs surface (PD-RM2-2, PD-RM2-11):** both new endpoints in `backend/src/routes/jobs.js` (mounted `authenticate + requireCompanyAccess` at `src/server.js:213`), envelope `{ok:true,data}` / `{ok:false,code,message}`. `POST /:id/rate-link` → `requirePermission('messages.send')` (eta/notify precedent); `GET /:id/rate-status` → `requirePermission('jobs.view')`. `companyId = req.companyFilter?.company_id` (**NEVER `req.companyId`**). NOT on `/api/marketplace` (that mount is `tenant.integrations.manage` — admin-only, wrong for a dispatcher). Zero `src/server.js` change.
10. **Send-link order (PD-RM2-7):** load job (tenant-scoped `getJobById(id, companyId, getProviderScope(req))`) → resolve tech from `job.assigned_techs[0]` → mint FRESH token (`mintToken` — re-checks job∈company + connected install) → deliver → `stampTokenSent(token, companyId, via)` (`UPDATE … WHERE token=$1 AND company_id=$2`, company-scoped, single-valued → most-recent-send wins) **ONLY on channel success**. A failed SMS/email leaves an unsent token (no false "sent").
11. **Rate-status by `(company_id, job_id)` (PD-RM2-3):** the rating is read by `(company_id, job_id)` — NOT by the latest token — so a re-send NEVER hides an existing rating; `sent_at`/`sent_via`/`opened_at`/`google_click_at` reflect the **most-recent** `rate_tokens` row for the job.
12. **`booking_url` = a rate-me setting (PD-RM2-5, NFR-RM2-10).** JSONB in `marketplace_installations.metadata.settings` (alongside `google_review_url`), **NO DB column**. `validateRateMeSettingsInput` MUST parse and **RETURN BOTH** `{google_review_url, booking_url}` — because `updateAppSettings` spreads `...validated` and `setInstallationSettings` REPLACES `metadata.settings` wholesale, dropping either key on PUT WIPES it. Validation mirrors google: `null`/empty→`null`; else string, `new URL()`-parseable with `protocol==='https:'`, ≤500 chars, else `400 INVALID_BOOKING_URL`. `bookingUrl(metadata)` reader in `rateMeService.js` mirrors `googleReviewUrl`.
13. **Migration 178 (additive, idempotent, NOT boot-registered).** `ALTER TABLE rate_tokens ADD COLUMN IF NOT EXISTS` × 4: `opened_at TIMESTAMPTZ NULL`, `google_click_at TIMESTAMPTZ NULL`, `sent_at TIMESTAMPTZ NULL`, `sent_via TEXT NULL`. No `booking_url` column, no new index. `rollback_178` `DROP COLUMN IF EXISTS` in reverse. Next-free = 178 (re-check origin/master at push; renumber both ends if taken). Applied via psql, no code registry.
14. **Palette (PD-RM2-8, NFR-RM2-8).** Rating stars gold `#E0A72C` (filled) / `#D2D2D0` (empty), inline (rating-semantics exception). Every OTHER action ("Write my Google review", "Send to the team", "Book Visit", "Book your next visit →") uses `var(--blanc-accent)` (#7F42E1). Albusto v2 tokens, theme-aware. **The string "Blanc" NEVER renders in UI.**
15. **Protected/untouched (invariant 14, NFR-RM2-11):** `src/server.js`, `frontend/src/lib/authedFetch.ts`, `frontend/src/hooks/useRealtimeEvents.ts`; `backend/db/` touched only by migration 178; `companies` schema read-only; `submitRating` unchanged; the Google URL lives only in `submitRating.redirect_url` (POST /rating), never in GET.

## Harness & conventions (verified in-repo, inherited from 001)

- **Worktree run form (L-011..L-014):** worktrees have NO local `node_modules` — run via the main checkout: `unset NODE_USE_SYSTEM_CA; node --use-bundled-ca /Users/rgareev91/contact_center/twilio-front-integration/node_modules/jest/bin/jest.js tests/<file> --rootDir . --testPathIgnorePatterns "/node_modules/" --forceExit` (from the worktree root). Report the EXACT command executed.
- **L-014 — `--runInBand` for db suites:** any run combining ≥2 `*.db.test.js` files MUST add `--runInBand` (shared dev DB → `tuple concurrently updated` otherwise). `tests/rateMe.db.test.js` re-applies 177 twice in `beforeAll`; the RM2 db legs additionally apply `178_rate_token_attribution.sql` (idempotent double-apply is the proof).
- **Real-PG self-skip (`tests/rateMe.db.test.js`):** `beforeAll` probes `SELECT 1 FROM companies`; on failure sets `dbReady=false` and every DB leg self-skips with `console.warn('… SKIPPED-NEEDS-DB')`. **Structural halves (source-file `toMatch`) run even when skipped** — so migration-file existence / SQL-shape pins fire without a DB. Fixture companies/jobs are tagged `RM-${Date.now()}-${pid}` and dropped in `afterAll`; mutating legs use `withTxn` (BEGIN/ROLLBACK) so RM2 legs leave no residue.
- **Service-unit (`tests/rateMeService.test.js`):** `jest.mock('../backend/src/db/rateMeQueries')`, `…/marketplaceQueries` (`writeEvent`), `…/services/storageService` (`getPresignedUrl`), `…/db/connection` (txn client). `jest.resetModules()` + re-require per test (`freshService()`). Real `crypto`. RM2 adds mock fns `getExpiredTokenBranding`, `stampTokenOpened`, `stampGoogleClick`, `stampTokenSent`, `getJobRateStatus` to the `rateMeQueries` mock factory. `RateMeServiceError` unwrap via `expectServiceError(promise, code, httpStatus)`.
- **Public-route harness (`tests/publicRate.routes.test.js`):** bare `express()` mounting REAL `rateHostGate` → sentinel raw-webhook → `express.json()` → REAL `public-rate.js` at `/api/public` → sentinel authed/SPA routes. Mocks at the query seam ONLY (`rateMeQueries` faithful replica, `storageService`, `db/connection`, `marketplaceQueries`). RM2 extends the `getTokenContext` replica to return the join fields and adds a `getExpiredTokenBranding` replica (`rows.find(r => r.token===token && r.expired && (host==null || r.company_id===host))`), `stampTokenOpened`/`stampGoogleClick` spies. Host via `.set('Host', …)`; IP via `.set('X-Forwarded-For', …)`; **every rate-limit case uses a UNIQUE XFF** so cases never consume each other's window; the 11th-beacon case gets its own `describe` with `jest.resetModules()`.
- **Jobs-route harness (NEW `tests/rateMeJobs.routes.test.js`) — mirrors `tests/jobsEta.test.js`:** tiny `http`-based `request(app, method, path, body)` helper (no supertest dep); `jest.mock` on `jobsService` (`getJobById`), `conversationsService` (`getOrCreateConversation`/`sendMessage`), `emailService` (`sendEmail`), `rateMeService` (`mintToken`), `rateMeQueries` (`stampTokenSent`/`getJobRateStatus`), `db/connection`, plus the cheap require()-time stubs jobsEta uses. `routeApp({permissions, companyFilter})` injects `req.user`, `req.authz={scope:'tenant',permissions,scopes:{}}`, `req.companyFilter` and mounts the REAL `backend/src/routes/jobs.js` — so `requirePermission` runs for real (403 drivable at route level). The `401`-no-token leg is the mount-level `authenticate` — **pinned structurally** (no Keycloak in jest, the house-wide S8 deviation), not driven end-to-end.
- **`booking_url` settings (`tests/rateMeDomains.test.js`):** this file is already the home of the 001 settings-dispatch S-group and imports `marketplaceService.validateRateMeSettingsInput` + `getAppSettings`/`updateAppSettings`. The BU cases EXTEND it (validator table = pure-fn; PUT/GET round-trips through the real `updateAppSettings`/`getAppSettings` with the marketplaceQueries seam mocked). Rely-leads GET/PUT stay byte-identical (the NFR-RM2-10 regression pin — rely suites re-run with ZERO edits).
- **FE = NO DOM harness** (no vitest/jsdom). SR/Job-card/settings cases are **source-STRUCTURAL** jest checks (read `RatePage.tsx` / `JobRateMeBlock.tsx` / `RateLinkModal.tsx` / `JobStatusTags.tsx` / `RateMeSettingsDialog.tsx` / `jobsApi.ts` / `marketplaceApi.ts` and assert exact substrings + `between()` slices + faithful-replica logic), each paired with a manual/browser verification note. The full RatePage rewrite means several 001 U-cases (U1/U3/U4/U6/U7 assertions about the old single-view page + `location.replace`) are **REPLACED** by RM2 SR cases — the SR section supersedes them and the 001 U-assertions that reference removed source (e.g. `window.location.replace`) are updated in-place.
- **Baseline rule:** the Implementer's change must FIRST keep the stay-green list below green; only THEN are the new/extended assertions added.

## Coverage

- **Total test cases: 77** (72 assertion cases + 5 named sabotage-procedure controls that reuse existing assertion cases as their RED targets — no separate test code).
- **P0: 41 · P1: 35 · P2: 1 · P3: 0**
- **db (real PG, self-skip): 7 · service-unit (mocked): 16 · route-integration (supertest/http): 34 · FE-structural (+replica logic): 15 · sabotage-procedure: 5**
- Scenario matrix: **64/64** spec scenarios covered (GC 12/12, RT 6/6, BK 8/8, SR 12/12, SL 12/12, JS 7/7, BU 7/7) — table at the end. §4 ISO matrix additionally swept whole (TC-RM2-ISO-01) and at real-SQL level (TC-RM2-DB-02/03/06/07).
- **401/403:** route-level `403` (missing `messages.send` / `jobs.view`) is DRIVEN through the real `requirePermission` middleware in the mounted jobs router (TC-RM2-SL-07 / TC-RM2-JS-04); `401` (no token) is the UNTOUCHED `authenticate` at the `/api/jobs` mount — pinned structurally (TC-RM2-ST-01), the house-wide deviation.
- **Cross-company 404 (direct-access):** foreign job → `404 JOB_NOT_FOUND` on send-link (TC-RM2-SL-08) and empty `has_token:false` on rate-status (TC-RM2-JS-05), both because `getJobById`/`getJobRateStatus` filter `company_id`; foreign token/host → uniform 404 on GET+beacon (TC-RM2-GC-04, TC-RM2-BK-04, TC-RM2-ISO-01).

### Named sabotage controls (first-class; procedure: apply the sabotage manually, confirm RED, revert)

| # | Guard | Control case(s) — RED target | Sabotage edit | Exact RED condition |
|---|---|---|---|---|
| SAB-BUBBLE-INSERTS-TEXT | Prompt chips never mutate the textarea | **TC-RM2-SR-10** | Screen 2/4 chip `onClick={() => setFeedback(f => f + label)}` (or seed a review string) | TC-RM2-SR-10 RED: the source assertion that each Screen-2 AND Screen-4 chip is an inert `<button>` with NO `setFeedback`/`onChange`/textarea write in its handler fails; the "textarea value unchanged after every chip" replica fails |
| SAB-CONTEXT-PII-LEAK | §3 hard whitelist + host-bound queries | **TC-RM2-SV-01 / TC-RM2-SV-06** (deep-equal) + **TC-RM2-GC-06** + **TC-RM2-GC-04** | Add a forbidden field (`last_name`/`customer_phone`/`contact_id`/raw `start_date`/Google URL) to the `getPublicContext` DTO, OR drop the `$2` host-bind from `getTokenContext`/`getExpiredTokenBranding` | TC-RM2-SV-01 RED: live `data` keys ≠ the exact 12-set (deep-equal); TC-RM2-SV-06 RED: expired keys ≠ the exact 6-set; TC-RM2-GC-06 RED: `JSON.stringify(body)` contains a uuid / `g.page` / a raw ISO ts; TC-RM2-GC-04 RED: company-B token on company-A host returns 200 with B's branding instead of uniform 404 |
| SAB-GOOGLE-SAME-TAB | 5★ = beacon-then-new-tab, never same-tab | **TC-RM2-SR-04** + **TC-RM2-BK-01** | Replace `window.open(redirect_url,'_blank','noopener')` with `window.location.replace(redirect_url)` and/or delete the beacon `fetch` | TC-RM2-SR-04 RED: `RatePage.tsx` no longer contains `window.open(` with `'_blank'` in the "Write my Google review" handler (or now contains `location.replace`); the beacon `fetch(…/click…keepalive` is absent. TC-RM2-BK-01 RED: `google_click_at` stays null (no beacon POST → `stampGoogleClick` never called) |
| SAB-SENDLINK-CROSS-TENANT | Company filter scopes job load + every query | **TC-RM2-SL-08** + **TC-RM2-JS-05** | `getJobById(id, /* companyId */ null, …)` or `getJobRateStatus`/`stampTokenSent` dropping `company_id = $1` | TC-RM2-SL-08 RED: company-A dispatcher on a company-B job mints+sends (200) instead of `404 JOB_NOT_FOUND`; `mintToken`/`sendMessage` get called. TC-RM2-JS-05 RED: company-A rate-status returns company-B's `sent_at`/`rating` instead of `has_token:false` |
| SAB-ATTRIBUTION-WRONG-JOB | Company/job derive from the token only; rating read by `(company_id, job_id)` | **TC-RM2-BK-06** + **TC-RM2-JS-06** | Derive the beacon/stamp target from `req.body` (`stampGoogleClick(req.body.token_id)`), OR make `getJobRateStatus` read the rating by the latest token id | TC-RM2-BK-06 RED: a beacon body `{job_id:999, token_id:777}` stamps row 777/job 999 instead of the URL token's `ctx.id`. TC-RM2-JS-06 RED: after a re-send (token#2 unrated), the rating (recorded via token#1) disappears from rate-status |

### Stay-green list (run after implementation; all must pass UNCHANGED — NFR-RM2-1 regression proof)

| Suite | Why it must stay green |
|---|---|
| **Every 001 case** in `tests/rateMe.db.test.js` · `tests/rateMeService.test.js` · `tests/publicRate.routes.test.js` · `tests/rateMeDomains.test.js` · `tests/rateMeUi.structural.test.js` | RM2 EXTENDS these files. 001's GET DTO cases now assert the SUPERSET (12 keys) — the 001 5-key assertions (`TC-P1-01`, `TC-U6-01`) are updated in-place to the 12-key shape **only where the DTO legitimately grew**; all isolation/uniform-404/replay/host-gate/mint/domain cases re-run byte-identical. `submitRating` cases (TC-P10/P11/P12/P15/P16/P18) unchanged. |
| `tests/relyLeadsSettings.test.js` · `tests/relyLeadFilter.test.js` · `tests/relyLeadIngest.test.js` · `tests/relyLeadsUi.structural.test.js` · `tests/relyLeadsSettings.db.test.js` | **THE settings-integrity pin (BU6).** Only the `rate-me` settings handler changes; rely GET/PUT byte-identical — `git diff --stat master -- tests/relyLead*` prints nothing. |
| `tests/jobsEta.test.js` · `tests/jobsCreate.test.js` · `tests/jobsStatusRbac.test.js` · `tests/jobsProviderScope.test.js` · `tests/jobsRbacGates.test.js` | The two NEW `jobs.js` routes are additive; existing jobs endpoints + FSM + provider-scope + RBAC gates untouched. The eta/notify SMS pattern is the template — its suite must stay green. |
| `tests/marketplaceLeadgenSplit*.test.js` · `tests/googleEmailMarketplace.test.js` · `tests/marketplaceTelephonyOverlay.test.js` | `marketplaceService.js` change = one added key in the rate-me validator/response; other apps' install/credential/settings flows call none of it. |
| `tests/tenantSafetyLint.test.js` | ⚠️ Auto-scans `backend/src/routes|db|services`: the new/edited `public-rate.js`/`rateMeQueries.js`/`rateMeService.js` + the two `jobs.js` routes must use `req.companyFilter?.company_id` (NEVER `req.companyId`), parameterized SQL only, no `req.user.company_id` in routes. |
| `tests/routes/crmServerMount.test.js` · `tests/routes/marketplaceMount.test.js` | `toContain` pins on `src/server.js` mounts — RM2 adds ZERO server.js lines (beacon rides `/api/public`+gate allowlist; jobs routes ride `/api/jobs`), so these stay green with no tolerance change. |
| `npm run build` (frontend, `tsc -b`) | RatePage rewrite + JobRateMeBlock/RateLinkModal + JobStatusTags/jobsApi/RateMeSettingsDialog/marketplaceApi edits compile under prod-strict `noUnusedLocals`. |

### Proposed test files

| File | Kind | RM2 contents |
|---|---|---|
| `tests/rateMe.db.test.js` (EXTEND) | db (real PG, self-skip; `--runInBand` when combined) | migration 178 columns + double-apply + rollback (DB-01); `getTokenContext` join + WHERE-unchanged (DB-02); `getExpiredTokenBranding` (DB-03); `stampTokenOpened` idempotent (DB-04); `stampGoogleClick` idempotent (DB-05); `stampTokenSent` company-scoped most-recent (DB-06); `getJobRateStatus` rating-by-(company,job) + newest-token events (DB-07). |
| `tests/rateMeService.test.js` (EXTEND) | service-unit (mocked queries) | `getPublicContext` 12-key live (SV-01) / 6-key expired (SV-06) deep-equal; first-name fallback (SV-02); service/date degrade (SV-03); `formatVisitDate` tz + bad-tz (SV-04); already-rated live (SV-05); expired-vs-not_found / disconnected (SV-07); `opened_at` best-effort (SV-08); `recordGoogleClick` (SV-09); `bookingUrl` reader (SV-10). |
| `tests/publicRate.routes.test.js` (EXTEND) | route-integration (supertest, real gate+router) | GET live/branded-expired/unknown/foreign/disconnected envelopes + deep-equal + 001 backward-compat (GC-01..07); POST /rating 001 regression pin (RT-01); beacon 204/idempotent/malformed/uniform-404/rate-limit/token-only/host-gate (BK-01..07); ISO host×token sweep for GET+click (ISO-01). |
| `tests/rateMeJobs.routes.test.js` (NEW) | route-integration (http helper, real jobs router) | `POST /:id/rate-link` copy/sms/email happy + NO_PHONE/NO_PROXY/WALLET_BLOCKED/SMS_FAILED/NO_EMAIL/MAIL_DISCONNECTED/INVALID_CHANNEL/403/foreign-404/APP_NOT_INSTALLED/mint-fresh (SL-01..11); `GET /:id/rate-status` timeline/empty/sent-only/403/foreign-empty/rating-by-job (JS-01..06); structural company-scope + no-server-change pin (ST-01). |
| `tests/rateMeDomains.test.js` (EXTEND) | service-unit (+ marketplace-route round-trip) | `booking_url` PUT stores both keys (BU-01); validation taxonomy (BU-02); replace-on-PUT `google_review_url` survival (BU-03); GET shape (BU-04); event payload (BU-05); rely byte-identical regression (BU-06). |
| `tests/rateMeUi.structural.test.js` (EXTEND) | FE-structural (+replica logic) | RatePage page-state machine + 7 screens + chips-inert + 5★ beacon/new-tab + palette + placement + SPA pins (SR-01..13); Job-card RateMeBlock + RateLinkModal + jobsApi (SR-14); RateMeSettingsDialog + marketplaceApi `booking_url` (SR-15). |

Shared fixtures (per file): `COMPANY_X`/`COMPANY_Y` UUIDs; `TOKEN_X='Xtok_'.padEnd(32,'x')`-style 32-char base64url; a LIVE token row `{id:501, company_id:COMPANY_X, job_id:41, tech_id:'zb-77', tech_name:'Alex Petrov', technician_name:'Alex Petrov', already_rated:false, not_expired:true, expires_at:null, service_name:'Refrigerator repair', start_date:'2026-07-12T14:00:00.000Z', customer_name:'Sarah Chen', contact_first_name:'Sarah', company_name:'Boston Masters', logo_storage_key:'logos/x.png', company_timezone:'America/New_York', company_phone:'+16175551234', company_email:'hello@bostonmasters.com'}`; meta `{metadata:{settings:{google_review_url:'https://g.page/r/abc/review', booking_url:'https://book.bostonmasters.com'}}, installation_id:7, app_id:'app-rate'}`; an EXPIRED token row (`expires_at:'2020-01-01…'`, `not_expired:false`).

---

## DB — Migration 178 + `rateMeQueries` (`tests/rateMe.db.test.js`, real PG, self-skip)

### TC-RM2-DB-01 · migration 178 columns + idempotent double-apply + rollback drop order — P0 · db · covers FR-RM2-14, §9
- **Setup:** `beforeAll` applies `178_rate_token_attribution.sql` TWICE after 177 (reaching the test proves re-apply is a no-op). Structural half (always runs): filename `178_rate_token_attribution.sql` + `rollback_178_rate_token_attribution.sql` exist; up-file matches four `ADD COLUMN IF NOT EXISTS` for `opened_at`/`google_click_at`/`sent_at`/`sent_via`; up-file contains NO `booking_url` and NO `CREATE INDEX`.
- **Steps:** query `information_schema.columns` for `rate_tokens`; apply `rollback_178`; re-query; re-apply `178`.
- **Expected:** post-up, all four columns present — `opened_at`/`google_click_at`/`sent_at` = `timestamp with time zone`, `sent_via` = `text`, **all `is_nullable='YES'`**. Rollback drops them in reverse (`sent_via`→`sent_at`→`google_click_at`→`opened_at`) without error; after rollback the four columns are ABSENT while `rate_tokens` itself (and 177's `token`/`job_id`/`used_at`) survives; re-apply restores all four. Double-apply is a clean no-op (idempotent `IF NOT EXISTS`).

### TC-RM2-DB-02 · `getTokenContext` personalization join — SELECT extended, WHERE byte-identical — P0 · db · covers §3.5, invariant 8 · **SAB-CONTEXT-PII-LEAK db half**
- **Setup:** structural half (always runs): `rateMeQueries.js` source still matches `/\$2::uuid IS NULL OR t\.company_id = \$2/` AND `/expires_at IS NULL OR t\.expires_at > NOW\(\)/` (WHERE untouched) AND now matches `/LEFT JOIN jobs\s+j ON j\.id = t\.job_id/` + `/LEFT JOIN contacts\s+ct ON ct\.id = j\.contact_id/`. Seed a company (tz `America/New_York`, `contact_phone`/`contact_email` set), a job (`service_name='Refrigerator repair'`, `start_date`, `contact_id→contacts.first_name='Sarah'`), a token on that job.
- **Steps:** `getTokenContext(token, null)`; then `getTokenContext(token, COMPANY_B)`; then a token whose `job_id IS NULL`.
- **Expected:** row 1 exposes `service_name`, `start_date`, `customer_name`, `contact_first_name='Sarah'`, `company_timezone='America/New_York'`, `company_phone`, `company_email` alongside 001's fields; host-mismatch (`COMPANY_B`) still returns `undefined` (WHERE bind intact); the `job_id NULL` token STILL resolves (LEFT JOIN) with `service_name/start_date/contact_first_name = null`. Expired token still `undefined` (expiry filter intact).

### TC-RM2-DB-03 · `getExpiredTokenBranding` — exists + host-bind + IS expired — P0 · db · covers PD-RM2-1, D-EXP · **SAB-CONTEXT-PII-LEAK db half**
- **Setup:** structural half: `rateMeQueries.js` source matches `getExpiredTokenBranding` with `t.expires_at IS NOT NULL AND t.expires_at <= NOW()` AND the `$2::uuid IS NULL OR t.company_id = $2` host-bind. Seed company C + an EXPIRED token (`expires_at = NOW() - INTERVAL '1 hour'`) + a LIVE token.
- **Steps:** `getExpiredTokenBranding(expiredToken, null)`; `getExpiredTokenBranding(liveToken, null)`; `getExpiredTokenBranding(expiredToken, COMPANY_B)`.
- **Expected:** expired+shared → row `{company_id:C, company_name, logo_storage_key, contact_phone, contact_email}` (no job/first-name columns); live token → `undefined` (only expired rows match); expired on a foreign host → `undefined` (host-bind). The query returns NO `first_name`/`service_name`/`start_date`/token id.

### TC-RM2-DB-04 · `stampTokenOpened` — first-open-only idempotent — P1 · db · covers PD-RM2-6, GC10
- **Setup:** structural half: source matches `UPDATE rate_tokens SET opened_at = NOW\(\) WHERE id = \$1 AND opened_at IS NULL`. Seed token with `opened_at IS NULL`.
- **Steps:** `stampTokenOpened(id)`; read `opened_at`; `stampTokenOpened(id)` again; re-read.
- **Expected:** first call sets `opened_at` (non-null); second call is a no-op (`opened_at IS NULL` guard) — the timestamp is byte-unchanged from the first stamp. No overwrite path.

### TC-RM2-DB-05 · `stampGoogleClick` — first-click-wins idempotent — P1 · db · covers BK1/BK2
- **Setup:** structural half: source matches `UPDATE rate_tokens SET google_click_at = NOW\(\) WHERE id = \$1 AND google_click_at IS NULL`. Seed token, `google_click_at IS NULL`.
- **Steps:** `stampGoogleClick(id)`; read; `stampGoogleClick(id)` again; re-read.
- **Expected:** first sets `google_click_at`; second is a no-op; value unchanged. Replay-safe.

### TC-RM2-DB-06 · `stampTokenSent` — company-scoped, most-recent-send overwrites — P0 · db · covers PD-RM2-7, SL11 · **SAB-SENDLINK-CROSS-TENANT db half**
- **Setup:** structural half: source matches `UPDATE rate_tokens SET sent_at = NOW\(\), sent_via = \$3 WHERE token = \$1 AND company_id = \$2`. Seed company A + token T (job J); seed company B.
- **Steps:** `stampTokenSent(T, A, 'sms')`; read `sent_at`/`sent_via`; `stampTokenSent(T, A, 'email')`; re-read; `stampTokenSent(T, B, 'copy')` (WRONG company); re-read.
- **Expected:** first sets `sent_via='sms'`; second overwrites `sent_via='email'` with a fresh `sent_at` (single-valued, most-recent-send wins); the company-B stamp is a **no-op** (WHERE `company_id=$2` misses) — T's row unchanged. A foreign company can never stamp another company's token.

### TC-RM2-DB-07 · `getJobRateStatus` — rating by `(company_id, job_id)`, events from newest token — P0 · db · covers PD-RM2-3, JS6/JS7 · **SAB-ATTRIBUTION-WRONG-JOB db half + SAB-SENDLINK-CROSS-TENANT db half**
- **Setup:** structural half: source shows two `company_id = $1 AND job_id = $2` reads (one `rate_tokens` ordered newest-first, one `technician_ratings` ordered newest-first). Seed company A, job J; token#1 (sent+opened) with a `technician_ratings` row `stars=5`; then token#2 for the SAME (A, J), unrated, with a fresh `sent_at`.
- **Steps:** `getJobRateStatus(A, J)`; then `getJobRateStatus(A, foreignJobOfB)`; then `getJobRateStatus(B, J)`.
- **Expected:** (A,J) → `has_token:true`, `sent_at`/`sent_via`/`opened_at`/`google_click_at` from **token#2** (newest), but `rating:{stars:5, created_at}` from the rating tied to J (survives the re-send — read by `(company,job)`, not by token#2). (A, B's job) → empty `has_token:false, rating:null`. (B, J) → empty (company filter). No cross-company/cross-job bleed.

---

## SV — `getPublicContext` / attribution service legs (`tests/rateMeService.test.js`, mocked queries)

### TC-RM2-SV-01 · LIVE context = exactly the 12-key whitelist (deep-equal) — P0 · service-unit · covers GC1/GC11, §3.1 · **SAB-CONTEXT-PII-LEAK control**
- **Setup:** `getTokenContext` → the full join row (first_name 'Sarah', service 'Refrigerator repair', start_date, tz 'America/New_York', phone/email set, logo key); `getConnectedRateMeMeta` → META (google + booking configured); `getPresignedUrl` → presigned; `stampTokenOpened` spy resolves.
- **Steps:** `getPublicContext(TOKEN_X, null)`.
- **Expected:** returns an object whose keys **deep-equal (sorted)** exactly `['already_rated','booking_url','company_email','company_logo_url','company_name','company_phone','expired','first_name','five_star_redirect','service_label','technician_name','visit_date']` (12) with `first_name:'Sarah'`, `service_label:'Refrigerator repair'`, `visit_date:'Friday, Jul 12'`, `company_phone`/`company_email`/`booking_url` populated, `five_star_redirect:true`, `already_rated:false`, `expired:false`. `JSON.stringify` contains NO `last_name`, no `customer_name` full string, no `contact_id`/`job_id`/token id, no raw `start_date` ISO, no `g.page` Google URL. A 13th key fails the deep-equal.

### TC-RM2-SV-02 · first-name fallback chain — P1 · service-unit · covers GC2, §3.4
- **Steps/table:** (a) `contact_first_name:null, customer_name:'Sarah Chen'` → `first_name:'Sarah'` (first whitespace token); (b) `contact_first_name:null, customer_name:null` → `first_name:null`; (c) `contact_first_name:'Sarah'` present → `'Sarah'` (wins).
- **Expected:** never the last name, never the full `customer_name`; null degrades to `null` (FE greets "Hi there,"). All other 11 keys still present.

### TC-RM2-SV-03 · service/date graceful degrade — P1 · service-unit · covers GC3
- **Steps/table:** `service_name:null` and/or `start_date:null` (or `job_id NULL` → all join fields null).
- **Expected:** `service_label:null` and/or `visit_date:null`; the DTO STILL has all 12 keys (values null) — never a dropped key, never "—".

### TC-RM2-SV-04 · `formatVisitDate` in company tz + bad-tz safe — P1 · service-unit · covers GC4, §3.4
- **Setup:** `start_date:'2026-07-12T02:30:00Z'`. Structural: `rateMeService.js` matches `Intl.DateTimeFormat` with `weekday:'long'`, `month:'short'`, `day:'numeric'` and a `timeZone` arg, wrapped in try/catch.
- **Steps/table:** tz `America/Los_Angeles` vs `America/New_York` vs a malformed `'Not/AZone'`.
- **Expected:** `visit_date` reflects the COMPANY tz (LA → "Friday, Jul 11"; NY → "Friday, Jul 11" 22:30 local), NOT UTC/server tz; malformed tz → try/catch → `visit_date:null`, `getPublicContext` still returns the full DTO (no throw).

### TC-RM2-SV-05 · already-rated LIVE token → 12-key, personalized (Screen 6 signal) — P1 · service-unit · covers GC5
- **Setup:** `getTokenContext` row with `already_rated:true`; connected.
- **Expected:** full 12-key LIVE DTO with `already_rated:true`, `expired:false`, `first_name`/`technician_name` STILL present (Screen 6 uses them); `stampTokenOpened` still invoked on first open.

### TC-RM2-SV-06 · BRANDED-EXPIRED context = exactly the 6-key whitelist; NO opened_at stamp — P0 · service-unit · covers GC6/GC11, §3.2 · **SAB-CONTEXT-PII-LEAK control**
- **Setup:** `getTokenContext` → `undefined` (expired); `getExpiredTokenBranding` → `{company_id:C, company_name, logo_storage_key, contact_phone, contact_email}`; `getConnectedRateMeMeta(C)` → connected META (for `booking_url`); `getPresignedUrl` → presigned.
- **Steps:** `getPublicContext(EXPIRED_TOKEN, null)`.
- **Expected:** returns keys **deep-equal (sorted)** exactly `['booking_url','company_email','company_logo_url','company_name','company_phone','expired']` (6) with `expired:true`. NO `first_name`/`service_label`/`visit_date`/`technician_name`/`already_rated`/`five_star_redirect` (stale job context). `stampTokenOpened` **NOT called** on the expired path. A 7th key fails.

### TC-RM2-SV-07 · expired-vs-not_found / disconnected → null (non-oracle) — P0 · service-unit · covers GC9, D-EXP steps 1–2
- **Steps/table:** (a) live token but `getConnectedRateMeMeta` → `null` (disconnected) → `getPublicContext` → `null`, no presign, `getExpiredTokenBranding` NOT consulted only if arch step-1 returns null on disconnect (assert `null`); (b) unknown token: both `getTokenContext` AND `getExpiredTokenBranding` → `undefined` → `null`; (c) expired token whose company disconnected: `getExpiredTokenBranding` row present but `getConnectedRateMeMeta` → `null` → `null`.
- **Expected:** every leg returns `null` (→ router uniform 404). A branded payload is emitted ONLY when the expired row's company is connected. Reconnect (meta restored) → the live/branded path resolves again (nothing deleted).

### TC-RM2-SV-08 · `opened_at` first-open, best-effort (throw swallowed) — P1 · service-unit · covers GC10, PD-RM2-6, NFR-RM2-9
- **Steps/table:** (a) live first open → `stampTokenOpened(ctx.id)` called once with the token row's id; (b) `stampTokenOpened` rejects (DB error) → `getPublicContext` STILL resolves the full 12-key DTO (try/catch swallows; console.warn ok); (c) expired path → `stampTokenOpened` NEVER called.
- **Expected:** the stamp is fire-and-forget on the live path only; a stamp failure never fails the GET; the id passed is `ctx.id` (from the token read), never a body value.

### TC-RM2-SV-09 · `recordGoogleClick` — token-only, null-safe — P0 · service-unit · covers BK1/BK4/BK6 · **SAB-ATTRIBUTION-WRONG-JOB control**
- **Steps/table:** (a) `getTokenContext(token, host)` → live row → `stampGoogleClick(ctx.id)` called with the token row's id, returns truthy; (b) `getTokenContext` → `undefined` (unknown/expired/foreign) → returns `null`/false, `stampGoogleClick` NOT called; (c) assert `recordGoogleClick(token, host)` passes `host` straight into `getTokenContext` (host-bound) and derives the stamp target from `ctx.id` ONLY — no body/argument other than the URL token participates.
- **Expected:** company/job attribution comes from the token row; a null ctx stamps nothing (→ route 404).

### TC-RM2-SV-10 · `bookingUrl(metadata)` reader — P1 · service-unit · covers BU7
- **Steps/table (pure reader, mirrors `googleReviewUrl`):** `{settings:{booking_url:'https://book.co/x'}}` → `'https://book.co/x'`; `{settings:{booking_url:null}}` → `null`; `{settings:{}}` → `null`; `{}`/`undefined` → `null`; `{settings:{booking_url:42}}` (non-string) → `null`.
- **Expected:** returns the string only when a non-empty string; else `null`. Structural: `rateMeService.js` contains a `bookingUrl` export mirroring `googleReviewUrl`.

---

## GC/RT — Public GET context + rating regression (`tests/publicRate.routes.test.js`, real gate + router)

### TC-RM2-GC-01 · GET live → 200 with the 12-key envelope + opened_at side-effect — P0 · route-integration · covers GC1, §5.1
- **Setup:** faithful `getTokenContext` replica returns the join row for shared host; `getConnectedRateMeMeta`→META; presign→url; `stampTokenOpened` spy.
- **Steps:** `GET /api/public/rate/:TOKEN_X` Host `rate.albusto.com`.
- **Expected:** `200 {ok:true,data:{…12 keys…}}` with `expired:false`, personalization populated; `Object.keys(data)` length 12; `stampTokenOpened` called once with `501`. Query budget ≤ a handful + 1 presign.

### TC-RM2-GC-02 · GET branded-expired → 200 with the 6-key envelope, no stamp — P0 · route-integration · covers GC6, §5.1
- **Setup:** replica: `getTokenContext`→undefined for the expired token, `getExpiredTokenBranding`→branding row, connected.
- **Steps:** `GET /api/public/rate/:EXPIRED_TOKEN` Host `rate.albusto.com`.
- **Expected:** `200 {ok:true,data:{expired:true, company_name, company_logo_url, company_phone, company_email, booking_url}}`; `Object.keys(data)` length 6; `stampTokenOpened` NOT called; no `first_name`/`service_label`/`visit_date` in the body.

### TC-RM2-GC-03 · GET unknown/malformed → uniform 404 — P0 · route-integration · covers GC7
- **Steps/table:** `abc` (short) · 65-char · `..%2F..%2Fetc` · non-base64url 32-char → each uniform 404 with `getTokenContext` `.not.toHaveBeenCalled()` (requireRateToken pre-DB); a well-formed unknown token → both queries miss → uniform 404.
- **Expected:** every body deep-equals `{ok:false,error:{code:'NOT_FOUND',message:'Invalid link'}}`. No branding.

### TC-RM2-GC-04 · GET foreign-host token → uniform 404 (host-bind, no B data) — P0 · route-integration · covers GC8, §4 · **SAB-CONTEXT-PII-LEAK control**
- **Setup:** custom domain `rate.bostonmasters.com` bound to COMPANY_X (`getServableDomain`→verified); request a COMPANY_Y token.
- **Steps:** `GET /api/public/rate/:TOKEN_Y` Host `rate.bostonmasters.com`.
- **Expected:** `getTokenContext` called with `(TOKEN_Y, COMPANY_X)` (host-bind reached the query) AND `getExpiredTokenBranding` called with `(TOKEN_Y, COMPANY_X)` — both miss → uniform 404; `JSON.stringify(body)` contains NO company-Y name/logo/phone/booking. Company D's data never appears on C's host.

### TC-RM2-GC-05 · GET app-disconnected → uniform 404 (non-oracle) — P0 · route-integration · covers GC9
- **Setup:** live token row present, but `getConnectedRateMeMeta(COMPANY_D)`→null.
- **Expected:** `getPublicContext`→null → uniform 404, byte-identical to the unknown-token 404; no presign; indistinguishable from a nonexistent token (D-EXP non-oracle).

### TC-RM2-GC-06 · GET 12-key deep-equal at the route + no PII in the wire body — P0 · route-integration · covers GC11, §3.3 · **SAB-CONTEXT-PII-LEAK control**
- **Steps:** GET a live token; assert `Object.keys(body.data).sort()` deep-equals the exact 12-set; assert `JSON.stringify(body)` does NOT contain the company uuid, the Google URL, the raw `start_date` ISO string, the customer last name, or any `contact_id`/`job_id`.
- **Expected:** exactly 12 keys; zero forbidden substrings. Adding a forbidden field to the DTO flips this RED.

### TC-RM2-GC-07 · 001 backward-compat — 5 original fields present & unchanged — P0 · route-integration · covers GC12, NFR-RM2-1
- **Steps:** GET a live token; assert the 001 quintet `company_name`, `company_logo_url`, `technician_name`, `already_rated`, `five_star_redirect` are present with the SAME shapes/values 001 produced (an old client reads them unchanged); the 7 new keys are additive.
- **Expected:** no 001 route-contract break; the extended DTO is a strict superset. (This case updates 001's `TC-P1-01` 5-key deep-equal to the 12-key superset in the same file.)

### TC-RM2-RT-01 · POST /rating 001 contract UNCHANGED after the context extension — P0 · route-integration · covers RT1–RT6, invariant 1
- **Steps/table (regression pin — must remain byte-identical to 001):** first 5★+link → `{recorded:true,next:'google_redirect',redirect_url:'<google>'}`; 5★ no link → `{recorded:true,next:'thanks'}` (no `redirect_url` key); 1–4★ `feedback:'  late arrival  '` → `{recorded:true,next:'thanks'}`, stored `'late arrival'`; replay → `{recorded:false,already_recorded:true,next:'thanks'}` (no redirect); body validation `stars∉int1-5`/`feedback` non-string → `400 INVALID_STARS`/`INVALID_FEEDBACK` pre-DB; expired/unknown/foreign → uniform 404.
- **Expected:** every shape identical to 001 (`submitRating` UNCHANGED; the Google URL appears ONLY here as `redirect_url`, never in GET). Confirms the `getTokenContext` SELECT extension did not perturb POST.

---

## BK — Click beacon `POST /api/public/rate/:token/click` (`tests/publicRate.routes.test.js`)

### TC-RM2-BK-01 · beacon happy → 204 empty + stamp — P0 · route-integration · covers BK1, §5.1 · **SAB-GOOGLE-SAME-TAB control (beacon half)**
- **Setup:** live token, connected, correct host, `stampGoogleClick` spy.
- **Steps:** `POST /api/public/rate/:TOKEN_X/click` Host `rate.albusto.com` (no meaningful body).
- **Expected:** `204` with an EMPTY body; `getTokenContext` called `(TOKEN_X, null)` (shared host); `stampGoogleClick(501)` called once. Dropping the client beacon leaves `google_click_at` null (the SAB RED signal, paired with TC-RM2-SR-04).

### TC-RM2-BK-02 · beacon idempotent (first-click wins) — P1 · route-integration · covers BK2
- **Setup:** replica where `stampGoogleClick` treats an already-set `google_click_at` as a no-op.
- **Steps:** two beacons for the same token.
- **Expected:** both `204`; `google_click_at` unchanged after the second (the `IS NULL` guard makes it a no-op). Replay-safe.

### TC-RM2-BK-03 · beacon malformed token → uniform 404 (pre-DB) — P1 · route-integration · covers BK3
- **Steps:** `POST /api/public/rate/abc/click`.
- **Expected:** `requireRateToken` rejects before any DB read → uniform 404; `getTokenContext` `.not.toHaveBeenCalled()`.

### TC-RM2-BK-04 · beacon unknown/expired/foreign/disconnected → uniform 404 — P0 · route-integration · covers BK4
- **Steps/table:** unknown token; expired token (shared host); COMPANY_Y token on COMPANY_X custom host; disconnected-company token.
- **Expected:** every leg → uniform 404 (byte-identical to GET/POST-rating 404s). `recordGoogleClick` → null ctx → route 404; no stamp. Same non-oracle guarantee.

### TC-RM2-BK-05 · beacon rate-limited (reuse 10/min POST limiter, XFF-keyed) — P1 · route-integration · covers BK5 · own `describe` + `jest.resetModules()`
- **Steps:** 10 beacons from one XFF hop pass; the 11th within 60 s → `429 {ok:false,error:{code:'RATE_LIMITED',message:'Too many requests'}}` + `RateLimit-*` headers; a different XFF → independent, passes.
- **Expected:** exact 429 body; the beacon shares `postRateLimiter` (structural: `public-rate.js` mounts the click route with `postRateLimiter`).

### TC-RM2-BK-06 · beacon company/job from the TOKEN only — P0 · route-integration · covers BK6, §4 · **SAB-ATTRIBUTION-WRONG-JOB control**
- **Steps:** `POST /api/public/rate/:TOKEN_X/click` with body `{job_id:999, company_id:'X', token:TOKEN_Y, token_id:777}`.
- **Expected:** `204`; the stamp targets the URL token's `ctx.id` (501) ONLY — `stampGoogleClick` called with `501`, never `777`/`999`; the body is ignored entirely. A body-derived target flips this RED.

### TC-RM2-BK-07 · beacon rides the host-gate allowlist — zero server.js change — P1 · route-integration + structural · covers BK7, §5.1
- **Route half:** on a non-serving/foreign host the `rateHostGate` 404s the `…/click` path BEFORE the router (H-group behavior).
- **Structural half:** `rateHostGate.js` allowlist regex `/^\/api\/public\/rate(?:\/|-domain-ask)/` matches `/api/public/rate/<token>/click`; `src/server.js` has ZERO new `RATE-ME-CRM-002` mount lines (the beacon is under the existing `/api/public` mount). `crmServerMount`/`marketplaceMount` pins unchanged.

---

## SR — 7-screen RatePage UX (`tests/rateMeUi.structural.test.js`, source-structural + replica; manual browser steps)

### TC-RM2-SR-01 · page-state machine — GET/POST branch table — P0 · FE-structural · covers §4 SR page-state, §7
- **Steps (source `between()` slices + replica):** the load effect maps `response.status===404`→`invalid`, network error→`load-error`, `data.expired===true`→`expired`, `data.already_rated===true`→`already-rated`, else→`invitation`. Star select: `5`→`submitRating(5)`; `1–4`→`feedback` state with NO POST. On `google_redirect`→`google-helper`; on `thanks`→`happy`; POST `already_recorded`→`already-rated`.
- **Expected:** the `PageState` union includes `invitation|google-helper|happy|feedback|feedback-thanks|already-rated|expired|invalid|load-error|loading`; the branch replica reproduces the §7 transitions exactly.
- **Manual:** open a minted link and walk 5★ (with/without link), 3★, already-rated, expired, and a 404 token; confirm each lands on the right screen.

### TC-RM2-SR-02 · Screen 1 invitation — greeting + omit-missing subline + gold stars — P1 · FE-structural · covers SR1, FR-RM2-03
- **Expected:** greeting replica = `first_name ? 'Hi ${first},' : 'Hi there,'`; headline `How did ${technician_name || 'our technician'} do?`; subline joins `service_label`/`visit_date` with `·` and OMITS a null part (never "—"); five gold `StarPicker` buttons with `minWidth/minHeight ≥44`; NO contacts/rebooking on Screen 1; single context `fetch(endpoint)`.
- **Manual:** at 375px, one-handed stars; null-name greets "Hi there,"; a job with only a service (no date) shows just the service.

### TC-RM2-SR-03 · Screen 2 exists only when `five_star_redirect` — P1 · FE-structural · covers SR2
- **Expected:** the 5★ handler branches on the POST result `next`: `google_redirect`→Screen 2, `thanks`→Screen 3 directly (no Screen 2, no dead end). Source shows no unconditional Screen-2 render.
- **Manual:** a company without a Google link → 5★ goes straight to the happy thank-you.

### TC-RM2-SR-04 · Screen 2 → beacon-then-new-tab, NEVER same-tab — P0 · FE-structural · covers SR3, PD-RM2-4 · **SAB-GOOGLE-SAME-TAB control (page half)**
- **Steps (the "Write my Google review" handler slice):** contains, in order, `fetch(` … `/click` … `method: 'POST'` … `keepalive: true` … `.catch(` THEN `window.open(` … `'_blank'` … `'noopener'`; then transitions to the happy screen. The whole `RatePage.tsx` source does NOT contain `window.location.replace(` or `location.href =` on the Google path (the 001 `location.replace` is removed by the rewrite).
- **Expected:** beacon fires before `window.open`; the new tab opens `_blank`; Screen 3 stays mounted behind it. Replacing `window.open` with `location.replace` (or deleting the beacon) flips RED.
- **Manual:** tap 5★ → "Write my Google review"; a NEW tab opens Google and the "You're the best" thank-you is still visible behind it; the beacon POST appears in Network.

### TC-RM2-SR-05 · Screen 3 happy — quiet violet link, contacts, omit-when-null — P1 · FE-structural · covers SR4, FR-RM2-05/12
- **Expected:** gold mark; `You're the best, ${first_name}.`; tech signature `— ${technician_name} & the ${company_name} crew`; a **quiet violet text-link** "Book your next visit →" (NOT a filled button) gated on `booking_url`; `tel:`/`mailto:` gated on `company_phone`/`company_email`. Each affordance omitted when its value is null.
- **Manual:** null `booking_url` hides the link; null phone/email hides that contact; no dead links.

### TC-RM2-SR-06 · Screen 4 feedback — no auto-POST, inert chips, plaque, violet Send — P1 · FE-structural · covers SR5, FR-RM2-06
- **Expected:** 1–4★ sets state WITHOUT calling `submitRating`; a `<textarea>` "What could we have done better?"; inert topic chips `Timing · Communication · The repair · Pricing`; privacy plaque `Private — only ${company_name} sees this`; violet "Send to the team" → `submitRating(selectedStars, feedback)` → Screen 5. Stars re-selectable until Send; Send not disabled by empty feedback.
- **Manual:** choose 3, change to 2, Send an empty textarea → only the Send click POSTs `stars=2`.

### TC-RM2-SR-07 · Screen 5 feedback-thanks — contacts only, NO rebooking — P1 · FE-structural · covers SR6, FR-RM2-07
- **Expected:** green check; `Thank you — we hear you.`; `A manager from ${company_name} will reach out to make this right.`; "Prefer to talk now?" + `tel:`/`mailto:` contacts; **NO "Book Visit"/booking affordance anywhere on Screen 5** (tone). Source assertion: the Screen-5 slice contains no `booking_url` reference.
- **Manual:** a 2★ path ends on a thank-you with contacts and NO rebooking button.

### TC-RM2-SR-08 · Screen 6 already-rated — filled Book Visit + contacts, no picker — P1 · FE-structural · covers SR7, FR-RM2-08
- **Expected:** reached via GET `already_rated:true` OR POST `already_recorded:true`; violet check; NO star picker in this state; warm line using `first_name`/`technician_name`; rebooking block "Need help again? / Book your next service anytime"; **filled violet "Book Visit"** → `booking_url` (omit if null); contacts.
- **Manual:** open a rated token → rebooking screen, no stars; a stale second tab that POSTs after another device rated shows Screen 6, not an error.

### TC-RM2-SR-09 · Screen 7 expired vs generic invalid — P0 · FE-structural · covers SR8, FR-RM2-09, D-EXP
- **Expected:** `data.expired===true` → Screen 7 (clock mark + SAME rebooking block as Screen 6, from the branded-expired payload) + contacts; a `404` (unknown/malformed/foreign/disconnected) → the generic `This link is no longer available.` with **NO branding, NO booking, NO contacts** (001 preserved); network error → a `load-error` retry affordance. The invalid-view slice contains no `company_name`/`booking_url`/contacts.
- **Manual:** an expired-but-recognized link shows the company's Book Visit; a random/foreign token shows the bare generic message.

### TC-RM2-SR-10 · chips insert NOTHING on Screen 2 AND Screen 4 — P0 · FE-structural · covers SR9, FR-RM2-11 · **SAB-BUBBLE-INSERTS-TEXT control**
- **Steps:** slice both the Screen-2 chip block and the Screen-4 chip block; assert each chip is an inert `<button>` whose `onClick` (if any) does NOT call `setFeedback`/`onChange`/any textarea setter and does not concatenate the label into state; assert Screen 2 carries the fine print `Just prompts — your own words matter most.`; a faithful replica clicking every chip leaves the textarea value string unchanged.
- **Expected:** zero textarea mutation from any chip on either screen. A chip `onClick={()=>setFeedback(f=>f+label)}` flips RED.
- **Manual:** tap every chip on both screens; the textarea never changes.

### TC-RM2-SR-11 · palette — gold stars only non-violet; no "Blanc"; token-only colors — P1 · FE-structural · covers SR10, PD-RM2-8, NFR-RM2-8
- **Expected:** star fill uses inline `#E0A72C`, empty `#D2D2D0` (the only literal hex allowed, rating-semantics); every OTHER action ("Write my Google review", "Send to the team", "Book Visit", "Book your next visit →") uses `var(--blanc-accent)`; `RatePage.tsx` source does NOT match `/Blanc/` and contains no stray hex outside the two gold values (`#7F42E1`/others come from CSS vars). Theme-aware.
- **Manual:** light + dark render; stars gold, buttons violet; grep the DOM for "Blanc" → none.

### TC-RM2-SR-12 · booking/contacts placement matrix — P1 · FE-structural · covers SR11, FR-RM2-12
- **Expected (per-screen source assertion):** filled "Book Visit" ON Screens 6 & 7; quiet text-link ON Screen 3; NONE on Screen 5; NONE on Screens 1/2/4; contacts ON Screens 3/5/6/7 only; every booking/contact affordance gated on its per-company value (omit-when-null).
- **Manual:** sweep all 7 screens; the affordance appears exactly where the matrix says and nowhere else.

### TC-RM2-SR-13 · SPA integration pins (001 preserved) — P0 · FE-structural · covers SR12, AR5
- **Expected:** `App.tsx` keeps `<Route path="/r/:token" element={<RatePage />} />` and no catch-all `*`; `AuthProvider.tsx` `PUBLIC_AUTH_PATHS` includes `'/r/'`; `AppLayout.tsx` bare-returns for `location.pathname.startsWith('/r/')`; `RatePage.tsx` imports ZERO CRM chrome (no `components/`, no `useRealtimeEvents`, no `@tanstack/react-query`, no `sonner`), uses raw `fetch` and NEVER `authedFetch`; `apiClient.ts`/`useRealtimeEvents.ts` contain no `/r/`/`rate-me` reference (protected files untouched).
- **Manual:** direct-load `/r/<token>` on an app host → no Keycloak redirect, no CRM chrome.

### TC-RM2-SR-14 · Job-card Rate Me block + Send-link modal + jobsApi — P1 · FE-structural · covers FR-RM2-16/18, arch §Frontend
- **Expected:** `JobRateMeBlock.tsx` fetches `getRateStatus(jobId)` and renders the timeline steps **Rating link sent** ({sent_at}·{sent_via}) → **Opened** ({opened_at}) → **Rated** (★N + created_at) → **Opened Google review** ({google_click_at}), each rendered ONLY when its timestamp exists, and hosts the "Send rating link" button; `RateLinkModal.tsx` uses `<Dialog variant="panel">` (FORM-CANON — `DialogPanelHeader`/`DialogBody`/`DialogPanelFooter`), offers SMS/Email/Copy, DISABLES SMS when no `customer_phone` and Email when no `customer_email` with an honest reason, calls `jobsApi.sendRateLink`, Copy→clipboard, surfaces a `RateLinkError` (mirrors `EtaNotifyError`) for `WALLET_BLOCKED`/`NO_PHONE`/`NO_EMAIL`/`MAIL_DISCONNECTED`, and refreshes the block on success; `JobStatusTags.tsx` `JobOpsSection` renders `<JobRateMeBlock>` in the JOB-ACTIONS-SLIM band; `jobsApi.ts` exports `sendRateLink(id, channel)` (`POST /:id/rate-link`) + `getRateStatus(id)` (`GET /:id/rate-status`) via the existing `authedFetch`; no `/Blanc/`, no stray hex.
- **Manual:** on a job card, the block shows the timeline; Send → modal → Copy/SMS/Email; wallet/mail errors surface honestly.

### TC-RM2-SR-15 · RateMeSettingsDialog + marketplaceApi `booking_url` — P1 · FE-structural · covers BU (FE), US-RM2-6
- **Expected:** `RateMeSettingsDialog.tsx` adds a `booking_url` `FloatingField` (https hint) BESIDE `google_review_url`; `handleSave` sends the FULL object `{ google_review_url, booking_url }` (never a partial that would wipe the sibling); `marketplaceApi.ts` extends `RateMeSettingsResponse.settings` with `booking_url: string | null` and includes it in the GET/PUT payloads; FORM-CANON preserved (`variant="panel"`, no `variant="dialog"`); no `/Blanc/`, no stray hex.
- **Manual:** set a Booking URL, Save, reopen → it persists AND the Google link survived; clear it → the customer "Book Visit" affordances disappear.

---

## SL — Send rating link `POST /api/jobs/:id/rate-link` (`tests/rateMeJobs.routes.test.js`, real jobs router)

### TC-RM2-SL-01 · copy channel — 200 + url + stamp — P1 · route-integration · covers SL1, §5.2
- **Setup:** `routeApp({permissions:['messages.send']})`; `getJobById(41, COMPANY_X, scope)`→job; `mintToken`→`{token, url:'https://rate.albusto.com/r/<token>'}`; `stampTokenSent` spy.
- **Steps:** `POST /api/jobs/41/rate-link` `{channel:'copy'}`.
- **Expected:** `200 {ok:true,data:{channel:'copy', url:'https://rate.albusto.com/r/<token>', sent_at:'<iso>'}}`; `stampTokenSent(token, COMPANY_X, 'copy')` called; no SMS/email seam touched.

### TC-RM2-SL-02 · SMS happy — 200 (no url) + eta/notify chain + stamp — P1 · route-integration · covers SL2
- **Setup:** job has `customer_phone`; `resolveCompanyProxyE164`→proxy DID (via mocked `db.query` MRU); `getOrCreateConversation`→conv; `sendMessage`→ok.
- **Steps:** `{channel:'sms'}`.
- **Expected:** `toE164(customer_phone)` → proxy → `getOrCreateConversation` → `sendMessage(conv.id,{body:'<link msg>', author:'agent'})`; `stampTokenSent(token, COMPANY_X, 'sms')`; `200 {ok:true,data:{channel:'sms', sent_at:'<iso>'}}` with NO `url`. Mirrors eta/notify exactly.

### TC-RM2-SL-03 · SMS recipient/proxy missing — 422, no stamp — P1 · route-integration · covers SL3
- **Steps/table:** no/`un-normalizable` `customer_phone` → `422 {ok:false,code:'NO_PHONE',message:'No phone number on file for this customer.'}`; phone ok but `resolveCompanyProxyE164`→null → `422 {ok:false,code:'NO_PROXY',message:'No sending number configured for your company.'}`.
- **Expected:** `sendMessage` not called; `stampTokenSent` NOT called (send never attempted).

### TC-RM2-SL-04 · SMS wallet / transport failure — no false "sent" — P0 · route-integration · covers SL4, PD-RM2-7
- **Steps/table:** `sendMessage` throws `{code:'WALLET_BLOCKED', httpStatus:402}` → `402 {ok:false,code:'WALLET_BLOCKED',message:'Messaging is paused — top up your balance.'}`; any other throw → `502 {ok:false,code:'SMS_FAILED',message:"Couldn't send the message. Please try again."}`.
- **Expected:** `stampTokenSent` NOT called on either failure — the token stays unsent (no false "sent" surfaced). Mirrors eta/notify.

### TC-RM2-SL-05 · Email happy — 200 + stamp — P1 · route-integration · covers SL5
- **Setup:** job has `customer_email`; `emailService.sendEmail`→ok.
- **Steps:** `{channel:'email'}`.
- **Expected:** `sendEmail(COMPANY_X,{to:customer_email, subject:'<…>', body:'<link>', userId})`; `stampTokenSent(token, COMPANY_X, 'email')`; `200 {ok:true,data:{channel:'email', sent_at:'<iso>'}}`.

### TC-RM2-SL-06 · Email recipient missing / mailbox disconnected — no stamp — P1 · route-integration · covers SL6
- **Steps/table:** no `customer_email` → `422 {ok:false,code:'NO_EMAIL',message:'No email on file for this customer.'}`; `sendEmail` throws (mailbox disconnected) → `409 {ok:false,code:'MAIL_DISCONNECTED',message:'Connect a mailbox to send email.'}`.
- **Expected:** honest error, no crash; `stampTokenSent` NOT called on failure.

### TC-RM2-SL-07 · permission gate — 403 (route-level) + 401 (structural) — P0 · route-integration · covers SL7, invariant on the authed surface
- **Steps:** `routeApp({permissions:[]})` (authenticated but WITHOUT `messages.send`) → `POST /api/jobs/41/rate-link {channel:'copy'}` → **403** from the real `requirePermission('messages.send')`; `getJobById`/`mintToken` not reached.
- **Expected:** 403 body per the permission middleware; the 401-no-token leg is the UNTOUCHED `authenticate` at the `/api/jobs` mount (pinned in TC-RM2-ST-01, not driven — no Keycloak in jest).

### TC-RM2-SL-08 · tenant scope — foreign job → 404, no mint/send — P0 · route-integration · covers SL8, §4 · **SAB-SENDLINK-CROSS-TENANT control**
- **Setup:** dispatcher of COMPANY_X; `getJobById(:B_job, COMPANY_X, scope)`→`null` (a company-B job is out of A's scope).
- **Steps:** `POST /api/jobs/:B_job/rate-link {channel:'sms'}`.
- **Expected:** `404 {ok:false,code:'JOB_NOT_FOUND',message:'Job not found'}`; `mintToken` `.not.toHaveBeenCalled()`, `sendMessage`/`sendEmail` `.not.toHaveBeenCalled()`, `stampTokenSent` `.not.toHaveBeenCalled()`. Cross-company addressing is structurally impossible. Dropping the `companyId` from `getJobById` (returning B's job) flips RED.

### TC-RM2-SL-09 · installation gate — disconnected → APP_NOT_INSTALLED 404 — P1 · route-integration · covers SL9
- **Setup:** job resolves, but `mintToken` throws `RateMeServiceError('…','APP_NOT_INSTALLED',404)`.
- **Expected:** `404 {ok:false,code:'APP_NOT_INSTALLED',…}` (RateMeServiceError unwrapped into the jobs envelope); no stamp.

### TC-RM2-SL-10 · invalid channel — 400 before mint — P1 · route-integration · covers SL10
- **Steps/table:** `{channel:'fax'}` / `{}` (missing) → `400 {ok:false,code:'INVALID_CHANNEL',message:'…'}`.
- **Expected:** validated BEFORE `getJobById`/`mintToken` (or at least before mint); `mintToken` not called.

### TC-RM2-SL-11 · mint-fresh + company-scoped stamp + tech snapshot — P1 · route-integration · covers SL11/SL12, PD-RM2-3/7
- **Steps:** two consecutive `{channel:'copy'}` sends on the same job.
- **Expected:** `mintToken` called TWICE (fresh token each — no reuse lookup) with `{jobId:41, techId, techName}` resolved from `job.assigned_techs[0]`; `stampTokenSent` called with `(token, COMPANY_X, 'copy')` each time (company-scoped `token=$1 AND company_id=$2`); the surfaced `sent_at` reflects the latest send (most-recent-send wins). Order pinned: mint precedes send precedes stamp.

---

## JS — Job rate status `GET /api/jobs/:id/rate-status` (`tests/rateMeJobs.routes.test.js`)

### TC-RM2-JS-01 · full timeline — P1 · route-integration · covers JS1, §5.2
- **Setup:** `routeApp({permissions:['jobs.view']})`; `getJobById`→job; `getJobRateStatus(COMPANY_X, 41)`→`{has_token:true, sent_at, sent_via:'sms', opened_at, google_click_at, rating:{stars:5, created_at}}`.
- **Steps:** `GET /api/jobs/41/rate-status`.
- **Expected:** `200 {ok:true,data:{has_token:true, sent_at, sent_via:'sms', opened_at, google_click_at, rating:{stars:5, created_at}}}`.

### TC-RM2-JS-02 · no token & no rating — P1 · route-integration · covers JS2
- **Setup:** `getJobRateStatus`→`{has_token:false, sent_at:null, sent_via:null, opened_at:null, google_click_at:null, rating:null}`.
- **Expected:** `200 {ok:true,data:{has_token:false, …all nulls, rating:null}}` (FE shows only the "Send rating link" action).

### TC-RM2-JS-03 · token sent, not yet rated — P2 · route-integration · covers JS3
- **Setup:** `getJobRateStatus`→`{has_token:true, sent_at, sent_via:'copy', opened_at:null, google_click_at:null, rating:null}`.
- **Expected:** `200` with `has_token:true`, `sent_at`/`sent_via` present, `opened_at`/`google_click_at` null, `rating:null`.

### TC-RM2-JS-04 · permission gate — 403 (route-level) + 401 (structural) — P0 · route-integration · covers JS4
- **Steps:** `routeApp({permissions:[]})` (no `jobs.view`) → `GET /api/jobs/41/rate-status` → **403** from the real `requirePermission('jobs.view')`.
- **Expected:** 403; the 401-no-token leg = the UNTOUCHED mount `authenticate` (TC-RM2-ST-01).

### TC-RM2-JS-05 · tenant scope — foreign job → empty, no B attribution — P0 · route-integration · covers JS5, §4 · **SAB-SENDLINK-CROSS-TENANT control**
- **Setup:** dispatcher of COMPANY_X; `getJobRateStatus(COMPANY_X, :B_job)`→`{has_token:false, rating:null, …nulls}` (both reads filter `company_id=A`). (If the job load is done first and returns null, `404 JOB_NOT_FOUND` — either way NO company-B data.)
- **Steps:** `GET /api/jobs/:B_job/rate-status`.
- **Expected:** empty `has_token:false`/`rating:null` (or 404) — never B's `sent_at`/`rating`. Dropping `company_id` from `getJobRateStatus` (returning B's rows) flips RED.

### TC-RM2-JS-06 · rating read by `(company_id, job_id)` survives a re-send — P0 · route-integration · covers JS6/JS7, PD-RM2-3 · **SAB-ATTRIBUTION-WRONG-JOB control**
- **Setup:** job rated via token#1; a dispatcher re-sends (token#2 minted, unrated). `getJobRateStatus` returns the rating (from the `(company, job)` read) AND `sent_at`/`opened_at`/`google_click_at` from token#2.
- **Steps:** `GET /api/jobs/41/rate-status` after the re-send.
- **Expected:** `rating` STILL reflects the existing rating (read by `job_id`, not by the latest token) while the event timestamps reflect token#2 — a re-send NEVER hides the real rating. A rating read keyed to the latest token id would return `rating:null` here → RED.

### TC-RM2-ST-01 · authed-surface structural pins — company scope, envelope, zero server.js — P0 · route-integration + structural · covers PD-RM2-2/11, invariant 14/15, NFR-RM2-4
- **Expected (source `jobs.js`):** the `rate-link` + `rate-status` handlers read `req.companyFilter?.company_id` and NEVER `req.companyId`/`req.user.company_id`/a body `company_id`; both use the `{ok:…}` envelope (not `{success,request_id}`); `rate-link` is gated `requirePermission('messages.send')` and `rate-status` `requirePermission('jobs.view')`; `src/server.js` has NO new `/api/jobs` or `/api/public` mount and NO `RATE-ME-CRM-002` line (the `crmServerMount`/`marketplaceMount` stay-green pins hold). `tenantSafetyLint` scans these routes clean.
- **Note:** the mount-level `authenticate + requireCompanyAccess` (401 path) at `src/server.js:213` is the untouched enforcement — this case pins it structurally; the 403 path is driven live in SL-07/JS-04.

---

## BU — `booking_url` rate-me setting (`tests/rateMeDomains.test.js`, settings-dispatch home)

### TC-RM2-BU-01 · PUT stores BOTH keys — P0 · service-unit (+route round-trip) · covers BU1, PD-RM2-5
- **Steps:** `updateAppSettings(COMPANY_X, 'rate-me', {google_review_url:'https://g.page/r/abc/review', booking_url:'https://book.co/x'})` (marketplaceQueries `setInstallationSettings` mocked to capture the blob).
- **Expected:** `validateRateMeSettingsInput` RETURNS `{google_review_url:'…', booking_url:'https://book.co/x'}`; the stored `metadata.settings` carries BOTH; the response `settings` echoes BOTH.

### TC-RM2-BU-02 · booking_url validation taxonomy — P1 · service-unit (pure) · covers BU2, PD-RM2-5
- **Steps/table (`validateRateMeSettingsInput` direct):** `null`/`''`/`'  '` → `booking_url:null` (clears); `'http://x'` / `'javascript:alert(1)'` / `'not a url'` / a 501-char https URL / non-string `42` → throw `MarketplaceServiceError` `{code:'INVALID_BOOKING_URL', httpStatus:400}` (message "… valid HTTPS URL no longer than 500 characters."); any `https:` URL ≤500 chars → accepted. No host allowlist.
- **Expected:** mirrors `google_review_url` validation exactly; `google_review_url` in the same body is validated independently.

### TC-RM2-BU-03 · replace-on-PUT survival — google_review_url is NOT wiped — P0 · service-unit (+route round-trip) · covers BU3, NFR-RM2-10 · **settings-integrity SAB pin**
- **Steps:** PUT `{google_review_url:'https://g/x', booking_url:'https://b/y'}`; then PUT `{google_review_url:'https://g/x', booking_url:null}`; then a PUT that changes ONLY `google_review_url` (FE always sends the FULL object).
- **Expected:** after the second PUT, `google_review_url` SURVIVES (still `'https://g/x'`), `booking_url` cleared to null; a validator that returned only `{booking_url}` would drop `google_review_url` and WIPE the Google link → RED. This is the settings-integrity guard.

### TC-RM2-BU-04 · GET shape — 001 shape + one booking_url key — P1 · service-unit · covers BU4
- **Steps:** `getAppSettings(COMPANY_X, 'rate-me')` with stored `{google_review_url, booking_url}`.
- **Expected:** `200 {success:true, app_key:'rate-me', installation_id, settings:{google_review_url:string|null, booking_url:string|null}, domain:<row|null>, public_host:'rate.albusto.com', request_id}` — exactly the 001 shape plus one `booking_url` key.

### TC-RM2-BU-05 · event payload — booleans only, no URL values — P1 · service-unit · covers BU5
- **Steps:** trigger `SETTINGS_HANDLERS['rate-me'].buildEventPayload` (via `updateAppSettings`).
- **Expected:** payload `{app_key:'rate-me', has_google_review_url:Boolean(v.google_review_url), has_booking_url:Boolean(v.booking_url)}`; the actual URL STRINGS never enter the audit trail.

### TC-RM2-BU-06 · rely-leads GET/PUT byte-identical — P0 · service-unit (regression) · covers BU6, NFR-RM2-10
- **Steps:** run the existing rely-leads settings GET/PUT round-trip (the stay-green rely suites) unchanged after the rate-me handler edit.
- **Expected:** rely GET/PUT behavior byte-identical (only the `rate-me` handler changed); `git diff --stat master -- tests/relyLead*` prints nothing. `validateRelySettingsInput` keeps its name AND export.

---

## ISO — Isolation & attribution matrix (route sweep + cross-refs)

### TC-RM2-ISO-01 · host × token matrix for GET + click beacon — P0 · route-integration · covers §4 matrix, GC8/BK4 · **SAB-CONTEXT-PII-LEAK control**
- **Setup:** fixtures — tokens {live-X, live-Y, expired-X, malformed, unknown, disconnected-co}; hosts {`rate.albusto.com` shared · `rate.bostonmasters.com`=X verified · `evil.example.com` no row · `app.albusto.com` pass-through}.
- **Steps:** table-driven `GET /api/public/rate/:token` AND `POST …/click` across the host×token combinations.
- **Expected (reproduces the §4 matrix):** shared serves X (200 live) and Y (200 live) but every invalid class → uniform 404 and expired-X → branded 200; custom-X serves X only (200), Y → **uniform 404** (host-bind), expired-X → branded 200; `evil.example.com` → gate 404 for everything; `app.albusto.com` pass-through → token-only scope (X live 200, `getTokenContext` called `(…, null)`). Every 404 cell body deep-equals the uniform body; company-X's custom host NEVER serves company-Y data on GET or beacon. The beacon column: live→204, every invalid→uniform 404.

---

## Coverage matrix (64/64 spec scenarios)

| Spec scenario | Case(s) | Priority | Type |
|---|---|---|---|
| GC1 happy live 12-key | TC-RM2-SV-01, TC-RM2-GC-01 | P0 | service, route |
| GC2 first-name fallback | TC-RM2-SV-02 | P1 | service |
| GC3 service/date degrade | TC-RM2-SV-03 | P1 | service |
| GC4 visit_date tz + bad-tz | TC-RM2-SV-04 | P1 | service |
| GC5 already-rated live | TC-RM2-SV-05 | P1 | service |
| GC6 branded-expired 6-key | TC-RM2-SV-06, TC-RM2-GC-02 | P0 | service, route |
| GC7 unknown/malformed 404 | TC-RM2-GC-03 | P0 | route |
| GC8 foreign-host 404 | TC-RM2-GC-04 (+TC-RM2-ISO-01) | P0 | route |
| GC9 app-disconnected 404 | TC-RM2-SV-07, TC-RM2-GC-05 | P0 | service, route |
| GC10 opened_at first-open | TC-RM2-SV-08, TC-RM2-DB-04 | P1 | service, db |
| GC11 DTO deep-equal whitelist | TC-RM2-SV-01/06, TC-RM2-GC-06 | P0 | service, route |
| GC12 001 backward-compat | TC-RM2-GC-07 | P0 | route |
| RT1–RT6 rating contract unchanged | TC-RM2-RT-01 (+001 stay-green) | P0 | route |
| BK1 beacon 204 + stamp | TC-RM2-BK-01, TC-RM2-DB-05 | P0 | route, db |
| BK2 beacon idempotent | TC-RM2-BK-02, TC-RM2-DB-05 | P1 | route, db |
| BK3 beacon malformed 404 | TC-RM2-BK-03 | P1 | route |
| BK4 beacon unknown/expired/foreign 404 | TC-RM2-BK-04 (+TC-RM2-ISO-01) | P0 | route |
| BK5 beacon rate-limited | TC-RM2-BK-05 | P1 | route |
| BK6 beacon token-only | TC-RM2-BK-06, TC-RM2-SV-09 | P0 | route, service |
| BK7 host-gate, no server.js | TC-RM2-BK-07 | P1 | route+structural |
| BK8 sequencing (client) | TC-RM2-SR-04 | P0 | FE-structural |
| SR page-state machine | TC-RM2-SR-01 | P0 | FE-structural |
| SR1 Screen 1 invitation | TC-RM2-SR-02 | P1 | FE-structural |
| SR2 Screen 2 gated | TC-RM2-SR-03 | P1 | FE-structural |
| SR3 beacon→new-tab | TC-RM2-SR-04 | P0 | FE-structural |
| SR4 Screen 3 happy | TC-RM2-SR-05 | P1 | FE-structural |
| SR5 Screen 4 feedback | TC-RM2-SR-06 | P1 | FE-structural |
| SR6 Screen 5 feedback-thanks | TC-RM2-SR-07 | P1 | FE-structural |
| SR7 Screen 6 already-rated | TC-RM2-SR-08 | P1 | FE-structural |
| SR8 Screen 7 expired/invalid | TC-RM2-SR-09 | P0 | FE-structural |
| SR9 chips inert | TC-RM2-SR-10 | P0 | FE-structural |
| SR10 palette | TC-RM2-SR-11 | P1 | FE-structural |
| SR11 booking/contacts placement | TC-RM2-SR-12 | P1 | FE-structural |
| SR12 SPA pins | TC-RM2-SR-13 | P0 | FE-structural |
| SL1 copy | TC-RM2-SL-01 | P1 | route |
| SL2 SMS happy | TC-RM2-SL-02 | P1 | route |
| SL3 SMS NO_PHONE/NO_PROXY | TC-RM2-SL-03 | P1 | route |
| SL4 SMS wallet/transport | TC-RM2-SL-04 | P0 | route |
| SL5 Email happy | TC-RM2-SL-05 | P1 | route |
| SL6 Email NO_EMAIL/MAIL_DISCONNECTED | TC-RM2-SL-06 | P1 | route |
| SL7 permission gate | TC-RM2-SL-07 (+TC-RM2-ST-01) | P0 | route+structural |
| SL8 tenant scope 404 | TC-RM2-SL-08 | P0 | route |
| SL9 installation gate | TC-RM2-SL-09 | P1 | route |
| SL10 invalid channel | TC-RM2-SL-10 | P1 | route |
| SL11 mint-fresh + stamp | TC-RM2-SL-11, TC-RM2-DB-06 | P1 | route, db |
| SL12 order guarantee | TC-RM2-SL-11 | P1 | route |
| JS1 full timeline | TC-RM2-JS-01 | P1 | route |
| JS2 no token/rating | TC-RM2-JS-02 | P1 | route |
| JS3 sent not rated | TC-RM2-JS-03 | P2 | route |
| JS4 permission gate | TC-RM2-JS-04 (+TC-RM2-ST-01) | P0 | route+structural |
| JS5 tenant scope empty | TC-RM2-JS-05 | P0 | route |
| JS6 rating-by-job survives re-send | TC-RM2-JS-06, TC-RM2-DB-07 | P0 | route, db |
| JS7 most-recent token events | TC-RM2-DB-07 | P0 | db |
| BU1 PUT stores both | TC-RM2-BU-01 | P0 | service |
| BU2 validation taxonomy | TC-RM2-BU-02 | P1 | service |
| BU3 replace-on-PUT survival | TC-RM2-BU-03 | P0 | service |
| BU4 GET shape | TC-RM2-BU-04 | P1 | service |
| BU5 event payload | TC-RM2-BU-05 | P1 | service |
| BU6 rely byte-identical | TC-RM2-BU-06 | P0 | service |
| BU7 bookingUrl reader | TC-RM2-SV-10 | P1 | service |
| §4 ISO matrix (sweep) | TC-RM2-ISO-01 (+DB-02/03/06/07) | P0 | route, db |
| migration 178 | TC-RM2-DB-01 | P0 | db |
| getTokenContext join | TC-RM2-DB-02 | P0 | db |
| getExpiredTokenBranding | TC-RM2-DB-03 | P0 | db |
| stampTokenSent | TC-RM2-DB-06 | P0 | db |
| getJobRateStatus | TC-RM2-DB-07 | P0 | db |
| Job-card block + modal (FR-16/18) | TC-RM2-SR-14 | P1 | FE-structural |
| booking_url FE (US-6) | TC-RM2-SR-15 | P1 | FE-structural |

**Sabotage controls → RED targets:** SAB-BUBBLE-INSERTS-TEXT → TC-RM2-SR-10 · SAB-CONTEXT-PII-LEAK → TC-RM2-SV-01/SV-06/GC-06/GC-04 · SAB-GOOGLE-SAME-TAB → TC-RM2-SR-04/BK-01 · SAB-SENDLINK-CROSS-TENANT → TC-RM2-SL-08/JS-05 (+DB-06) · SAB-ATTRIBUTION-WRONG-JOB → TC-RM2-BK-06/JS-06 (+DB-07).

**Deliberate scope notes:** no E2E/DOM harness (repo has none — SR/Job-card/settings cases are source-structural + manual browser steps, the 001 U-group deviation); Keycloak `401` not driven in jest (mount-pin TC-RM2-ST-01; `403` IS driven at route level via `requirePermission`, the jobsEta precedent); the visit-date timezone formatting and the 5★ new-tab/beacon sequencing are asserted structurally + via faithful replica, not with a live browser (flake budget); non-goals (auto-send on job→Done, referrals/rewards, two-axis rating, ABC-Vercel switch, analytics dashboard, configurable threshold, per-tech links, a `booking_url` DB column, SSE on new surfaces) have NO cases by design. The full RatePage rewrite SUPERSEDES the 001 U-cases that pinned the old single-view page + `window.location.replace` (TC-U3-01/U4-01/U6-01) — those assertions are updated in-place in `rateMeUi.structural.test.js` to the RM2 7-screen flow.
