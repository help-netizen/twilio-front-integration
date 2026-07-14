# RATE-ME-CRM-001 — Functional Specification: multi-tenant Rate Me (tokens, public rating page, dedicated + custom-domain hosting, marketplace settings)

> **Status:** spec (Agent 03). Sources: `Docs/requirements.md` §RATE-ME-CRM-001 (FR-1…FR-14, NFR-1…NFR-10, US-1…US-8) + `Docs/architecture.md` §RATE-ME-CRM-001 (D0–D9, **authoritative** where they overlap). Consumers: Test-Cases (04), Planner (05), Implementer (06).
> **Phase scope:** infrastructure only. Nothing mints tokens automatically; ratings are stored, never displayed in the CRM. See §9 Non-goals.
> All seams named below were verified against live code on 2026-07-13 (file:line refs current as of this worktree).

---

## 1. Overview

The `rate-me` marketplace app gives every tenant an isolated technician-rating system: opaque 192-bit tokens tied to `(company, job, technician)`, a mobile-first branded public page at `/r/:token`, and per-company rating storage. The page is served on the shared host `rate.albusto.com` (option A) and/or on the tenant's own subdomain connected via one CNAME record (option B, Caddy `on_demand_tls` with an ask endpoint). A 5★ rating records then redirects to the company's Google-review link; 1–4★ records with optional private feedback and ends on a thank-you. Happy threshold = 5★ exactly, not configurable [OWNER].

**New artifacts:** migration `172_rate_me.sql` (3 tables + app seed), `backend/src/db/rateMeQueries.js`, `backend/src/services/rateMeService.js`, `backend/src/routes/public-rate.js`, `backend/src/middleware/rateHostGate.js`, `frontend/src/pages/RatePage.tsx`, `frontend/src/pages/RateMeSettingsDialog.tsx`, Caddy fragment.
**Touched:** `src/server.js` (two flagged mount lines ONLY — NFR-10), `marketplaceService.js` (per-app-key settings dispatch), `marketplace.js` (4 rate-me routes + error unwrap), `App.tsx` (+1 route), `AuthProvider.tsx` (`PUBLIC_AUTH_PATHS` += `'/r/'`), `AppLayout.tsx` (bare-return += `'/r/'`), `IntegrationsPage.tsx`, `marketplaceApi.ts`, `infra/Caddyfile` + `infra/README.md`.

### Pinned decisions (this spec resolves what requirements/architecture left open)

| # | Decision | Pin |
|---|---|---|
| PD-1 | `google_review_url` validation | **https-only + URL-parseable + ≤500 chars + ANY host.** No Google-host allowlist: legitimate review links live on `g.page`, `maps.app.goo.gl`, `search.google.com/local/writereview`, `business.google.com`, `google.com/maps` — a host whitelist is brittle and FR-6 demands only "absolute `https://` URL". Empty/whitespace input → `null` (clears the link). Non-string / `http:` / `javascript:` / unparseable / >500 chars → `400 INVALID_GOOGLE_REVIEW_URL`. |
| PD-2 | Domain uniqueness conflict status | **HTTP 400 `DOMAIN_TAKEN`** (architecture D3/D9 pin; NOT 409). Message "This domain is already in use." — never reveals the holder. |
| PD-3 | Authed rate-me management gating | ALL four authed rate-me endpoints (domain PUT/verify/DELETE + tokens POST) require a **connected `rate-me` installation** → otherwise the scaffold's `404 APP_NOT_INSTALLED`. (Consistent with D3: every one of them writes a `marketplace_events` row, which needs `installation_id`/`app_id`.) While disconnected, the domain row *survives* but is unmanageable and unserved; reconnect resumes without re-verification. |
| PD-4 | Verify on resolver transport error / timeout | Status **unchanged** (`pending` stays `pending`, `failed` stays `failed`); `last_error` = humane retry copy; `last_checked_at` updated. `verified`/`active` rows NEVER change status on ANY verify outcome (no-demote); a successful re-verify of an `active` row keeps `active`. |
| PD-5 | Public rate limits | Window **60 s** (deliberate deviation from publicAuth's 1-hour window), GET max 60, POST max 10, ask endpoint NOT rate-limited (localhost-guarded + cached instead). Key = first `X-Forwarded-For` hop normalized via express-rate-limit v8 `ipKeyGenerator` (export verified present), fallback `req.ip` (app sets no `trust proxy`; `req.ip` behind Caddy is always `127.0.0.1` — copying publicAuth verbatim would make the limit global). 429 body = envelope-consistent `{ok:false,error:{code:'RATE_LIMITED',message:'Too many requests'}}`, `standardHeaders: true`. |
| PD-6 | Mint URL host | `mintToken` always returns `https://<RATE_ME_PUBLIC_HOST>/r/<token>` (shared host) this phase, even when the company has an `active` custom domain. The same token is equally valid on the company's custom domain (§3). |
| PD-7 | Feedback normalization | Trim → empty string becomes `null` → longer than 2000 chars is **silently truncated** to 2000 (a long rant must never lose the rating). |
| PD-8 | Stars type strictness | `stars` must be a JSON **integer** 1–5 (`Number.isInteger`); `"5"` (string), `4.5`, `0`, `6`, missing → `400 INVALID_STARS`. |
| PD-9 | `already_rated` truth | The rating row EXISTS for the token (LEFT JOIN on `technician_ratings.rate_token_id`). `rate_tokens.used_at` is a convenience stamp, never the source of truth. |
| PD-10 | Settings hosting radio | Presentation-only. Radio state derives from domain-row existence (custom ⇔ row exists); flipping the radio performs NO server mutation; returning to "On albusto.com" = explicit **Remove** of the domain. |

---

## 2. Definitions & environment

- **Shared host** — `RATE_ME_PUBLIC_HOST`, env, default `rate.albusto.com`. Serves ANY tenant's valid token.
- **Custom host** — a row in `rate_me_domains` with `status IN ('verified','active')`. Serves ONLY the owning company's tokens.
- **Rating surface** — path allowlist on rating hosts: `^/r/`, `^/api/public/rate(/|-domain-ask)`, `^/assets/`, `^/icons/`, `^/vite\.svg$`. Everything else on those hosts is 404 (`manifest.webmanifest` deliberately excluded — Albusto-branded PWA metadata must not surface on tenant domains).
- **Pass-through hosts** — Albusto family (`albusto.com`, `*.albusto.com` except the shared host) + `RATE_ME_PASSTHROUGH_SUFFIXES` (env, default `localhost,127.0.0.1,::1,.fly.dev`). The gate `next()`s untouched: dev servers, docker healthchecks (`/health` via localhost), the legacy Fly deployment stay byte-identical.
- **Token** — `crypto.randomBytes(24)` → base64url, 32 chars, ≥192-bit entropy (NFR-1; explicitly NOT the 64-bit estimate mint). Format guard `RATE_TOKEN_RE = /^[A-Za-z0-9_-]{22,64}$/` runs BEFORE any DB read.
- **Uniform 404** — `404 {ok:false,error:{code:'NOT_FOUND',message:'Invalid link'}}`, byte-identical for all five public failure classes: malformed / unknown / expired / foreign-host / app-disconnected (NFR-2).
- **Public envelope** — `{ok:true,data}` / `{ok:false,error:{code,message}}` (public-estimates precedent, `backend/src/routes/public-estimates.js`).
- **Authed envelope** — `{success:true, …, request_id}` / `{success:false, code, message, request_id}` (marketplace `handleError`, `backend/src/routes/marketplace.js:13`); `RateMeServiceError(message, code, httpStatus)` unwraps identically to `MarketplaceServiceError`.

---

## 3. Identity & isolation model — THE matrix

**Rule zero: company identity ALWAYS comes from the token row.** The Host header can only *constrain* which tokens resolve (`token.company_id === domain.company_id` on custom hosts); the request body NEVER contributes identity (extra body fields ignored). All downstream reads (job, technician profile, branding, settings) are bound by the token row's `company_id`.

Host classes × token classes → outcome of public GET/POST (both endpoints behave identically w.r.t. this matrix):

| Host class | Gate result (`req.rateHost`) | Valid token, company X | Valid token, company Y (foreign) | Malformed token | Unknown token | Expired token | Token of app-disconnected company |
|---|---|---|---|---|---|---|---|
| `rate.albusto.com` (shared) | `{mode:'shared'}` → token-only scope | **200** (X context) | **200** (Y context — shared host serves every tenant, FR-8) | 404ᵁ | 404ᵁ | 404ᵁ | 404ᵁ |
| Custom domain of X, `verified`/`active` | `{mode:'custom', companyId:X}` → host-bound scope | **200** | **404ᵁ** (company binding) | 404ᵁ | 404ᵁ | 404ᵁ | 404ᵁ |
| Custom domain row `pending`/`failed`/removed | mode `unknown` | 404 everything (any path, any token) | 404 | 404 | 404 | 404 | 404 |
| Unknown host (no row, not Albusto) | mode `unknown`; **503 fail-closed** if the domain lookup itself errors | 404 everything | 404 | 404 | 404 | 404 | 404 |
| Pass-through hosts (`app.albusto.com`, `localhost`, `.fly.dev`, …) | gate `next()`, `req.rateHost` absent → token-only scope | **200** (smoke path — same model as `/e/:token` on app hosts) | **200** | 404ᵁ | 404ᵁ | 404ᵁ | 404ᵁ |

404ᵁ = the uniform 404 (§2) — indistinguishable across columns AND rows (no timing/text/shape oracle). On non-serving host rows the 404 comes from the gate (before any router) and is also uniform for `/api/*` (JSON envelope) vs plain `Not found` for page paths — pinned in H-group.

Additional isolation guarantees:
- On custom hosts the constraint is applied INSIDE the single context query (`AND t.company_id = $2`), not as a post-filter — a foreign token can never partially resolve.
- The ask endpoint answers 200 ONLY for `verified`/`active` domains whose owning company has a connected `rate-me` installation — never for `pending`/`failed`/removed/foreign/unknown (NFR-4).
- Authed surface isolation: all rate-me management runs under `authenticate + requirePermission('tenant.integrations.manage') + requireCompanyAccess` (mount `src/server.js:268`); `company_id` comes ONLY from `req.companyFilter.company_id` (`marketplace.js` `companyId(req)` helper), `actor` from `req.user.crmUser.id`.

---

## 4. Scenario groups

Format: **Pre** (preconditions) / **When** / **Then** (observable behavior + side effects). "Connected" = company has a `rate-me` installation with `status='connected'` on the published app.

### T — Tokens & migration semantics

**T1 — mint happy path with job.**
Pre: connected; job J belongs to company C, `assigned_techs` contains `{id:'zb-77', name:'Alex Petrov'}`.
When: authed `POST /api/marketplace/apps/rate-me/tokens` `{job_id: J, tech_id: 'zb-77'}`.
Then: `201 {success:true, token:{token:<32-char base64url>, url:'https://rate.albusto.com/r/<token>'}}`; row in `rate_tokens` with `company_id=C`, `job_id=J`, `tech_id='zb-77'`, `tech_name='Alex Petrov'` (snapshot auto-resolved from the job's `assigned_techs` since not supplied), `expires_at NULL`, `used_at NULL`. Log `[RateMe] mint {company_id, job_id, tech_id, token_prefix(8)}` — never the full token.

**T2 — mint without job.**
Pre: connected. When: `POST …/tokens` `{tech_id:'zb-77', tech_name:'Alex'}`.
Then: 201; `job_id NULL`, `tech_name='Alex'` (from body). With neither job nor `tech_name`: `tech_name NULL` (page later falls back to "our technician", U10).

**T3 — mint validates job ownership.**
Pre: connected as company C; job J belongs to company D. When: `POST …/tokens` `{job_id:J, tech_id:'zb-77'}`.
Then: `400 JOB_NOT_FOUND` (authed envelope). Same for a non-existent job id. No row created.

**T4 — mint gated on installation.**
Pre: company has NO connected `rate-me` installation (never installed, or disconnected). When: any `POST …/tokens`.
Then: `404 APP_NOT_INSTALLED`. (PD-3.)

**T5 — mint input validation.** `tech_id` missing / empty / not a string → 400 (`INVALID_*` per taxonomy §5.3); `job_id` present but not a positive integer → 400. Extra body fields ignored.

**T6 — token format & collision retry.** Every minted token matches `^[A-Za-z0-9_-]{32}$` (24 random bytes, base64url). On a `token` unique-violation the mint retries with a fresh token, ≤3 attempts, then honest 500. (Test seam: entropy/format assertion; forced-collision retry.)

**T7 — multi-open allowed.** Pre: token exists, no rating. When: GET context N times from any device.
Then: every GET → 200 identical DTO; no state change; `used_at` stays NULL. Opening the link never consumes it — only rating does.

**T8 — rating-once anchor.** First successful rating POST atomically inserts `technician_ratings` (UNIQUE `rate_token_id`) and stamps `rate_tokens.used_at`. Any later insert attempt for the same token is impossible at the DB level regardless of application races (see P16). One rating per token, EVER — no update/overwrite path exists.

**T9 — expiry semantics.** `expires_at` is nullable; nothing mints expiring tokens this phase. NULL = no expiry (T7 forever). If a row has `expires_at <= NOW()` (manually set / future phases): GET and POST both → uniform 404; the guard is in the context query (`expires_at IS NULL OR expires_at > NOW()`), so expired ≡ nonexistent with zero behavioral difference.

**T10 — migration 172 semantics.**
- Additive + idempotent: re-running the migration is a no-op (`IF NOT EXISTS` / `ON CONFLICT (app_key) DO UPDATE` seed, mig-161/170 precedent); dark-deploy safe (NFR-9) — with no Caddy/DNS applied the CRM is byte-identical.
- Tables per architecture D2: `rate_tokens`, `technician_ratings` (`rate_token_id BIGINT NOT NULL UNIQUE`), `rate_me_domains` (`UNIQUE(company_id)` — one custom domain per company; `UNIQUE(domain)` — globally unique). `jobs.id` is BIGSERIAL → BIGINT FKs correct (verified mig 031). `updated_at` trigger reuses pre-existing `update_updated_at_column()` (mig-123 pattern).
- FK behavior: deleting a job → `job_id SET NULL` on tokens/ratings, rating survives and the page keeps working off `tech_name` snapshot; deleting a company → CASCADE removes its tokens/ratings/domain.
- App seed: `app_key='rate-me'`, `provider_name='Albusto'`, `app_type='internal'`, `provisioning_mode='none'`, `status='published'`, `requested_scopes=[]`, `metadata.requires_credential_input=false`. Install/disconnect ride the generic marketplace flow untouched; install creates the `marketplace_installations` row that settings live on.
- Rollback file drops `technician_ratings` → `rate_tokens` → `rate_me_domains` (ratings before tokens — FK order) + deletes the app row (disconnect-first presumption, rollback-161 precedent).
- Header comment says "Migration 172"; the FILENAME is authoritative (numbering-lie gotcha).

### P — Public API (`/api/public/rate*`)

**P1 — GET context happy path.**
Pre: valid token of connected company C (logo uploaded, google link configured, no rating yet); request on shared host.
When: `GET /api/public/rate/:token`.
Then: `200 {ok:true, data:{company_name, company_logo_url:<presigned S3 URL>, technician_name:'Alex Petrov', already_rated:false, five_star_redirect:true}}` — **exactly these 5 keys** (NFR-6 hard whitelist; a 6th key = spec violation). No ids, no address/phone/status, no Google URL. Total work ≤ 2 queries + 1 presign (NFR-7).

**P2 — GET unknown token.** Well-formed 32-char token with no row → uniform 404.

**P3 — GET malformed token.** `abc` (too short) / 65+ chars / `..%2F` / non-base64url chars → uniform 404 emitted BEFORE any DB read (format guard).

**P4 — GET expired token.** → uniform 404 (T9).

**P5 — GET token of disconnected company.** Pre: valid token, company later disconnected `rate-me`. → uniform 404 (context re-checks connected installation via the 1-query connected-meta read). Reconnect → token works again (nothing was deleted).

**P6 — GET foreign-host token.** Pre: custom domain of company A (`active`); token of company B. → uniform 404. **P2–P6 responses are byte-identical** (status, body, headers) — the enumeration-resistance pin (NFR-2/NFR-3; test asserts deep equality of the five bodies).

**P7 — GET after rating.** → 200 with `already_rated:true`; other fields still present (page renders thank-you, U6).

**P8 — `five_star_redirect` flag.** `true` iff `metadata.settings.google_review_url` is set for the token's company; the URL itself NEVER appears in GET (record-before-redirect guarantee lives in POST).

**P9 — logo presign failure.** S3/storage presign throws → `company_logo_url:null`, still 200 (best-effort precedent `companyProfileService.presign`; NFR-8). Same for `logo_storage_key IS NULL`.

**P10 — POST 5★ with link configured.**
When: `POST /api/public/rate/:token/rating` `{stars:5}`.
Then: `200 {ok:true, data:{recorded:true, next:'google_redirect', redirect_url:<google_review_url>}}`; rating row `stars=5, feedback NULL`; `used_at` stamped; log `{company_id, rate_token_id, stars, has_feedback:false, replay:false}`.

**P11 — POST 5★ without link.** → `200 {recorded:true, next:'thanks'}` — rating stored, NO `redirect_url` key at all (US-6: fallback, no dead end).

**P12 — POST 1–4★ with feedback.** `{stars:3, feedback:'  late arrival  '}` → `200 {recorded:true, next:'thanks'}`; stored `feedback='late arrival'` (trimmed). 2000+ chars → truncated to 2000 (PD-7); whitespace-only → `NULL`. `redirect_url` NEVER present for stars ≤ 4, even with the link configured.

**P13 — POST body validation.** `stars` missing/`0`/`6`/`4.5`/`"5"`/`null` → `400 {ok:false,error:{code:'INVALID_STARS',…}}` (PD-8). `feedback` present but not a string → `400 INVALID_FEEDBACK`. Validation runs BEFORE any DB read.

**P14 — body cannot inject identity.** `{stars:5, company_id:'…', tech_id:'zb-99', job_id:1, token:'…'}` → extra fields silently ignored; the stored row's `company_id/job_id/tech_id` are copied from the TOKEN row only (FR-5). Test pins the stored row against the token row, not the body.

**P15 — POST replay.** Second POST (any stars/feedback) for an already-rated token → `200 {ok:true, data:{recorded:false, already_recorded:true, next:'thanks'}}`; stored rating byte-unchanged (no overwrite, no error) [OWNER]. Replay carries no `redirect_url` even if the first rating was 5★. Log `replay:true`.

**P16 — concurrent-race POST.** Two simultaneous first POSTs → exactly one `technician_ratings` row (the `ON CONFLICT (rate_token_id) DO NOTHING` insert inside the transaction); the loser observes conflict → returns the replay response of P15. Both callers get 200.

**P17 — rate limits, XFF-keyed.** GET limited 60/min, POST 10/min, window 60 s (PD-5). Key = first `X-Forwarded-For` hop: requests with `XFF: 1.1.1.1` and `XFF: 2.2.2.2` count independently; 61st GET from the same XFF within the window → `429 {ok:false,error:{code:'RATE_LIMITED',message:'Too many requests'}}` + `RateLimit-*` standard headers. Direct localhost calls (no XFF) key on `req.ip`.

**P18 — POST storage failure.** DB insert throws → honest `500 {ok:false,error:{code:'INTERNAL',…}}`; NO rating row, NO `used_at`, NEVER a `redirect_url` (NFR-8 — the page must not send an unrecorded customer to Google; U8 covers the page side).

**P19 — guard ordering leaks nothing.** Malformed token + invalid body → **404** (token format guard first). Well-formed-but-unknown token + invalid stars → **400 INVALID_STARS** (body check precedes the DB lookup) — so a 400 does NOT confirm token existence; only the format class is distinguishable, which the attacker already knows from the URL shape.

### H — Host gate (`rateHostGate`, first-mounted)

**H1 — Albusto pass-through, zero cost.** Requests with Host `app.albusto.com`, `api.albusto.com`, `albusto.com`, `www.albusto.com`, `localhost:*`, `127.0.0.1`, `::1`, `*.fly.dev` → gate calls `next()` after pure string checks — NO DB query, NO cache access (pin with a query-spy test). Entire CRM, webhooks, SSE, healthchecks byte-identical.

**H2 — shared-host allowlist passes.** Host `rate.albusto.com`: `GET /r/<token>` → SPA `index.html` (prod static fallback `src/server.js:352-369`, untouched); `GET/POST /api/public/rate*` → router; `GET /assets/*`, `/icons/*`, `/vite.svg` → static. `req.rateHost={mode:'shared'}` stamped for the router.

**H3 — shared-host everything else 404 + KC silence.** Host `rate.albusto.com`: `/`, `/pulse`, `/login`, `/settings`, `/api/marketplace/apps`, `/api/crm/*`, `/api/calls`, `/events` (SSE), `/webhooks/*`, `/health`, `/twiml`, `/r` (no trailing slash — fails `^/r/`) → 404 from the gate BEFORE any router/static: `/api/*` paths get `{ok:false,error:{code:'NOT_FOUND',message:'Not found'}}` JSON, page paths plain-text `Not found`. `index.html` is unreachable for CRM routes on this host → SPA never boots for them → NO Keycloak redirect, no CRM cookies, no auth.albusto.com bounce (NFR-5 pin: response must contain no `Location` header and no KC URL).

**H4 — manifest not allowlisted.** `GET /manifest.webmanifest` on a rating host → 404 (deliberate; benign console noise — Albusto PWA identity must not surface on tenant domains). Same for `/apple-touch-icon*` requests outside `/icons/`.

**H5 — verified/active custom domain binds company.** Host `rate.bostonmasters.com` with a `verified` or `active` row for company X → mode `custom`, `req.rateHost={mode:'custom', companyId:X}`; company-X token works end-to-end (GET+POST), branding is X's.

**H6 — foreign token on custom domain.** Same host, valid company-Y token → uniform 404 (identical to P2's body). The company constraint is inside the context query — no partial resolve, no distinguishable error (US-5).

**H7 — pending/failed/removed domain host.** Host has a row but `status='pending'|'failed'`, or row deleted → mode `unknown` → 404 for EVERY path including `/r/*` and `/api/public/rate*`. (Belt: such hosts also can't complete TLS — the ask refuses; suspenders: even a manually-trusted/HTTP request dies here.)

**H8 — unknown host.** Host `evil.example.com` (no row) → 404 everything.

**H9 — fail-closed on DB error.** Domain lookup throws (DB down) → `503` for that request. Scope pin: only the custom-domain-candidate branch can 503; Albusto-host traffic (H1) is structurally incapable of it (no lookup on that path).

**H10 — gate precedes every mount.** The gate is mounted immediately after the CORS middleware (`src/server.js:52-71`) and BEFORE the raw-body webhook mounts (`/api/billing/webhook`, `/api/stripe-payments/webhook`, `/api/email/push`, `src/server.js:75-90`): on rating hosts those paths 404 at the gate (load-bearing for NFR-5 — pin with a mount-order test). `OPTIONS` preflights are answered by the CORS middleware before the gate (unchanged behavior).

**H11 — host-resolution cache.** Custom-host lookups memoized 60 s (negative results too, cap 1000 entries, full clear on overflow); EVERY domain mutation (set/verify/remove) clears the cache — so removal takes effect on rating traffic within one request, never after 60 s of stale serving. (Verify-success also clears: a just-verified domain serves immediately.)

**H12 — app-host smoke path.** `GET app.albusto.com/r/<token>` → gate passes through (H1), SPA serves, `req.rateHost` absent on the API call → token-only scope; the page renders bare (U11). This is the `/e/:token`-equivalent smoke path; the CRM remains fully reachable on app hosts (NFR-5 constrains rating hosts only).

### D — Custom domains & ask endpoint

**D1 — set domain happy path.**
Pre: connected, no domain row. When: authed `PUT /api/marketplace/apps/rate-me/domain` `{domain:'Rate.BostonMasters.com.'}`.
Then: normalized to `rate.bostonmasters.com` (trim → IDN/punycode via URL-hostname parse → lowercase → strip trailing dot); row created `status='pending'`, timestamps/`last_error` NULL; `200 {success:true, domain:{domain:'rate.bostonmasters.com', status:'pending', verified_at:null, activated_at:null, last_checked_at:null, last_error:null}}`; `marketplace_events` `domain_added` `{app_key:'rate-me', domain}`; host cache cleared. IDN input `rate.бостон.com` → punycode-ASCII stored.

**D2 — invalid hostname.** `not a host`, `ha!.com`, 254+ chars, `rate..double.com` → `400 INVALID_DOMAIN` (humane message), no row.

**D3 — apex rejected.** `bostonmasters.com` (2 labels) → `400 APEX_DOMAIN_NOT_SUPPORTED`, message: "Use a subdomain like rate.bostonmasters.com — root domains can't carry a CNAME record." (copy embeds THEIR domain). Known v1 limitation: multi-label-TLD apexes (`example.co.uk` = 3 labels) pass this rule and fail later at Verify with the generic D9 copy — accepted, documented.

**D4 — reserved domains.** `rate.albusto.com`, `albusto.com`, any `*.albusto.com` → `400 RESERVED_DOMAIN`.

**D5 — domain taken (UNIQUE(domain) direction).** Company B submits company A's domain (any status) → `400 DOMAIN_TAKEN` "This domain is already in use." — NO disclosure of who holds it (PD-2). Row untouched.

**D6 — replace own domain (UNIQUE(company_id) direction).** Pre: company has `active` `rate.a.com`. When: `PUT …/domain` `{domain:'rate.b.com'}`.
Then: NOT a conflict — the row is upserted in place: `domain='rate.b.com'`, `status='pending'`, `verified_at/activated_at/last_checked_at/last_error` reset to NULL; `domain_added` event; cache cleared → `rate.a.com` stops serving immediately (its cert lapses at renewal); `rate.b.com` serves only after verify + ask.

**D7 — verify success.**
Pre: row `pending` (or `failed`); DNS CNAME of the domain resolves to a list containing `rate.albusto.com` (targets normalized: lowercase, trailing dot stripped).
When: `POST …/domain/verify`.
Then: `200 {success:true, domain:{…status:'verified', verified_at:<now>, last_checked_at:<now>, last_error:null}}`; `domain_verified` event; cache cleared. HTTP is 200 on EVERY verify outcome — status chips, not exceptions.

**D8 — verify wrong target.** CNAME resolves to `foo.vercel.app` → `200`, row `status='failed'`, `last_error`: "The CNAME points to foo.vercel.app — it needs to point to rate.albusto.com."

**D9 — verify NXDOMAIN / no CNAME.** `ENOTFOUND`/`ENODATA` → `200`, `status='failed'`, `last_error`: "We can't see the CNAME record yet — DNS changes can take up to an hour. Check the record and try again. If your DNS provider proxies traffic (e.g. Cloudflare's orange cloud), switch the record to DNS-only." (CDN CNAME-flattening = documented limitation of the CNAME-only model [OWNER].)

**D10 — verify transport error / timeout.** Resolver hangs >5 s (race-timeout) or errors (`ETIMEOUT`, `ECONNREFUSED`) → `200`; **status unchanged** (PD-4); `last_error` = humane retry copy ("We couldn't check DNS just now — please try again in a minute."); `last_checked_at` updated. Never a crash, never a 5xx for DNS weather.

**D11 — re-verify & no-demote.** Verify is callable anytime. `failed` → success → `verified`. `verified`/`active` + ANY outcome (wrong target, NXDOMAIN, timeout) → status/`verified_at`/`activated_at` unchanged, only `last_checked_at` (+ `last_error` on failure) — the no-demote rule: removal (D13) is the ONLY kill switch. `active` + success → stays `active` (never regresses to `verified`; no duplicate `domain_verified` event).

**D12 — verify without a row.** → `404 DOMAIN_NOT_FOUND`.

**D13 — remove domain.** `DELETE …/domain` → row deleted, `200 {success:true}`, `domain_removed` event, host cache cleared → ask stops authorizing and the host stops serving immediately (next request → H7/H8); the issued certificate simply lapses at its renewal. Delete without a row → `404 DOMAIN_NOT_FOUND`.

**D14 — ask allow + activation (FR-11 signal).**
Pre: row `verified` for company X, X connected. When: `GET /api/public/rate-domain-ask?domain=rate.bostonmasters.com` from loopback without XFF (Caddy's ask subrequest).
Then: `200`, **empty body**; side effect exactly once: `status verified→active`, `activated_at=NOW()`, `domain_activated` event (`actor null` — system). Subsequent asks (cached or not) → 200, NO further event/UPDATE. `active` row asks → plain 200. Rationale pin: the ask always precedes the first TLS handshake, so it is the earliest true "page is live" signal.

**D15 — ask deny matrix.** Domain `pending`/`failed`/removed/never-existed, OR owning company's `rate-me` disconnected → `404`, empty body. Deny NEVER mutates status. Missing/garbage `domain` param → 404. Responses carry no detail in either direction (NFR-4: bare 200/404 only).

**D16 — ask loopback guard.** Request with an `X-Forwarded-For` header present (i.e., anything arriving through Caddy — Caddy always sets XFF on proxied traffic) OR `remoteAddress ∉ {127.0.0.1, ::1, ::ffff:127.0.0.1}` → bare 404 regardless of the domain's real status. Public probing of the ask endpoint is therefore indistinguishable from a nonexistent route.

**D17 — ask decision cache.** Decisions memoized 60 s (key `ask:<domain>`, same store as H11: cap 1000, clear-on-overflow, cleared on every domain mutation). Storm of asks for one domain → ≤1 DB round per 60 s. Caddy-side `interval 2m / burst 5` is the secondary throttle (C1). Cache clear on mutation pins: remove → next ask misses cache → 404 (no 60 s stale-allow window).

**D18 — disconnect / reconnect semantics.** Disconnect `rate-me`: serving stops everywhere (P5 context 404s; D15 ask denies; renewals fail → cert lapses) but the domain row SURVIVES with its status. Management endpoints 404 `APP_NOT_INSTALLED` while disconnected (PD-3). Reconnect: serving + management resume WITHOUT re-verification (status preserved). Contrast (S10): `google_review_url` does NOT survive reinstall — installation-scoped vs company-scoped, deliberate asymmetry, documented for support.

**D19 — settings-dialog domain UI copy (literal).** The "Your own domain" pane shows, for input `rate.bostonmasters.com`, a monospace instruction block with EXACTLY: `Type: CNAME · Host/Name: rate · Target: rate.albusto.com` — `Host/Name` = the FIRST label of the entered domain (input `reviews.acme.co` → `Host/Name: reviews`); Target is always `public_host` from the settings GET. Status chips: `pending` amber "Waiting for DNS" · `verified` green "Verified" · `active` green "Live at https://<domain>" · `failed` red + the row's `last_error` line + a Retry (re-verify) button. A Remove affordance is always present when a row exists.

### S — Settings dispatch & rate-me settings

**S1 — rely GET byte-identical.** After the `SETTINGS_HANDLERS` registry refactor, `GET /api/marketplace/apps/rely-leads/settings` returns the byte-identical JSON it returns today (`app_key`, `installation_id`, `settings` via `resolveRelySettings`, `catalogs{unit_types,brands}`, `territory{active_mode,has_data}`). Pin = existing suites `tests/relyLeadsSettings*.js` + `tests/relyLeadsUi.structural.test.js` re-run green with ZERO edits. `validateRelySettingsInput` keeps its name AND module export (suites import it); `buildSettingsResponse` is renamed `buildRelySettingsResponse` with a byte-identical body.

**S2 — rely PUT byte-identical.** Validation behavior, stored `metadata.settings` shape (incl. `updated_at`/`updated_by` stamping), response, and the `settings_updated` event payload (`app_key, zone_mode, custom_zip_count, unit_type_count, brand_count` — moved verbatim into the rely `buildEventPayload`) are unchanged.

**S3 — whitelist & scaffold trio preserved.** `SETTINGS_ENABLED_APP_KEYS = {'rely-leads','rate-me'}`. Any other app key → `404 SETTINGS_NOT_SUPPORTED`; not-published → `404 APP_NOT_FOUND`; no connected installation → `404 APP_NOT_INSTALLED` (`resolveSettingsInstallation` untouched, `marketplaceService.js:363`).

**S4 — rate-me settings GET shape.**
`GET /api/marketplace/apps/rate-me/settings` → `200 {success:true, app_key:'rate-me', installation_id, settings:{google_review_url:string|null}, domain:{domain,status,verified_at,activated_at,last_checked_at,last_error}|null, public_host:'rate.albusto.com', request_id}`. `domain` embeds the current `rate_me_domains` row (single panel payload, A3); `null` when none. NO `catalogs`/`territory` keys (those are rely-shaped).

**S5 — google_review_url validation (PD-1).**
PUT body `{google_review_url:'https://g.page/r/abc/review'}` → stored, echoed. `'  '`/`''`/`null` → stored `null` (clears). `'http://…'` → `400 INVALID_GOOGLE_REVIEW_URL`; `'javascript:alert(1)'` → 400; `'not a url'` → 400; 501-char URL → 400; non-string → 400. ANY https host accepted (`https://maps.app.goo.gl/…`, `https://search.google.com/local/writereview?placeid=…` all valid) — NO Google-host allowlist.

**S6 — PUT wholesale replace + seeded-key survival.** PUT sends the FULL settings object; `metadata.settings` is replaced wholesale (`setInstallationSettings` = top-level `||` merge, `marketplaceQueries.js:284`) with `updated_at`/`updated_by` stamped; seeded top-level metadata keys (e.g. `seeded_by`) survive. FE therefore always sends `{google_review_url}` complete, never a patch.

**S7 — rate-me `settings_updated` event.** Payload `{app_key:'rate-me', has_google_review_url:true|false}` — the URL VALUE never enters the audit trail.

**S8 — authed-surface auth matrix.** No token → 401; authenticated user without `tenant.integrations.manage` → 403 (mount chain `src/server.js:268`, inherited by settings + all D/T endpoints); dispatcher of company A can never address company B (company from `req.companyFilter` only). Applies to every endpoint in §5.2.

**S9 — hosting radio semantics (PD-10).** Dialog radio "On albusto.com" ⇄ "On your own domain": state derives from `domain !== null`; flipping performs NO server call; selecting "own domain" reveals the D19 pane; domain mutations happen ONLY through their explicit endpoints (Save button never writes domains — it PUTs settings only); returning to albusto hosting = pressing Remove (D13), after which the radio derives back. Reopening the dialog always re-derives from the GET (no stale local mode).

**S10 — settings vs domain lifetime asymmetry.** Disconnect + reinstall `rate-me` → NEW installation row → `settings.google_review_url` is gone (reset to null; rely risk-7 semantics); the `rate_me_domains` row is company-keyed and SURVIVES. Both facts pinned in one test; documented in the dialog? NO — documentation lives in ops notes only (no UI copy this phase).

### U — RatePage (`/r/:token`) UX

**U1 — happy render, mobile-first.** GET context ok → warm-palette page (inline styles, `IBM Plex Sans`/`Manrope`, PublicInvoicePayPage precedent — NO CRM imports, plain `fetch`, never `authedFetch`): round 52 px logo (when `company_logo_url`), company name eyebrow, h1 `How did Alex Petrov do?`, five star targets ≥44 px each. Single context fetch. Usable one-handed at 375 px. NO "Blanc" string anywhere, NO CRM chrome/nav/login affordance.

**U2 — branding fallbacks.** `company_logo_url:null` → name-only header (no broken-img, no placeholder box). Logo URL present but image fails to load (expired presign — >1 h old tab, or S3 hiccup) → `onError` hides the img → identical name-only render (NFR-8).

**U3 — 5★ flow.** Tap 5th star → immediate POST `{stars:5}` (no textarea step) → response `next:'google_redirect'` → `window.location.replace(redirect_url)` (replace, not push — Back must not re-land on the consumed rating page). Between tap and redirect: stars disabled (no double-submit).

**U4 — 5★ without link.** Response `next:'thanks'` → thank-you view ("Thanks! Your feedback means a lot to us." tone) — no dead end, no error, no redirect (US-6).

**U5 — 1–4★ flow.** Tap 1–4 stars → NO POST yet → textarea appears ("What could we have done better?") + Send button; text optional (Send with empty textarea allowed) → POST `{stars, feedback}` → thank-you. Customer may change star selection before Send; only Send records.

**U6 — already-rated GET.** `already_rated:true` → thank-you view directly; NO star picker rendered (US-3). Same view as post-submit thanks.

**U7 — replay POST.** If a stale open tab POSTs after another device already rated → `already_recorded:true` → thank-you (never an error to the customer).

**U8 — POST failure honesty.** POST → 5xx/network error → inline "Something went wrong — please try again." with the star selection PRESERVED and Send re-enabled; NEVER navigates to Google on failure (NFR-8; pairs with P18 — the server never sends `redirect_url` on failure either). 429 → same inline copy.

**U9 — direct-load errors.** Context GET → 404 → full-page "This link is no longer available." (no retry — the link is dead by definition). Network failure on GET → "Something went wrong — please try again." + retry affordance.

**U10 — technician-name fallback.** `technician_name:null` → h1 `How did our technician do?`.

**U11 — SPA integration pins.** Route `/r/:token` sits beside `/e/:token` (`App.tsx:112`). `PUBLIC_AUTH_PATHS = ['/signup','/pay','/e','/r/']` — **trailing slash** (`AuthProvider.tsx:192`): `/r/<token>` bypasses Keycloak on ANY host; `/r` (no slash) does NOT match and is not a served path anyway (gate 404s it on rating hosts, H3). AppLayout bare-return list (`AppLayout.tsx:235`) += `startsWith('/r/')` → no header/nav/softphone even on app hosts (H12). Edge: `/r/` exact (empty token) — gate-allowlisted, SPA loads, router matches nothing (App.tsx has NO catch-all route — verified) → blank bare page, KC still bypassed, no redirect loop; acceptable (token-less links are never produced). Console-noise budget on rating hosts: `manifest.webmanifest` 404 + possible SSE `/events` retry noise = accepted (`/pay` behavior class); RatePage itself must trigger neither.

### C — Caddy & infra

**C1 — global fragment (exact text).** The existing global options block (`infra/Caddyfile` — today `{ email help@bostonmasters.com }`) gains exactly one directive:

```caddyfile
{
	email help@bostonmasters.com
	on_demand_tls {
		ask http://127.0.0.1:3000/api/public/rate-domain-ask
		interval 2m
		burst 5
	}
}
```

Caddy **2.6.2** on the box (verified in `infra/README.md`): `interval`/`burst` are valid on this version, REMOVED in ≥2.8 — README must carry a re-check note for any Caddy upgrade. The ask URL is called by Caddy itself over plain local HTTP (never through TLS, never through the proxy — hence D16's XFF-absent guard holds).

**C2 — dedicated host block (exact text).**

```caddyfile
rate.albusto.com {
	encode zstd gzip
	reverse_proxy 127.0.0.1:3000
}
```

Normal managed certificate; `rate.albusto.com` NEVER depends on the ask path (FR-13) — if the ask endpoint is down, option A keeps serving.

**C3 — on-demand catch-all (exact text).**

```caddyfile
https:// {
	encode zstd gzip
	tls {
		on_demand
	}
	reverse_proxy 127.0.0.1:3000
}
```

Explicit host blocks always win over the `https://` catch-all → `albusto.com`, `app`/`api.albusto.com`, `auth.albusto.com` blocks remain byte-identical (append-only; pin by diffing the reference file). A TLS handshake for ANY unknown SNI triggers the ask → 404 → no certificate → handshake fails; the HTTP-layer gate (H7/H8) is the second belt.

**C4 — README procedure + deploy order.** `infra/README.md` gains a Rate Me section: (1) app deploy with mig 172 — dark, CRM byte-identical (NFR-9); (2) owner adds GoDaddy A-record `rate → 108.61.87.117` — browser-only, no API [memory constraint]; (3) Caddyfile apply via the EXISTING validate → backup → swap → reload procedure (`caddy validate` → `sudo cp` backup → swap → `sudo systemctl reload caddy`); (4) smoke: `curl -H 'Host: rate.albusto.com' 127.0.0.1:3000/r/x` → uniform 404; mint a token via the smoke endpoint (T1) and open `https://rate.albusto.com/r/<token>`; (5) rollback = restore `Caddyfile.bak.<ts>` + reload. Prod deploy itself remains owner-consent-gated («да» per deploy).

---

## 5. API contracts (exact)

### 5.1 Public surface (no auth; mounted at `/api/public` in `src/server.js` next to the existing public mounts, BEFORE authed routers)

#### `GET /api/public/rate/:token`
- Middleware order: rate-limit (60/min, PD-5) → token format guard → service.
- Host scope: from `req.rateHost` (H-group); absent ⇒ token-only.
- **200**
```json
{ "ok": true, "data": {
    "company_name": "Boston Masters",
    "company_logo_url": "https://<s3-presigned…>",
    "technician_name": "Alex Petrov",
    "already_rated": false,
    "five_star_redirect": true
} }
```
  `company_logo_url` and `technician_name` nullable; other keys always present; **exactly 5 keys**.
- **404** (uniform, all five failure classes) `{ "ok": false, "error": { "code": "NOT_FOUND", "message": "Invalid link" } }`
- **429** `{ "ok": false, "error": { "code": "RATE_LIMITED", "message": "Too many requests" } }`
- **500** `{ "ok": false, "error": { "code": "INTERNAL", "message": "…" } }`

#### `POST /api/public/rate/:token/rating`
- Middleware order: rate-limit (10/min) → token format guard → body validation → service.
- Request `{ "stars": 5, "feedback": "optional string" }` — `stars` integer 1–5 required; `feedback` optional string (trim → cap 2000 → empty ⇒ null); ALL other fields ignored (P14).
- **200** first record, 5★ + link: `{ "ok": true, "data": { "recorded": true, "next": "google_redirect", "redirect_url": "https://g.page/…" } }`
- **200** first record, otherwise: `{ "ok": true, "data": { "recorded": true, "next": "thanks" } }`
- **200** replay: `{ "ok": true, "data": { "recorded": false, "already_recorded": true, "next": "thanks" } }`
- **400** `INVALID_STARS` | `INVALID_FEEDBACK` (pre-DB; P19) · **404** uniform · **429** · **500** as above. `redirect_url` appears in exactly ONE shape: first-record + stars=5 + link configured.

#### `GET /api/public/rate-domain-ask?domain=<host>`
- Loopback-only (D16); NOT rate-limited (cached, D17). **200 empty body** = authorize (verified/active + connected; flips `verified→active` on first allow) · **404 empty body** = everything else. No other status, no body content, ever.

### 5.2 Authed surface (mount `src/server.js:268`: `authenticate + requirePermission('tenant.integrations.manage') + requireCompanyAccess`; company = `req.companyFilter.company_id`, actor = `req.user.crmUser.id`)

| Endpoint | Request | Success | Errors (authed envelope `{success:false, code, message, request_id}`) |
|---|---|---|---|
| `GET /api/marketplace/apps/rate-me/settings` | — | `200 {success, app_key, installation_id, settings:{google_review_url}, domain:<row\|null>, public_host, request_id}` (S4) | 404 `SETTINGS_NOT_SUPPORTED`/`APP_NOT_FOUND`/`APP_NOT_INSTALLED` |
| `PUT /api/marketplace/apps/rate-me/settings` | `{google_review_url: string\|null}` (full object) | same shape as GET | 400 `INVALID_GOOGLE_REVIEW_URL`; scaffold-trio 404s |
| `PUT /api/marketplace/apps/rate-me/domain` | `{domain: string}` | `200 {success:true, domain:<row>}` | 400 `INVALID_DOMAIN`/`APEX_DOMAIN_NOT_SUPPORTED`/`RESERVED_DOMAIN`/`DOMAIN_TAKEN`; 404 `APP_NOT_INSTALLED` |
| `POST /api/marketplace/apps/rate-me/domain/verify` | — | `200 {success:true, domain:<row>}` — HTTP 200 for verified AND failed outcomes (D7–D11) | 404 `DOMAIN_NOT_FOUND`/`APP_NOT_INSTALLED` |
| `DELETE /api/marketplace/apps/rate-me/domain` | — | `200 {success:true}` | 404 `DOMAIN_NOT_FOUND`/`APP_NOT_INSTALLED` |
| `POST /api/marketplace/apps/rate-me/tokens` | `{job_id?: int, tech_id: string, tech_name?: string}` | `201 {success:true, token:{token, url}}` | 400 `JOB_NOT_FOUND`/`INVALID_TECH_ID`; 404 `APP_NOT_INSTALLED` |

`<row>` = `{domain, status, verified_at, activated_at, last_checked_at, last_error}`. All six endpoints: 401 unauthenticated, 403 without the permission (S8).

### 5.3 Error taxonomy (complete)

| Surface | Code | HTTP | Trigger |
|---|---|---|---|
| public | `NOT_FOUND` ("Invalid link") | 404 | malformed / unknown / expired / foreign-host / app-disconnected token — uniform |
| public | `INVALID_STARS` | 400 | stars not an integer 1–5 (PD-8) |
| public | `INVALID_FEEDBACK` | 400 | feedback present, not a string |
| public | `RATE_LIMITED` | 429 | per-IP window exceeded (PD-5) |
| public | `INTERNAL` | 500 | storage/unexpected failure — honest, no redirect |
| ask | — (empty) | 200/404 | authorize / silence — no body either way |
| authed | `INVALID_GOOGLE_REVIEW_URL` | 400 | PD-1 violation |
| authed | `INVALID_DOMAIN` | 400 | not a valid hostname |
| authed | `APEX_DOMAIN_NOT_SUPPORTED` | 400 | <3 labels |
| authed | `RESERVED_DOMAIN` | 400 | albusto.com family |
| authed | `DOMAIN_TAKEN` | 400 | UNIQUE(domain) held by another company (PD-2) |
| authed | `DOMAIN_NOT_FOUND` | 404 | verify/delete with no row |
| authed | `JOB_NOT_FOUND` | 400 | mint job_id absent from company scope |
| authed | `INVALID_TECH_ID` | 400 | mint tech_id missing/empty/non-string |
| authed | `SETTINGS_NOT_SUPPORTED` / `APP_NOT_FOUND` / `APP_NOT_INSTALLED` | 404 | scaffold trio (unchanged) |
| authed | `INTERNAL_ERROR` | 500 | marketplace handleError fallback (unchanged) |
| gate | plain `Not found` / JSON `NOT_FOUND` | 404 | non-allowlisted path on rating host (H3) |
| gate | — | 503 | domain lookup DB failure, custom-host branch only (H9) |

---

## 6. State machines

**`rate_me_domains.status`** (transitions ONLY via the named operations; anything not listed is forbidden):
```
(no row) --PUT domain--> pending
pending  --verify: CNAME ok-->            verified   (+verified_at, +domain_verified)
pending  --verify: wrong target/NXDOMAIN--> failed   (+last_error)
pending  --verify: transport error-->      pending   (last_error only; PD-4)
failed   --verify: CNAME ok-->            verified
failed   --verify: fail/transport-->       failed    (last_error refreshed / retry copy)
verified --first positive ask-->           active    (+activated_at, +domain_activated, actor null)
verified/active --verify: ANY outcome-->   unchanged (no-demote; last_checked_at only)
any      --PUT new domain-->               pending   (row reset in place, D6)
any      --DELETE-->                       (no row)  (+domain_removed)
```
Serve-authorized = `{verified, active}` (both; the split is humane copy only, FR-11). App-disconnect does NOT touch status — it suppresses serving orthogonally (D18).

**Token lifecycle:** `minted` (used_at NULL) → *n×* GET (no change) → first recorded rating (`used_at` stamped + rating row, atomic) → terminal `rated` (every later POST = replay 200; GET shows `already_rated`). Expiry (when set, future) short-circuits any state to uniform-404 behavior without touching the row.

---

## 7. Component interaction

- **Public page:** browser → `GET rate-host/r/<token>` → Caddy (`rate.albusto.com` block or on-demand cert) → Express → `rateHostGate` (stamps `req.rateHost`) → static/SPA fallback → RatePage → `fetch GET /api/public/rate/:token` → `public-rate.js` → `rateMeService.getPublicContext` → `rateMeQueries.getTokenContext` (1 query) + connected-meta (1 query) + presign → DTO. Star tap → `fetch POST …/rating` → `submitRating` txn (insert ON CONFLICT + stamp) → response drives redirect/thanks. **No SSE, no React Query, no sonner on the public page** (it is CRM-free by design).
- **Ask:** Caddy on_demand_tls → `GET 127.0.0.1:3000/api/public/rate-domain-ask?domain=…` → gate (localhost = pass-through H1) → loopback guard → `authorizeAskDomain` (cache → domain row → connected check → maybe activate) → bare 200/404 → Caddy issues/refuses the cert.
- **Settings:** IntegrationsPage tile (connected `rate-me`) → Settings button → `RateMeSettingsDialog` (FORM-CANON right panel) → `useQuery(['rate-me-settings'])` → `marketplaceApi.fetchRateMeSettings` → authed GET; Save → PUT settings; domain pane → PUT/POST-verify/DELETE domain endpoints; every mutation invalidates `['rate-me-settings']`; errors → sonner toast with the humane `message`.
- **Mint (smoke only):** authed `POST …/tokens` → `rateMeService.mintToken` → URL; no UI.
- **Audit:** every settings/domain mutation → `marketplaceQueries.writeEvent` (§D9 architecture); structured `[RateMe]` logs per FR-14 (never the full token — `token_prefix(8)` only; it is the credential).

---

## 8. Invariants checklist (every one is a test target)

1. Uniform-404 quintet on the public surface is byte-identical (P2–P6 deep-equal).
2. Company/job/tech identity derives ONLY from the token row; request body can never influence it (P14).
3. `redirect_url` exists ONLY in a first-record POST response with `stars=5` AND link configured — never in GET, never on replay, never on failure (P8/P10/P15/P18).
4. One rating per token EVER — DB `UNIQUE(rate_token_id)` anchor; replay is 200-idempotent, no overwrite (T8/P15/P16).
5. Rely settings GET/PUT byte-identical through the dispatch refactor — existing rely suites green, zero edits (S1/S2).
6. `src/server.js` diff = exactly two flagged mount additions (gate after CORS/before webhooks; public-rate router beside existing public mounts) (H10/NFR-10).
7. Existing public routers (`public-estimates`, `public-invoices`, `publicAuth`) byte-identical.
8. Ask endpoint: bare 200/404 only; authorizes only `verified`/`active` + connected; loopback-only; deny mutates nothing (D14–D16).
9. No-demote: `verified`/`active` never regress except by DELETE (D11/PD-4).
10. `DOMAIN_TAKEN` never discloses the holder (D5).
11. Public GET DTO = exactly 5 whitelisted keys; new field ⇒ new requirement (P1/NFR-6).
12. Rating hosts expose ONLY the rating surface: no CRM path, no `/api/*` beyond it, no webhook mounts, no KC redirect, no CRM cookies (H3/H10).
13. Albusto-host traffic passes the gate with zero DB/cache work (H1).
14. Tokens ≥128-bit (192 actual, 32-char base64url); estimate 64-bit mint NOT copied (T6/NFR-1).
15. No "Blanc" string, no CRM chrome on the public page (U1).
16. Every rate-me query is company- or token-scoped; no cross-tenant read path exists (§3, NFR-3).
17. Protected files: `authedFetch.ts`, `useRealtimeEvents.ts` untouched; `backend/db/` touched only by migration 172 (+ rollback).
18. Migration 172 is additive/idempotent/dark-safe; CRM byte-identical until manual Caddy/DNS steps (T10/NFR-9/C4).
19. Domain mutations clear the host/ask caches — removal takes effect immediately, never after a stale-cache window (H11/D17).
20. Cache is bounded (cap 1000, clear-on-overflow) — an attacker enumerating hosts cannot balloon memory (H11/D17).

---

## 9. Non-goals (out of scope this phase — do NOT spec, build, or test)

- SMS sending; ANY automatic mint trigger (job-Done etc.). The mint endpoint is a smoke seam only, UI-less.
- Ratings viewing/analytics/moderation anywhere in the CRM [OWNER: stored only]; deletion of ratings.
- Configurable happy threshold [OWNER: 5★ exactly]; per-technician Google links.
- Referrals, rewards, coupons.
- Multiple custom domains per company; apex/ANAME/ALIAS support; wildcard hosts; automatic periodic DNS re-checks; resolved-A fallback for CNAME-flattening CDNs (documented limitation, D9).
- Any change to the legacy lead-engine rate-me or ABC Homes' Vercel site (US-8 = compatibility note: their later option-B needs one CNAME `rate.abchomes-appliance.com → rate.albusto.com`; apex/www stay on Vercel).
- Zenbooker writes (technician data read-only); `companies` schema changes (Google link lives in installation metadata).
- Separate light JS bundle for the public page (accepted `/e`-precedent trade-off: full SPA bundle served on rating hosts).
- SSE/realtime on any new surface.

---

## 10. Security & data isolation (agent-03 mandated summary)

- Public reads are bound by the token row's `company_id`; custom hosts add the `token.company_id = domain.company_id` constraint inside the single lookup query (§3 matrix — authoritative for every host×token combination).
- Authed endpoints: `authenticate + requirePermission('tenant.integrations.manage') + requireCompanyAccess`; `company_id` exclusively from `req.companyFilter`; cross-company addressing structurally impossible; 404 (not 403) for foreign/unknown resources — existence never leaks.
- Anti-enumeration: 192-bit tokens, format pre-guard, uniform 404, per-IP XFF-keyed rate limits (60/min GET, 10/min POST), 404-reason classes only in logs (`bad_format|not_found|host_mismatch|app_disconnected|expired`), never the full token.
- Ask endpoint: loopback-only + bare responses + bounded cache; public probing indistinguishable from a nonexistent route; certificates issued exclusively for verified/active domains of connected installations.
- NFR-5: rating hosts cannot reach the CRM (gate-404 before any router/static), Keycloak never engages there, webhook mounts unreachable; Albusto hosts byte-identical.
- Public DTO minimalism: 5 whitelisted fields; `google_review_url` exposed only as a boolean in GET and as `redirect_url` after a recorded 5★.
