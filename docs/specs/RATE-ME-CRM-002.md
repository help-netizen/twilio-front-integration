# RATE-ME-CRM-002 — Functional Specification: humane, conversion-focused Rate Me page (personalized from the job) + review→job attribution + rebooking screens + dispatcher "Send rating link"

> **Status:** spec (Agent 03). **Phase 2 of RATE-ME-CRM-001 — purely ADDITIVE UX + data on the DEPLOYED 001 infra.** Sources: `Docs/requirements.md` §RATE-ME-CRM-002 (FR-RM2-01…19, NFR-RM2-1…11, US-RM2-1…7, SAB list) + `Docs/architecture.md` §RATE-ME-CRM-002 (migration 179, public-context contract, D-EXP, endpoints, gates — **authoritative** where they overlap) + the RM2 context pack. Consumers: Test-Cases (04), Planner (05), Implementer (06).
> **Do NOT break 001.** Every 001 contract stays byte-identical: the uniform-404 quintet, replay-idempotency (`technician_ratings.rate_token_id UNIQUE`), the host-gate, `google_review_url`, rely-leads settings GET/PUT, and the existing public GET/POST shapes (new fields are additive; existing fields unchanged). Owner decisions are marked **[OWNER]** and are BINDING.
> Seams verified against live code on 2026-07-14 (this worktree): `getTokenContext` (WHERE clause load-bearing), `getPublicContext`/`submitRating`/`mintToken`, `public-rate.js` limiters/`requireRateToken`, `jobs.js` `POST /:id/eta/notify` (L806-882 wallet-gated SMS), `validateRateMeSettingsInput`/`buildRateMeSettingsResponse`.

---

## 1. Overview

RATE-ME-CRM-002 turns the bare 001 rating page into a **humane, conversion-focused 7-screen flow personalized from the job**, adds **token-level review→job attribution** surfaced on the Job card, gives dispatchers a **"Send rating link" (SMS / Email / Copy)** action, and adds a per-company **`booking_url`** for rebooking. Six moving parts:

1. **Personalized public context** — `GET /api/public/rate/:token` gains (server-side, from the token's `job_id`) the customer **first name**, **service label**, **visit date** (formatted in the company timezone), plus per-company **contacts** (`tel:`/`mailto:`) and **booking URL**. PII-minimal: **only the first name** leaves the context.
2. **Expired vs invalid (D-EXP)** — a recognized, host-binding, connected, **expired** token returns a **branded rebooking** payload (`expired:true`); every truly-invalid class (unknown / malformed / foreign-host / app-disconnected) keeps 001's **uniform 404 with NO company data** — non-oracle.
3. **5★ new-tab + beacon** — 5★ records (001 `POST /rating` unchanged), then the client fires a **click beacon** `POST /api/public/rate/:token/click` (stamps `google_click_at`) and opens the Google review in a **NEW TAB** (`window.open`), never `location.replace` — the thank-you stays visible.
4. **Attribution schema (migration 179)** — `rate_tokens` gains `opened_at`, `google_click_at`, `sent_at`, `sent_via` (all nullable). `opened_at` stamps on first GET; `google_click_at` on the beacon; `sent_at`/`sent_via` on dispatcher send.
5. **Dispatcher send + status (JOBS surface)** — `POST /api/jobs/:id/rate-link` (`messages.send`) mints a fresh token and delivers it via SMS / Email / Copy; `GET /api/jobs/:id/rate-status` (`jobs.view`) feeds the Job-card timeline. Both company-scoped.
6. **`booking_url` setting** — a rate-me marketplace setting (JSONB in `marketplace_installations.metadata.settings`, NO DB column), added to `validateRateMeSettingsInput`/`buildRateMeSettingsResponse` while **preserving `google_review_url`** on the replace-on-PUT.

**New artifacts:** migration `179_rate_token_attribution.sql` (+ rollback); `frontend/src/components/jobs/RateLinkModal.tsx`; `frontend/src/components/jobs/JobRateMeBlock.tsx`.
**Touched:** `backend/src/db/rateMeQueries.js` (join + 5 new fns), `backend/src/services/rateMeService.js` (context extend + expired branch + `recordGoogleClick`/`bookingUrl`/`formatVisitDate`), `backend/src/routes/public-rate.js` (+beacon), `backend/src/routes/jobs.js` (+2 routes), `backend/src/services/marketplaceService.js` (`booking_url`), `frontend/src/pages/RatePage.tsx` (full rewrite), `frontend/src/components/jobs/JobStatusTags.tsx`, `frontend/src/services/jobsApi.ts`, `frontend/src/pages/RateMeSettingsDialog.tsx`, `frontend/src/services/marketplaceApi.ts`.
**PROTECTED — UNTOUCHED (verified):** `src/server.js` (**NO change** — beacon rides the already-mounted `/api/public` + `rateHostGate` allowlist `/^\/api\/public\/rate(?:\/|-domain-ask)/` already matches `…/click`; send-link/status ride the already-mounted `/api/jobs`; migration 179 is psql-applied, not code-registered), `frontend/src/lib/authedFetch.ts`, `frontend/src/hooks/useRealtimeEvents.ts`, `backend/db/` schema (only migration 179). `companies` is read-only (no new column). `submitRating` is UNCHANGED.

### Pinned decisions (this spec resolves what requirements/architecture left open)

| # | Decision | Pin |
|---|---|---|
| PD-RM2-1 | **Expired vs invalid (D-EXP)** [OWNER-confirmed split] | `getTokenContext` stays byte-identical (its `(expires_at IS NULL OR expires_at > NOW())` filter is load-bearing). `getPublicContext` gains a SECOND, narrow lookup `getExpiredTokenBranding(token, host)` (exists + host-binds + **is expired**). A **branded-expired 200** (`expired:true`) is emitted ONLY for a real, host-binding, **connected**, expired token. Unknown / malformed / foreign-host / app-disconnected → `null` → **uniform 404, NO company data**. `submitRating` + the beacon inherit "expired → no row → 404" for free (zero new code, zero 001 regression). |
| PD-RM2-2 | **Authed gates + mount** (AR1) | Both new endpoints live in **`backend/src/routes/jobs.js`** (the dispatcher surface, mounted `authenticate + requireCompanyAccess`), NOT `/api/marketplace` (which is `tenant.integrations.manage` — admin-only, wrong for a dispatcher). `POST /:id/rate-link` → `requirePermission('messages.send')` (the eta/notify precedent); `GET /:id/rate-status` → `requirePermission('jobs.view')`. Zero `src/server.js` change. |
| PD-RM2-3 | **Token reuse vs re-mint** (AR3) | Each "Send rating link" **MINTS A FRESH token** (no reuse lookup — simplest, correct). The Job-card **rating is read by `(company_id, job_id)`** (NOT by the latest token), so a re-send NEVER hides an existing rating; `opened_at`/`google_click_at`/`sent_at`/`sent_via` reflect the **most-recent token** for the job. Coherent timeline, correct attribution. |
| PD-RM2-4 | **Beacon transport + sequencing** (AR2) [OWNER: new-tab] | Client fires `fetch(`…/click`, {method:'POST', keepalive:true})` (fire-and-forget, failure ignored) THEN `window.open(redirect_url, '_blank', 'noopener')` **inside the click handler** (popup-blocker requirement). A slow/failed beacon must NEVER block the new tab. **NEVER `window.location.replace`.** |
| PD-RM2-5 | **`booking_url` = a rate-me setting** [OWNER] | JSONB in `marketplace_installations.metadata.settings` (alongside `google_review_url`), **NO DB column**. `validateRateMeSettingsInput` MUST parse and **RETURN BOTH** `{google_review_url, booking_url}` — because `updateAppSettings` spreads `...validated` and `setInstallationSettings` REPLACES `metadata.settings` wholesale, dropping either key on PUT WIPES it. Validation mirrors google: `null`/empty→`null`; else string, `new URL()`-parseable with `protocol==='https:'`, ≤500 chars, else `400 INVALID_BOOKING_URL`. |
| PD-RM2-6 | **`opened_at` stamp** | First-open-only (`UPDATE … SET opened_at=NOW() WHERE id=$1 AND opened_at IS NULL`), **live-path only**, host already bound by the read that produced `ctx`, **best-effort** (try/catch → a stamp failure NEVER fails the GET). The branded-expired path does NOT stamp `opened_at`. |
| PD-RM2-7 | **Send stamping order** | Order: **mint → send → stamp**. `sent_at`/`sent_via` are stamped ONLY on channel success — a failed SMS/email leaves an unsent (harmless, unrated) token, never a false "sent". `sent_at`/`sent_via` are single-valued → **most-recent-send wins** (matches the single "Rating link sent · {via}" step). |
| PD-RM2-8 | **Gold stars = the ONLY non-violet accent** [OWNER] | Rating stars filled `#E0A72C`, empty `#D2D2D0` (inline, rating-semantics exception). Every OTHER action — "Write my Google review", "Send to the team", "Book Visit", "Book your next visit →" — uses `var(--blanc-accent)` (#7F42E1). Palette strictly Albusto v2; **the string "Blanc" NEVER renders in UI.** |
| PD-RM2-9 | **PII whitelist** [OWNER] | Only `first_name` (customer PII) leaves the public context — never last name, customer phone/email, any id (contact_id/job_id/token id), raw timestamps, or the Google URL. The live DTO is a **hard 12-key whitelist**; the branded-expired DTO a **hard 6-key whitelist** (§3). A 13th/7th key = spec violation. |
| PD-RM2-10 | **`submitRating` UNCHANGED** | The Google URL is returned ONLY by `POST /rating` as `redirect_url` on a first-record 5★-with-link (001 contract), NEVER placed in the GET context. `five_star_redirect` (boolean) is the only Google signal in GET. |
| PD-RM2-11 | **Rate-status/send-link envelope** | The jobs surface uses the **`{ok:true,data}` / `{ok:false,code,message}`** envelope (jobs.js convention, e.g. eta/notify), NOT the marketplace `{success,request_id}` envelope. Settings endpoints keep the marketplace `{success,…,request_id}` envelope (001 unchanged). |

---

## 2. Definitions & environment

- **Live token** — a `rate_tokens` row whose `(expires_at IS NULL OR expires_at > NOW())` and whose owning company has a **connected** `rate-me` installation. Resolved by the UNCHANGED `getTokenContext(token, hostCompanyId)` (host-bind via `$2::uuid IS NULL OR t.company_id=$2`).
- **Expired token** — a row with `expires_at IS NOT NULL AND expires_at <= NOW()`. Resolved by the NEW `getExpiredTokenBranding(token, hostCompanyId)` (same host-bind).
- **Truly-invalid** — malformed (fails `RATE_TOKEN_RE`), unknown (no row), foreign-host (host-bind rejects), or app-disconnected (no connected installation). All → **uniform 404**.
- **Uniform 404** — `404 {ok:false,error:{code:'NOT_FOUND',message:'Invalid link'}}` — byte-identical across every truly-invalid class (001 `UNIFORM_NOT_FOUND`, NFR-RM2-3). No company data, no oracle.
- **Public envelope** — `{ok:true,data}` / `{ok:false,error:{code,message}}` (public-rate.js). Beacon success = **`204` empty body**.
- **Jobs envelope** — `{ok:true,data}` / `{ok:false,code,message}` (jobs.js). Used by send-link + rate-status.
- **Marketplace (authed) envelope** — `{success:true,…,request_id}` / `{success:false,code,message,request_id}` (marketplace `handleError`). Used by rate-me settings GET/PUT (001 unchanged).
- **Company timezone** — `companies.timezone` (default `'America/New_York'`, mig 043). Source for `visit_date` formatting.
- **Company contacts** — `companies.contact_phone` / `companies.contact_email` (mig 043), customer-facing, read server-side.
- **`booking_url`** — `marketplace_installations.metadata.settings.booking_url` (JSONB, per-company; NO DB column).
- **Attribution columns (mig 179)** — `rate_tokens.opened_at`, `google_click_at`, `sent_at`, `sent_via` (all `TIMESTAMPTZ`/`TEXT`, nullable).
- **Gold** — `#E0A72C` (filled star) / `#D2D2D0` (empty star). **Violet** — `var(--blanc-accent)` `#7F42E1`; soft plaques `var(--blanc-accent-soft)` `#E7DBFD`.

---

## 3. Public context contract (exact)

`GET /api/public/rate/:token` returns ONE of exactly two shapes (or a uniform 404). Both are **hard whitelists** (NFR-RM2-2 / PD-RM2-9); any additional key is a SAB-CONTEXT-PII-LEAK violation.

### 3.1 LIVE context (200) — **exactly these 12 keys**
```json
{ "ok": true, "data": {
    "company_name":       "Boston Masters",
    "company_logo_url":   "https://<s3-presigned>",   // or null (onError → name-only, 001 NFR-8)
    "technician_name":    "Alex Petrov",               // or null → "our technician"
    "first_name":         "Sarah",                     // ← the ONLY customer PII that leaves the context; or null → "Hi there,"
    "service_label":      "Refrigerator repair",       // or null (omit)
    "visit_date":         "Friday, Jul 12",            // pre-formatted in company tz; NEVER a raw timestamp; or null (omit)
    "company_phone":      "+16175551234",              // or null (omit tel:)
    "company_email":      "hello@bostonmasters.com",   // or null (omit mailto:)
    "booking_url":        "https://book.bostonmasters.com", // or null (omit rebooking affordance)
    "five_star_redirect": true,                        // 001 flag = google_review_url configured
    "already_rated":      false,
    "expired":            false                        // present & false on the live path
} }
```

### 3.2 BRANDED-EXPIRED context (200) — **exactly these 6 keys**
```json
{ "ok": true, "data": {
    "expired":          true,
    "company_name":     "Boston Masters",
    "company_logo_url": "https://<s3-presigned>",    // or null
    "company_phone":    "+16175551234",              // or null
    "company_email":    "hello@bostonmasters.com",   // or null
    "booking_url":      "https://book.bostonmasters.com"  // or null
} }
```
NO `first_name`/`service_label`/`visit_date`/`technician_name`/`stars`/`five_star_redirect`/`already_rated` — the job context is stale; rebooking only.

### 3.3 FORBIDDEN in either payload (SAB-CONTEXT-PII-LEAK = RED if present)
Customer **last name**; customer **phone / email**; any **id** (`contact_id`, `job_id`, `rate_token` id); any **raw timestamp** (`start_date` unformatted, `used_at`, `opened_at`…); the **Google review URL** (stays server-side in `submitRating.redirect_url`); any **other company's** data (host-bind guarantees single-company).

### 3.4 Server-side derivations (in `getPublicContext`, live path)
- `first_name` = `contact_first_name` (`jobs.contact_id → contacts.first_name`) **||** first whitespace token of `jobs.customer_name` **||** `null`.
- `service_label` = `jobs.service_name` || `null`.
- `visit_date` = `formatVisitDate(start_date, company_timezone)` = `new Intl.DateTimeFormat('en-US', { timeZone, weekday:'long', month:'short', day:'numeric' }).format(new Date(start_date))` (e.g. `"Friday, Jul 12"`); `null` when `start_date` is null; **wrapped in try/catch → `null` on a bad tz**.
- `company_phone` / `company_email` = the `companies` values || `null`.
- `booking_url` = `bookingUrl(installation.metadata)` (mirrors `googleReviewUrl`).
- `company_logo_url` = presigned `logo_storage_key` (best-effort → `null` on presign failure, 001 precedent).
- `first_name`, `service_label`, `visit_date` are **NOT** in the branded-expired payload (stale job context).

### 3.5 `getTokenContext` extension (SELECT-only; WHERE UNCHANGED)
Add to the existing SELECT: `LEFT JOIN jobs j ON j.id = t.job_id` and `LEFT JOIN contacts ct ON ct.id = j.contact_id`; select `j.service_name`, `j.start_date`, `j.customer_name`, `ct.first_name AS contact_first_name`, `c.timezone AS company_timezone`, `c.contact_phone AS company_phone`, `c.contact_email AS company_email`. The WHERE (token match + host-bind + expiry filter) is **byte-identical** — the expiry filter is load-bearing for `submitRating`/beacon rejecting expired tokens. `LEFT JOIN` (not `JOIN`) so a token with `job_id NULL` (or a deleted job — 001 `SET NULL`) still resolves with null personalization.

---

## 4. Scenario groups

Format: **Given** (preconditions) / **When** / **Then** (observable behavior + side effects). "Connected" = the token's company has a `rate-me` installation `status='connected'`.

### GC — Public GET context (`GET /api/public/rate/:token`)

**GC1 — happy live, fully personalized.**
Given: live token of connected company C; `job_id` → `contact.first_name='Sarah'`, `service_name='Refrigerator repair'`, `start_date=2026-07-12T14:00Z`; company tz `America/New_York`, logo uploaded, `contact_phone`/`contact_email` set, `google_review_url` + `booking_url` configured; no rating yet; shared host.
When: `GET /api/public/rate/:token`.
Then: `200` with the **§3.1 LIVE 12-key DTO** — `first_name:'Sarah'`, `service_label:'Refrigerator repair'`, `visit_date:'Friday, Jul 12'` (formatted in C's tz), `company_phone`/`company_email`/`booking_url` populated, `technician_name:'Alex Petrov'`, `five_star_redirect:true`, `already_rated:false`, `expired:false`. Side effect: `opened_at` stamped (GC10). ≤ a handful of queries + 1 presign.

**GC2 — first-name fallback chain.**
Given: (a) `contact_id` null but `customer_name='Sarah Chen'`; (b) both null.
When: GET.
Then: (a) `first_name:'Sarah'` (first token of `customer_name`); (b) `first_name:null` (FE greets "Hi there,"). Never the last name, never the full `customer_name`.

**GC3 — service/date graceful degrade.**
Given: `service_name` null and/or `start_date` null (or `job_id` null → LEFT JOIN yields nulls).
When: GET.
Then: `service_label:null` and/or `visit_date:null`; the DTO still has all 12 keys (values null). FE omits the missing part — never renders "—".

**GC4 — visit_date formatted in company tz; bad tz safe.**
Given: `start_date=2026-07-12T02:30Z`, company tz `America/Los_Angeles` (→ still Jul 11 local) vs `America/New_York` (→ Jul 11 local 22:30). When: GET. Then: `visit_date` reflects the COMPANY tz, not UTC/server tz. Given a malformed `companies.timezone`: `formatVisitDate` try/catch → `visit_date:null`, GET still 200.

**GC5 — already-rated LIVE token → Screen 6 signal.**
Given: live token, a `technician_ratings` row exists (`already_rated:true`).
When: GET.
Then: `200`, LIVE 12-key DTO with `already_rated:true`, `expired:false`; personalized fields (`first_name`, `technician_name`) still present (Screen 6 uses them). `opened_at` still stamped if first open.

**GC6 — expired recognized token → branded rebooking (host-bound).**
Given: token exists, belongs to connected company C, `expires_at <= NOW()`; correct host (shared, or C's custom domain).
When: GET.
Then: `getTokenContext` → `null` (expiry filter); `getExpiredTokenBranding` → row + C connected → `200` with the **§3.2 BRANDED-EXPIRED 6-key DTO** (`expired:true`, C's `company_name`/logo/phone/email/`booking_url`). **No** `opened_at` stamp. FE → Screen 7.

**GC7 — unknown / malformed → uniform 404, no company data.**
Given: (a) `abc` (too short) / 65+ chars / `..%2F` / non-base64url; (b) well-formed 32-char token with no row.
When: GET.
Then: (a) `404 UNIFORM_NOT_FOUND` emitted by `requireRateToken` **before any DB read**; (b) both queries miss → `null` → `404 UNIFORM_NOT_FOUND`. Byte-identical bodies. No branding.

**GC8 — foreign-host token → uniform 404 (host-bind).**
Given: C's custom domain (`req.rateHost.companyId=C`); a live-or-expired token of company D.
When: GET.
Then: `getTokenContext` host-bind (`t.company_id=$2`) misses AND `getExpiredTokenBranding` host-bind misses → `null` → `404 UNIFORM_NOT_FOUND`. **Company D's data never appears on C's host.** (SAB-CONTEXT-PII-LEAK.)

**GC9 — app-disconnected company → uniform 404 (non-oracle).**
Given: a valid live token OR an expired token whose company later **disconnected** `rate-me`.
When: GET.
Then: live path — `getConnectedRateMeMeta` null → `getPublicContext` returns `null`; expired path — `getExpiredTokenBranding`'s connected-check fails → `null`. Either → `404 UNIFORM_NOT_FOUND`. Reconnect → the token resolves again (nothing deleted). **A disconnected company is indistinguishable from an unknown token** (D-EXP non-oracle).

**GC10 — `opened_at` first-open-only, idempotent, host-bound, best-effort.**
Given: live token, `opened_at IS NULL`.
When: GET N times.
Then: the FIRST GET runs `stampTokenOpened(ctx.id)` = `UPDATE rate_tokens SET opened_at=NOW() WHERE id=$1 AND opened_at IS NULL`; later GETs do NOT overwrite (`opened_at IS NULL` guard). Host already bound by the read that produced `ctx`. If the UPDATE throws, the GET still returns 200 (try/catch, NFR-RM2-9). The expired path never stamps `opened_at` (GC6).

**GC11 — DTO hard-whitelist (deep-equal pin).**
When: GET on a live token → the response `data` keys are **exactly the §3.1 set of 12** (deep-equal, sorted); on an expired token → **exactly the §3.2 set of 6**. No `last_name`, no `customer_phone`/`customer_email`, no `contact_id`/`job_id`/token id, no raw `start_date`/`used_at`/`opened_at`, no Google URL. (SAB-CONTEXT-PII-LEAK.)

**GC12 — 001 backward-compat.**
When: an OLD client (001 RatePage) hits the extended GET. Then: 001's five fields (`company_name`, `company_logo_url`, `technician_name`, `already_rated`, `five_star_redirect`) are present and unchanged; the new fields are additive and ignored by the old client. No 001 route-contract break (NFR-RM2-1).

### RT — Rating submit & threshold (`POST /api/public/rate/:token/rating`) — **001 contract UNCHANGED**

**RT1 — 5★ with Google link.**
When: `POST …/rating {stars:5}` on a live token, `google_review_url` configured, first record.
Then: `200 {ok:true,data:{recorded:true, next:'google_redirect', redirect_url:'<google_review_url>'}}`; rating `stars=5, feedback NULL`; `used_at` stamped. The Google URL appears **here only** — never in GET (PD-RM2-10).

**RT2 — 5★ without link.** → `200 {ok:true,data:{recorded:true, next:'thanks'}}` — no `redirect_url` key (no dead end; FE → Screen 3).

**RT3 — 1–4★ with feedback.** `{stars:3, feedback:'  late arrival  '}` → `200 {recorded:true, next:'thanks'}`; stored `feedback='late arrival'` (trim → cap 2000 → empty⇒null). No `redirect_url` for stars ≤ 4.

**RT4 — replay (001 idempotency).** Second POST for an already-rated token → `200 {ok:true,data:{recorded:false, already_recorded:true, next:'thanks'}}`; stored rating byte-unchanged. FE → Screen 6 (already-rated). No `redirect_url` even if the first was 5★.

**RT5 — body validation, pre-DB.** `stars` not integer 1–5 (`0`/`6`/`4.5`/`"5"`/missing/null) → `400 INVALID_STARS`; `feedback` present but non-string → `400 INVALID_FEEDBACK`. Extra body fields (`company_id`, `job_id`, `token`…) silently ignored — identity from the token row only.

**RT6 — expired / unknown / foreign → uniform 404.** `submitRating` calls the UNCHANGED `getTokenContext` (live-only) → `null` → `404 UNIFORM_NOT_FOUND`. Expired tokens reject POST for free (PD-RM2-1). No branded body on POST (only GET has the expired branch).

### BK — Click beacon (`POST /api/public/rate/:token/click`) — NEW

Route: `router.post('/rate/:token/click', postRateLimiter, requireRateToken, handler)` in `public-rate.js`. `handler` → `rateMeService.recordGoogleClick(token, req.rateHost?.companyId ?? null)`.

**BK1 — happy stamp.**
Given: live token of connected company C, correct host, `google_click_at IS NULL`.
When: `POST /api/public/rate/:token/click` (no meaningful body).
Then: `recordGoogleClick` → `getTokenContext(token, host)` non-null → `stampGoogleClick(ctx.id)` = `UPDATE rate_tokens SET google_click_at=NOW() WHERE id=$1 AND google_click_at IS NULL` → route replies **`204`, empty body**.

**BK2 — idempotent (first-click wins).** Given: `google_click_at` already set. When: a second beacon. Then: `204`; `google_click_at` **unchanged** (the `IS NULL` guard makes the UPDATE a no-op). Replay-safe.

**BK3 — malformed token → uniform 404.** `requireRateToken` rejects before any DB read → `404 UNIFORM_NOT_FOUND`.

**BK4 — unknown / expired / foreign-host / disconnected → uniform 404.** `getTokenContext` (live-only, host-bound) → `null` → route `404 UNIFORM_NOT_FOUND`. Same non-oracle guarantee as GET/POST-rating.

**BK5 — rate-limited (reuse 10/min POST limiter, XFF-keyed).** 11th beacon from the same XFF hop within 60 s → `429 {ok:false,error:{code:'RATE_LIMITED',message:'Too many requests'}}` + `RateLimit-*` headers.

**BK6 — company/job from the TOKEN only.** A body carrying `{job_id:999, company_id:'X', token:'…'}` is ignored; `ctx` and the stamped row derive from the URL token only. (SAB-ATTRIBUTION-WRONG-JOB.)

**BK7 — host-gate allowlist, zero server.js change.** `/api/public/rate/:token/click` matches the existing `rateHostGate` regex `/^\/api\/public\/rate(?:\/|-domain-ask)/` → no new public prefix, no `src/server.js` edit (verified). On a non-serving/foreign host the gate 404s before the router (H-group, 001).

**BK8 — sequencing (client side, see SR3).** The client fires the beacon (`keepalive:true`, failure ignored) and THEN calls `window.open` inside the click handler. A slow/failed beacon must NOT delay or block the new tab (NFR-RM2-9). The beacon is best-effort attribution, never a gate on the redirect.

### SR — 7-screen RatePage UX (`/r/:token`) — public page (raw `fetch`, no `authedFetch`, no CRM chrome, no "Blanc")

**Page-state machine.** On GET: `404`→**invalid**; network error→**load-error** (retry); `data.expired===true`→**expired(7)**; `data.already_rated===true`→**already-rated(6)**; else→**invitation(1)**. Star select on (1): `5`→POST→`next:'google_redirect'`→**google-helper(2)** / `next:'thanks'`→**happy(3)**; `1–4`→**feedback(4)** (NO POST yet). On (2): "Write my Google review"→beacon+new-tab→**happy(3)**; "Maybe another time"→**happy(3)**. On (4): "Send to the team"→POST→**feedback-thanks(5)**.

| Screen | State | Renders (fields) | Copy (verbatim) | Rebooking / contacts |
|---|---|---|---|---|
| **1** | invitation | logo (round, only if `company_logo_url`; `onError`→hide) + company-name eyebrow; greeting; headline; subline; 5 **gold** stars (≥44px targets); hint | eyebrow `{company_name}` · "Hi {first_name}," (or "Hi there,") · "How did {technician_name \|\| 'our technician'} do?" · "{service_label} · {visit_date}" (omit missing parts) · "Tap a star to rate" | **NONE** (single focus: the stars) |
| **2** | google-helper (5★, only if `five_star_redirect`) | small gold-star row; ask; prompt block + **inert** chips; fine print; violet primary; quiet drop-out | "Wonderful — thank you." · "A quick word on Google means a lot to a small local crew like ours. It takes about a minute." · "Not sure what to mention?" · chips **Punctuality · Clear explanation · Tidy work · Fair price · Friendliness** · "Just prompts — your own words matter most." · **"Write my Google review"** (violet) · "Maybe another time" | NONE |
| **3** | happy | centered gold-star mark; headline; warm line; tech signature; **quiet violet text-link**; contacts | "You're the best, {first_name}." · "— {technician_name} & the {company_name} crew" · **"Book your next visit →"** (quiet violet link → `booking_url`) | quiet link (omit if `booking_url` null); `tel:`/`mailto:` (omit each if null) |
| **4** | feedback (1–4★) | small gold-star row (re-selectable until Send); headline; instruction; **textarea**; **inert** topic chips; privacy plaque; violet primary | "Thanks for being straight with us." · "Tell us what missed the mark — this goes to our team, and won't be posted publicly." · textarea "What could we have done better?" · chips **Timing · Communication · The repair · Pricing** · plaque "Private — only {company_name} sees this" · **"Send to the team"** (violet) | **NONE** (focus) |
| **5** | feedback-thanks | centered green check; headline; line; talk-now prompt; contacts | "Thank you — we hear you." · "A manager from {company_name} will reach out to make this right." · "Prefer to talk now?" | contacts ONLY (`tel:`/`mailto:`); **NO rebooking button** [OWNER: tone] |
| **6** | already-rated | violet check; headline; warm line; rebooking block; violet **filled** button; contacts | "You've already rated this visit." · "Thanks again, {first_name} — it means a lot to {technician_name} and the team." · "Need help again?" / "Book your next service anytime" · **"Book Visit"** (violet filled → `booking_url`) | filled Book Visit (omit if null) + contacts |
| **7** | expired | clock mark; headline; line; SAME rebooking block as 6; contacts | "This link has expired." · "Rating links stay active for a while after your visit." · **"Book Visit"** (violet filled → `booking_url`) | filled Book Visit + contacts (from the branded-expired payload) |
| — | invalid | generic message ONLY — **NO branding, NO booking, NO contacts** | "This link is no longer available." | NONE |

**SR1 — Screen 1 invitation.** GET live, not-rated, not-expired → invitation renders all populated fields; missing `service_label`/`visit_date` omit that part of the subline (never "—"); `first_name` null → "Hi there,". No contacts/rebooking. Single context fetch.

**SR2 — Screen 2 exists only when `five_star_redirect`.** 5★ POST returns `next:'google_redirect'` → Screen 2. If `five_star_redirect` false, the 5★ POST returns `next:'thanks'` → **Screen 3 directly** (no Screen 2, no dead end).

**SR3 — Screen 2 → beacon-then-new-tab (SAB-GOOGLE-SAME-TAB).** "Write my Google review" click handler, in order: (1) `fetch(`/api/public/rate/${token}/click`, {method:'POST', keepalive:true}).catch(()=>{})`; (2) `window.open(redirect_url, '_blank', 'noopener')` — **inside the same click handler** (popup-blocker); (3) transition to Screen 3. **NEVER `window.location.replace` / same-tab** — the thank-you (Screen 3) must stay visible behind the new tab. A failed beacon does NOT block step 2.

**SR4 — Screen 3 happy thank-you.** Reached via Google new-tab or "Maybe another time" or `next:'thanks'`. Gold mark; "You're the best, {first}."; tech signature; **quiet violet text-link** "Book your next visit →" (NOT a filled button — tone); contacts. `booking_url` null → link omitted; `company_phone`/`company_email` null → that contact omitted.

**SR5 — Screen 4 feedback, no auto-POST.** 1–4★ → Screen 4 with NO POST. Textarea + inert topic chips + privacy plaque + violet "Send to the team". Star selection re-selectable until Send. Send → POST `{stars, feedback}` (feedback optional/skippable) → Screen 5. Nothing public, no Google.

**SR6 — Screen 5 feedback thank-you.** Green check; "we hear you"; "A manager from {company} will reach out…"; "Prefer to talk now?" + contacts. **NO rebooking button** (selling to an unhappy customer = wrong tone).

**SR7 — Screen 6 already-rated.** Reached via GET `already_rated:true` OR POST replay `already_recorded:true`. Violet check; no star picker; warm line using `{first}`/`{tech}` (present on the live path); rebooking block "Need help again? / Book your next service anytime"; **filled violet "Book Visit"** → `booking_url`; contacts. Turns a dead end into a rebooking lead.

**SR8 — Screen 7 expired vs generic invalid.** `data.expired===true` → Screen 7 (clock + rebooking block, from the branded-expired payload). A `404` (unknown/malformed/foreign/disconnected) → the **generic "This link is no longer available."** with NO branding/booking/contacts (001 preserved). load-error (network) → retry affordance.

**SR9 — chips insert NOTHING (SAB-BUBBLE-INSERTS-TEXT).** On BOTH Screen 2 and Screen 4 the chips/bubbles are **inert `<button>`s** (thought-direction prompts). Tapping any chip inserts NO text into the textarea and generates no review/feedback text. Screen 2 carries the fine print "Just prompts — your own words matter most." Test pins: the textarea value is **unchanged** after clicking every chip on both screens.

**SR10 — palette (SAB adjacent; NFR-RM2-8).** Rating stars gold `#E0A72C`/`#D2D2D0` (inline). Every OTHER action ("Write my Google review", "Send to the team", "Book Visit", "Book your next visit →") uses `var(--blanc-accent)`. Albusto v2 tokens, theme-aware light/dark. **The string "Blanc" appears nowhere in the rendered UI.**

**SR11 — booking/contacts placement (per-company, omit-when-unset).** Filled "Book Visit" on Screens 6 & 7; quiet text-link on Screen 3; NO rebooking on Screen 5; NONE on Screens 1, 2, 4. Contacts on Screens 3, 5, 6, 7 only. Any `booking_url`/`company_phone`/`company_email` that is null → the affordance is **omitted** (no empty rows, no dead buttons/links).

**SR12 — SPA integration pins (001 preserved).** `/r/:token` route unchanged; `PUBLIC_AUTH_PATHS` includes `'/r/'` (Keycloak bypass); `AppLayout` bare-return for `/r/` (no CRM chrome). RatePage imports ZERO CRM chrome, uses raw `fetch` (never `authedFetch`), no React Query/SSE/sonner. (AR5.)

### SL — Send rating link (`POST /api/jobs/:id/rate-link`) — authenticated dispatcher action

Chain: `authenticate → requireCompanyAccess` (mount) `→ requirePermission('messages.send')` (route). `companyId = req.companyFilter?.company_id` (NEVER `req.companyId`). Body `{ channel: 'sms' | 'email' | 'copy' }`. Order (PD-RM2-7): load job (tenant-scoped) → resolve tech → mint fresh token → deliver → stamp on success.

**SL1 — copy.** When: `{channel:'copy'}`. Then: mint `{token,url}`; **`200 {ok:true,data:{channel:'copy', url:'https://rate.albusto.com/r/<token>', sent_at:'<iso>'}}`**; stamp `sent_at=NOW(), sent_via='copy'`. FE copies `url` to clipboard.

**SL2 — SMS happy.** Given: job has `customer_phone`, company has a proxy DID. When: `{channel:'sms'}`. Then: `toE164(job.customer_phone)` → `resolveCompanyProxyE164(companyId)` → `getOrCreateConversation` → `conversationsService.sendMessage(conv.id,{body:'<link message>', author:'agent'})`; stamp `sent_via='sms'`; **`200 {ok:true,data:{channel:'sms', sent_at:'<iso>'}}`** (no `url`). Mirrors the eta/notify pattern exactly.

**SL3 — SMS recipient/proxy missing.** No `customer_phone` (or un-normalizable) → **`422 {ok:false,code:'NO_PHONE',message:'No phone number on file for this customer.'}`**; no proxy → **`422 {ok:false,code:'NO_PROXY',message:'No sending number configured for your company.'}`**. No token stamp (send never attempted).

**SL4 — SMS wallet / transport failure (no false "sent").** `sendMessage` throws `WALLET_BLOCKED` → **`402 {ok:false,code:'WALLET_BLOCKED',message:'Messaging is paused — top up your balance.'}`**; any other send error → **`502 {ok:false,code:'SMS_FAILED',message:"Couldn't send the message. Please try again."}`**. `sent_at`/`sent_via` are **NOT** stamped (PD-RM2-7) — the token stays unsent.

**SL5 — Email happy.** Given: job has `customer_email`. When: `{channel:'email'}`. Then: `emailService.sendEmail(companyId,{to:job.customer_email, subject:'<…>', body:'<link>', userId})`; stamp `sent_via='email'`; **`200 {ok:true,data:{channel:'email', sent_at:'<iso>'}}`**.

**SL6 — Email recipient missing / mailbox disconnected.** No `customer_email` → **`422 {ok:false,code:'NO_EMAIL',message:'No email on file for this customer.'}`**; `sendEmail` throws (mailbox disconnected) → **`409 {ok:false,code:'MAIL_DISCONNECTED',message:'Connect a mailbox to send email.'}`** (honest error, no crash). No stamp on failure.

**SL7 — permission gate.** No token → `401`; authenticated user without `messages.send` → `403`. (S8-class, inherited from the mount + route permission.)

**SL8 — tenant scope (SAB-SENDLINK-CROSS-TENANT).** Dispatcher of company A calls `POST /api/jobs/:id/rate-link` for a job of company B. `job = jobsService.getJobById(id, companyId=A, scope)` → `null` → **`404 {ok:false,code:'JOB_NOT_FOUND',message:'Job not found'}`**. A foreign job is structurally impossible to send on. No mint, no stamp.

**SL9 — installation gate.** Company A not connected to `rate-me` → `mintToken` throws `APP_NOT_INSTALLED` → **`404`** (authed `{ok:false,code:'APP_NOT_INSTALLED',…}`). No stamp.

**SL10 — invalid channel.** `channel` not in `{sms,email,copy}` (or missing) → **`400 {ok:false,code:'INVALID_CHANNEL',message:'…'}`**, before mint.

**SL11 — mint-fresh + most-recent-send wins (PD-RM2-3, PD-RM2-7).** Each call mints a NEW token (no reuse). Stamp `stampTokenSent(token, companyId, via)` = `UPDATE rate_tokens SET sent_at=NOW(), sent_via=$3 WHERE token=$1 AND company_id=$2` (company-scoped). A re-send updates the surfaced `sent_at`/`sent_via` (Job-card shows the latest send). Tech snapshot resolved from `job.assigned_techs[0]` (id + name) at mint.

**SL12 — order guarantee.** Mint precedes send (SMS body needs the URL); stamp follows a successful send only. A failed channel leaves a minted-but-unsent token — harmless, unrated, never surfaced as "sent".

### JS — Job rate status (`GET /api/jobs/:id/rate-status`) — authenticated, tenant-scoped

Chain: `authenticate → requireCompanyAccess` (mount) `→ requirePermission('jobs.view')` (route). `companyId = req.companyFilter?.company_id`. `rateMeQueries.getJobRateStatus(companyId, jobId)` = two company-scoped reads: (a) most-recent `rate_tokens` for `(company_id, job_id)` → `sent_at, sent_via, opened_at, google_click_at`; (b) most-recent `technician_ratings` for `(company_id, job_id)` → `stars, created_at`.

**JS1 — full timeline.**
Given: job with a sent + opened + rated + google-clicked token.
When: `GET /api/jobs/:id/rate-status`.
Then: **`200 {ok:true,data:{has_token:true, sent_at, sent_via, opened_at, google_click_at, rating:{stars, created_at}}}`**.

**JS2 — no token & no rating.** → **`200 {ok:true,data:{has_token:false, sent_at:null, sent_via:null, opened_at:null, google_click_at:null, rating:null}}`** (FE shows only the "Send rating link" action).

**JS3 — token sent, not yet rated.** → `has_token:true`, `sent_at`/`sent_via` present, `opened_at` present iff opened, `google_click_at` null, `rating:null`.

**JS4 — permission gate.** No token → `401`; without `jobs.view` → `403`.

**JS5 — tenant scope (SAB-SENDLINK-CROSS-TENANT / SAB-ATTRIBUTION-WRONG-JOB).** Company A requests company B's job id → both reads filter `company_id=A` → empty → **`200 {ok:true,data:{has_token:false, rating:null, …nulls}}`** (or `404` if the job itself is not in A's scope — either way, NO company-B attribution leaks).

**JS6 — rating read by `(company_id, job_id)`, not by latest token (PD-RM2-3).** Given: job rated via token#1, then a dispatcher re-sends (token#2 minted, unrated). When: GET. Then: `rating` still reflects the EXISTING rating (read by `job_id`), while `sent_at`/`opened_at`/`google_click_at` reflect the most-recent token#2 — a re-send NEVER hides the real rating. (SAB-ATTRIBUTION-WRONG-JOB.)

**JS7 — most-recent token for events.** With multiple tokens on a job, `sent_at`/`sent_via`/`opened_at`/`google_click_at` come from the newest `rate_tokens` row for `(company_id, job_id)`.

### BU — `booking_url` rate-me setting

**BU1 — PUT stores both keys.** `PUT /api/marketplace/apps/rate-me/settings {google_review_url:'https://g.page/r/abc/review', booking_url:'https://book.co/x'}` → `validateRateMeSettingsInput` returns `{google_review_url, booking_url}`; both stored + echoed in the response `settings`.

**BU2 — booking_url validation taxonomy.** `null`/`''`/`'  '` → stored `null` (clears). `'http://…'` / `'javascript:alert(1)'` / `'not a url'` / 501-char / non-string → **`400 INVALID_BOOKING_URL`** (message "… valid HTTPS URL no longer than 500 characters."). Any `https:` URL ≤500 chars accepted (no host allowlist).

**BU3 — replace-on-PUT survival (NFR-RM2-10, CRITICAL).** Because `updateAppSettings` spreads `...validated` and `setInstallationSettings` REPLACES `metadata.settings` wholesale, the validator MUST return BOTH keys. Pin: PUT `{google_review_url:'https://g/x', booking_url:'https://b/y'}`, then PUT `{google_review_url:'https://g/x', booking_url:null}` → `google_review_url` **survives**; and PUT that changes only `google_review_url` must NOT wipe a previously-set `booking_url` (the FE always sends the FULL object). A validator that returned only `{booking_url}` (dropping `google_review_url`) would WIPE the Google link → the SAB pin for settings integrity.

**BU4 — GET shape.** `GET /api/marketplace/apps/rate-me/settings` → `200 {success:true, app_key:'rate-me', installation_id, settings:{google_review_url:string|null, booking_url:string|null}, domain:<row|null>, public_host:'rate.albusto.com', request_id}`. (001 shape + one `booking_url` key.)

**BU5 — event payload.** `SETTINGS_HANDLERS['rate-me'].buildEventPayload` → `{app_key:'rate-me', has_google_review_url:Boolean(v.google_review_url), has_booking_url:Boolean(v.booking_url)}` — URL VALUES never enter the audit trail.

**BU6 — rely-leads byte-identical (regression pin).** `rely-leads` GET/PUT stay byte-identical (only the `rate-me` handler changes); existing rely suites re-run green with zero edits (NFR-RM2-10).

**BU7 — `bookingUrl(metadata)` reader.** New in `rateMeService.js`, mirroring `googleReviewUrl`: `const v = metadata?.settings?.booking_url; return typeof v === 'string' && v ? v : null;`. Used by `getPublicContext` (live + branded-expired).

### ISO — Isolation & attribution matrix

| Probe | Surface | Expected | Guard |
|---|---|---|---|
| Company-B token on company-A custom host | `GET /rate/:token`, `POST …/click` | uniform `404` (host-bind rejects both live + expired queries) | SAB-CONTEXT-PII-LEAK |
| Company-B token, GET context | any | never returns B's `company_name`/logo/contacts/booking on a foreign host | SAB-CONTEXT-PII-LEAK |
| Company-A dispatcher, `POST /api/jobs/:B_job/rate-link` | jobs | `404 JOB_NOT_FOUND` (getJobById scoped to A) — no mint, no SMS/email | SAB-SENDLINK-CROSS-TENANT |
| Company-A dispatcher, `GET /api/jobs/:B_job/rate-status` | jobs | empty/`has_token:false` — no B attribution | SAB-SENDLINK-CROSS-TENANT |
| Beacon body carries `{job_id:999}` | `POST …/click` | stamps the URL token's `google_click_at` only; body ignored | SAB-ATTRIBUTION-WRONG-JOB |
| Re-send after a rating exists | `GET …/rate-status` | rating read by `(company,job_id)` survives; events reflect newest token | SAB-ATTRIBUTION-WRONG-JOB |
| GET context PII surface | public | exactly the §3 whitelist; only `first_name` PII | SAB-CONTEXT-PII-LEAK |
| 5★ redirect mechanism | RatePage | `window.open('_blank')` after beacon; NEVER `location.replace` | SAB-GOOGLE-SAME-TAB |

---

## 5. API contracts (exact)

### 5.1 Public surface (no auth; `rateHostGate` + per-IP rate-limit + `RATE_TOKEN_RE` + token-only company/job derivation)

#### `GET /api/public/rate/:token` (extended — additive)
- Middleware: `getRateLimiter` (60/min, XFF-keyed) → `requireRateToken` → `getPublicContext`.
- **200 (live)** — §3.1 12-key DTO (`expired:false`). Side effect: first-open `opened_at` stamp (best-effort).
- **200 (branded-expired)** — §3.2 6-key DTO (`expired:true`). No stamp.
- **404** uniform `{ok:false,error:{code:'NOT_FOUND',message:'Invalid link'}}` — unknown/malformed/foreign-host/app-disconnected.
- **429** `{ok:false,error:{code:'RATE_LIMITED',message:'Too many requests'}}` · **500** `{ok:false,error:{code:'INTERNAL',message:'…'}}`.

#### `POST /api/public/rate/:token/rating` (UNCHANGED — 001)
- Middleware: `postRateLimiter` (10/min) → `requireRateToken` → body validation → `submitRating`.
- Request `{stars:1-5 integer, feedback?:string}`; other fields ignored.
- **200** first 5★+link `{ok:true,data:{recorded:true,next:'google_redirect',redirect_url:'<google>'}}` · first otherwise `{ok:true,data:{recorded:true,next:'thanks'}}` · replay `{ok:true,data:{recorded:false,already_recorded:true,next:'thanks'}}`.
- **400** `INVALID_STARS`/`INVALID_FEEDBACK` (pre-DB) · **404** uniform · **429** · **500**.

#### `POST /api/public/rate/:token/click` (NEW — beacon)
- Middleware: `postRateLimiter` (reuse 10/min) → `requireRateToken` → `recordGoogleClick(token, req.rateHost?.companyId ?? null)`.
- Request: body ignored (company/job derived from the token only).
- **204** empty body — live token, stamp `google_click_at` (first-click wins, idempotent).
- **404** uniform — unknown/malformed/expired/foreign-host/disconnected · **429** as above.

### 5.2 Jobs surface (mount: `authenticate + requireCompanyAccess`; `company_id = req.companyFilter?.company_id`; envelope `{ok,data}`/`{ok:false,code,message}`)

| Endpoint | Permission | Request | Success | Errors |
|---|---|---|---|---|
| `POST /api/jobs/:id/rate-link` | `messages.send` | `{channel:'sms'\|'email'\|'copy'}` | `200 {ok:true,data:{channel, url?, sent_at}}` (`url` only for `copy`) | `400 INVALID_CHANNEL`; `404 JOB_NOT_FOUND`/`APP_NOT_INSTALLED`; `422 NO_PHONE`/`NO_PROXY`/`NO_EMAIL`; `402 WALLET_BLOCKED`; `409 MAIL_DISCONNECTED`; `502 SMS_FAILED`; `401`/`403` |
| `GET /api/jobs/:id/rate-status` | `jobs.view` | — | `200 {ok:true,data:{has_token, sent_at, sent_via, opened_at, google_click_at, rating:{stars,created_at}\|null}}` | `404 JOB_NOT_FOUND` (or empty `has_token:false`); `401`/`403` |

### 5.3 Rate-me settings (mount `src/server.js:268`: `authenticate + requirePermission('tenant.integrations.manage') + requireCompanyAccess`; marketplace envelope) — extend for `booking_url`

| Endpoint | Request | Success | Errors |
|---|---|---|---|
| `GET /api/marketplace/apps/rate-me/settings` | — | `200 {success:true, app_key:'rate-me', installation_id, settings:{google_review_url, booking_url}, domain:<row\|null>, public_host, request_id}` | scaffold-trio 404s |
| `PUT /api/marketplace/apps/rate-me/settings` | `{google_review_url:string\|null, booking_url:string\|null}` (FULL object) | same shape as GET | `400 INVALID_GOOGLE_REVIEW_URL`/`INVALID_BOOKING_URL`; scaffold-trio 404s |

### 5.4 Error taxonomy (RM2 additions)

| Surface | Code | HTTP | Trigger |
|---|---|---|---|
| public | `NOT_FOUND` ("Invalid link") | 404 | beacon: malformed/unknown/expired/foreign-host/disconnected — uniform |
| public | (none) | 204 | beacon success (empty body) |
| jobs | `INVALID_CHANNEL` | 400 | rate-link channel not sms/email/copy |
| jobs | `JOB_NOT_FOUND` | 404 | job not in company scope (SAB-SENDLINK-CROSS-TENANT) |
| jobs | `APP_NOT_INSTALLED` | 404 | mint on a disconnected `rate-me` |
| jobs | `NO_PHONE` / `NO_EMAIL` / `NO_PROXY` | 422 | missing recipient / sending number |
| jobs | `WALLET_BLOCKED` | 402 | SMS wallet gate |
| jobs | `SMS_FAILED` | 502 | SMS transport error |
| jobs | `MAIL_DISCONNECTED` | 409 | email mailbox disconnected |
| authed | `INVALID_BOOKING_URL` | 400 | booking_url not https / >500 / non-string |

---

## 6. Sabotage controls (named — each must go RED when the guard is removed, GREEN when restored)

Each entry gives the **exact sabotage edit**, the **scenario/test that must turn RED**, and the **restore**. (NFR-RM2-2..7; requirements §"Именованные sabotage-контроли".)

- **SAB-BUBBLE-INSERTS-TEXT** (FR-RM2-11 / NFR-RM2-7).
  - *Sabotage edit:* make a prompt chip mutate the textarea — e.g. Screen 2/4 chip `onClick={() => setFeedback(f => f + label)}` (or seed a review string).
  - *RED target:* **SR9** — the FE test that clicks every chip on Screen 2 AND Screen 4 and asserts the textarea value is **unchanged**; also asserts Screen 2 chips have no associated textarea write.
  - *Restore:* chips are inert `<button>`s that mutate no input state.

- **SAB-CONTEXT-PII-LEAK** (FR-RM2-01 / NFR-RM2-2).
  - *Sabotage edit:* add a forbidden field to the `getPublicContext` DTO (customer `last_name` / `customer_phone` / `contact_id` / raw `start_date` / the Google URL), **or** drop the host-bind `$2` param from `getTokenContext`/`getExpiredTokenBranding`.
  - *RED target:* **GC11** (live = exactly 12 keys, expired = exactly 6 keys, deep-equal; forbidden fields absent) **and GC8** (foreign-host token → uniform 404, no company-B data).
  - *Restore:* the §3 hard whitelist + host-bound queries.

- **SAB-GOOGLE-SAME-TAB** (FR-RM2-10/15 / NFR-RM2-6).
  - *Sabotage edit:* replace `window.open(redirect_url,'_blank','noopener')` with `window.location.replace(redirect_url)` (and/or delete the beacon `fetch`).
  - *RED target:* **SR3** (5★ opens a NEW tab via `window.open` and Screen 3 stays mounted — a `location.replace` unmounts the page) **and BK1** (the beacon stamps `google_click_at` — dropping the beacon leaves it null).
  - *Restore:* fire the `keepalive` beacon, THEN `window.open('_blank')` in the click handler; never same-tab.

- **SAB-SENDLINK-CROSS-TENANT** (FR-RM2-17/18 / NFR-RM2-4).
  - *Sabotage edit:* load the job or read rate-status WITHOUT the company filter — e.g. `getJobById(id, /* companyId */ null, …)` or `getJobRateStatus` query dropping `company_id = $1`.
  - *RED target:* **SL8** (company-A dispatcher on company-B job must `404`, not mint/send) **and JS5** (company-A rate-status on company-B job must be empty, not B's attribution).
  - *Restore:* `companyId = req.companyFilter?.company_id` scopes both the job load and every query.

- **SAB-ATTRIBUTION-WRONG-JOB** (FR-RM2-15/16 / NFR-RM2-5).
  - *Sabotage edit:* derive the beacon/stamp target from the request body instead of the token (`stampGoogleClick(req.body.token_id)`), **or** make `getJobRateStatus` read the rating by the latest token id instead of `(company_id, job_id)`.
  - *RED target:* **BK6** (beacon stamps only the URL token's row, body ignored) **and JS6** (after a re-send, the rating read by `job_id` still surfaces — a token-scoped read would hide it).
  - *Restore:* company/job derive from the token row only; rating read by `(company_id, job_id)`; events by the newest token for that job.

---

## 7. State machines

**RatePage screen flow** (public; states = §4 SR table):
```
loading --GET 404--------------------> invalid            (generic, no brand)
loading --GET network err------------> load-error         (retry)
loading --GET data.expired-----------> expired(7)         (branded rebooking)
loading --GET data.already_rated-----> already-rated(6)   (rebooking)
loading --GET live, not rated--------> invitation(1)
invitation --tap 5★ (POST)-----------> google-helper(2)   iff next:'google_redirect'
invitation --tap 5★ (POST)-----------> happy(3)           iff next:'thanks' (no link)
invitation --tap 1–4★ (NO post)------> feedback(4)
google-helper --"Write my review"----> happy(3)           (beacon → window.open '_blank')
google-helper --"Maybe another time"-> happy(3)
feedback(4) --"Send to the team"(POST)> feedback-thanks(5)
feedback(4) --POST already_recorded--> already-rated(6)   (replay safety)
```

**Token attribution lifecycle** (mig-178 columns; each stamp is idempotent / most-recent):
```
minted ── dispatcher send (success) ──> sent_at, sent_via stamped   (most-recent-send wins)
       ── first public GET ───────────> opened_at stamped           (opened_at IS NULL guard)
       ── first 5★ click beacon ──────> google_click_at stamped     (google_click_at IS NULL guard)
       ── first recorded rating ──────> technician_ratings row (UNIQUE rate_token_id) + used_at (001)
```
All stamps are additive columns on `rate_tokens`; none gate serving; a failed stamp never fails the request (GET) or the redirect (beacon).

---

## 8. Component interaction

- **Public page:** browser → `GET rate-host/r/<token>` → `rateHostGate` → SPA → RatePage → `fetch GET /api/public/rate/:token` → `public-rate.js` → `getPublicContext` → `getTokenContext` (live, +opened_at stamp) **or** `getExpiredTokenBranding` (branded) → DTO. 5★ → `POST …/rating` (`submitRating`, unchanged) → on `google_redirect`: `POST …/click` (beacon, `keepalive`) → `window.open('_blank')`. 1–4★ → textarea → `POST …/rating`. NO SSE / React Query / sonner / authedFetch on the public page.
- **Job card:** `JobDetailPanel` → `JobOpsSection` (`JobStatusTags.tsx`, JOB-ACTIONS-SLIM band) → `<JobRateMeBlock jobId>` → `jobsApi.getRateStatus(id)` (`GET /api/jobs/:id/rate-status`) → renders the timeline (sent → opened → rated ★N → opened Google review, each step only when its ts exists) + hosts "Send rating link" → `RateLinkModal` (FORM-CANON `Dialog variant="panel"`, `OnTheWayModal` precedent) → `jobsApi.sendRateLink(id, channel)` (`POST /api/jobs/:id/rate-link`) → Copy→clipboard / SMS / Email; surfaces `WALLET_BLOCKED`/`NO_PHONE`/`NO_EMAIL`/`MAIL_DISCONNECTED` via a `RateLinkError` (mirrors `EtaNotifyError`); on success calls the block refresh (`useJobDetail` `afterMutation`). SMS/Email channels are disabled in the modal with an honest reason when the job lacks `customer_phone`/`customer_email`.
- **Settings:** IntegrationsPage → `RateMeSettingsDialog` (FORM-CANON) → `useQuery(['rate-me-settings'])` → `marketplaceApi` GET; Save → PUT `{google_review_url, booking_url}` (FULL object); a new `booking_url` `FloatingField` (https hint) sits beside `google_review_url`.
- **Attribution reads/writes:** `opened_at` (GET, service best-effort), `google_click_at` (beacon), `sent_at`/`sent_via` (send-link), rating (`technician_ratings`, by `job_id`) — all `(company_id, job_id)`/token-scoped.

---

## 9. Migration 178 (additive, idempotent, NOT boot-registered)

Files: `backend/db/migrations/179_rate_token_attribution.sql` + `backend/db/migrations/rollback_179_rate_token_attribution.sql`.
- **Up:** four idempotent `ALTER TABLE rate_tokens ADD COLUMN IF NOT EXISTS …` — `opened_at TIMESTAMPTZ NULL`, `google_click_at TIMESTAMPTZ NULL`, `sent_at TIMESTAMPTZ NULL`, `sent_via TEXT NULL`. **No `booking_url` column** (JSONB setting). No new index (attribution read by `job_id`, already covered; token lookups by the UNIQUE `token`).
- **Down (rollback_178):** `DROP COLUMN IF EXISTS` in reverse (`sent_via` → `sent_at` → `google_click_at` → `opened_at`) — data-loss on down = attribution history only (acceptable, additive).
- **Numbering:** next-free = **178** (highest on origin/master is `177_rate_me`). Parallel-session risk — RE-CHECK vs origin/master at push and `git mv` both ends if 178 was taken (parallel-migration-collision).
- **Apply:** via `psql`/`apply_migrations.js` at deploy (same as 177); no code registry array to edit; `IF NOT EXISTS` makes re-apply safe. Dark-safe: with no FE/routes wired, the CRM is byte-identical.

---

## 10. Invariants checklist (every one is a test target)

1. **001 backward-compat:** GET context keeps 001's 5 fields unchanged; new fields additive; POST /rating + replay-idempotency + uniform-404 quintet + host-gate + `google_review_url` + rely settings all byte-identical (GC12, RT*, BU6).
2. **PII whitelist:** live DTO = exactly 12 keys, expired DTO = exactly 6 keys; only `first_name` PII; no last name / customer phone-email / ids / raw ts / Google URL (GC11 — SAB-CONTEXT-PII-LEAK).
3. **Non-oracle D-EXP:** branded 200 only for a real, host-binding, connected, expired token; unknown/malformed/foreign-host/disconnected → uniform 404 (GC6–GC9).
4. **`getTokenContext` WHERE untouched:** expiry filter intact → `submitRating` + beacon reject expired for free (RT6, BK4).
5. **`opened_at` first-open-only, idempotent, host-bound, best-effort; expired path never stamps** (GC10).
6. **Beacon:** 204; `google_click_at` first-click-wins idempotent; host-bound; token-only derivation; uniform 404 otherwise; rides the existing host-gate allowlist (no server.js change) (BK1–BK7 — SAB-ATTRIBUTION-WRONG-JOB).
7. **5★ new-tab:** beacon-then-`window.open('_blank')`, never `location.replace`; beacon failure never blocks the tab (SR3, BK8 — SAB-GOOGLE-SAME-TAB).
8. **Chips inert** on Screen 2 AND Screen 4 — textarea unchanged (SR9 — SAB-BUBBLE-INSERTS-TEXT).
9. **Send-link tenant scope:** foreign job → 404, no mint/send; mint-fresh; stamp only on success; most-recent-send wins (SL8, SL11, SL12 — SAB-SENDLINK-CROSS-TENANT).
10. **Rate-status tenant scope + rating-by-job_id:** foreign job → empty; a re-send never hides an existing rating (JS5, JS6 — SAB-ATTRIBUTION-WRONG-JOB / SAB-SENDLINK-CROSS-TENANT).
11. **Settings integrity:** `booking_url` validation (null/https/≤500); replace-on-PUT keeps `google_review_url`; rely GET/PUT byte-identical (BU2, BU3, BU6 — settings SAB pin).
12. **Palette:** gold stars are the ONLY non-violet accent; every other action violet; no "Blanc" in UI; theme-aware (SR10).
13. **Rebooking/contacts placement:** filled Book Visit on 6 & 7; quiet link on 3; none on 5; none on 1/2/4; contacts on 3/5/6/7; each affordance omitted when its per-company value is null (SR11).
14. **Protected files untouched:** `src/server.js`, `authedFetch.ts`, `useRealtimeEvents.ts`; `backend/db/` touched only by migration 179; `companies` read-only; `submitRating` unchanged.
15. **Jobs envelope** `{ok,data}`/`{ok:false,code,message}` for send-link + rate-status; marketplace `{success,…,request_id}` for settings (PD-RM2-11).

---

## 11. Non-goals (out of scope this phase — do NOT spec, build, or test)

- **Auto-send on job→Done** or ANY automatic mint/send trigger — send is a MANUAL dispatcher action only.
- Referrals, rewards, coupons.
- Two-axis / multi-dimensional rating — single 1–5 star only.
- ABC-Homes Vercel switch or any change to their external site.
- Ratings analytics / dashboard / aggregate reporting — the Job-card block shows THIS job's lifecycle only.
- Configurable happy threshold (stays 5★ exactly) [OWNER]; per-technician Google/booking links.
- New custom-domain work (001 owns domains); Zenbooker writes (tech/job data read-only).
- A `booking_url` DB column (it is a JSONB setting); any `companies` schema change.
- SSE/realtime on any new surface; a separate light JS bundle for the public page (001 trade-off preserved).

---

## 12. Security & data isolation (agent-03 mandated summary)

- **Public reads** are bound by the token row's `company_id`; custom hosts add `token.company_id = domain.company_id` inside BOTH the live (`getTokenContext`) and expired (`getExpiredTokenBranding`) queries — a foreign or expired-foreign token can never partially resolve (GC8, §3 matrix).
- **Non-oracle D-EXP:** a branded 200 is emitted ONLY for a real, host-binding, connected, expired token; unknown/malformed/foreign-host/app-disconnected are indistinguishable uniform 404s with NO company data (GC6–GC9). The uniform-404 body is never turned into an oracle.
- **PII minimalism:** the public context is a hard whitelist; only the customer first name leaves it (§3, GC11).
- **Beacon** is unauthenticated but rate-limited (10/min XFF), format-guarded, host-bound, idempotent, and derives company/job from the token only — never the body (BK-group).
- **Authed jobs surface:** `company_id` exclusively from `req.companyFilter.company_id` (NEVER `req.companyId`); a foreign job → 404 (send-link) / empty (rate-status); cross-company addressing is structurally impossible (SL8, JS5).
- **Attribution correctness:** every stamped event (`opened_at`/`google_click_at`/`sent_at`) and the rating attach to the correct `job_id`/token; rate-status reads the rating by `(company_id, job_id)` so a re-send never mis-attributes or hides a rating (JS6, BK6).
- **Settings:** `booking_url` lives in tenant-scoped installation metadata; the validator returns both keys so a PUT never silently wipes `google_review_url`; rely-leads settings behavior is byte-identical.
- **Protected surfaces:** no `src/server.js` change (beacon + jobs routes ride existing mounts; migration psql-applied); `authedFetch.ts`/`useRealtimeEvents.ts`/`companies` schema untouched; `submitRating` unchanged.

---

## 13. Open questions for owner

**None.** The one item Product flagged — "expired vs invalid" scope for Screen 7 — is resolved by binding decision **D-EXP / PD-RM2-1** (EXPIRED recognized token → branded rebooking with THAT company's Book Visit + contacts; UNKNOWN / MALFORMED / FOREIGN-HOST / DISCONNECTED → the generic "This link is no longer available." with no company data), matching the owner-confirmed split in requirements §OPEN QUESTIONS FOR OWNER. All remaining choices (send-link gate `messages.send`, status gate `jobs.view`, jobs-surface mount, `booking_url` as a setting, mint-fresh + rating-by-`job_id`, beacon transport) are within the Architect mandate and are pinned in §1 PD-RM2-* and the architecture §RATE-ME-CRM-002.
