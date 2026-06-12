# ALB-100 — Albusto Commercial Platform Program — Spec

**Date:** 2026-06-12 · Requirements: `docs/requirements.md` §ALB-100 ·
Architecture: `docs/architecture.md` §ALB-100

---

## 1. Public auth API (`/api/public/*`, no authenticate)

All endpoints: `express-rate-limit` (per-IP), JSON only, no tenant data ever
returned, generic errors (no user-enumeration: "If the email exists…").
Kill-switch `FEATURE_SELF_SIGNUP=false` → all return `503 SIGNUP_DISABLED`.

### POST /api/public/signup
Body: `{ email, password, full_name }`
- Validates email format, password ≥ 8 chars.
- Creates Keycloak user (enabled, emailVerified=false, requiredAction VERIFY_EMAIL),
  realm role `company_member` NOT assigned (no tenant yet).
- Triggers Keycloak verify-email.
- 200 `{ ok: true }` even if email already exists (anti-enumeration); if exists —
  sends "you already have an account" email instead (best-effort, non-blocking).
- Errors: 422 VALIDATION_ERROR, 429, 503.

### POST /api/public/otp/send
Body: `{ phone, purpose: 'signup'|'login', context? }`
- `phone` normalized to E.164; reject invalid → 422.
- Limits: ≤ 5 sends per phone per hour, ≤ 10 per IP per hour → 429 OTP_RATE_LIMITED.
- Generates 6-digit code, stores sha256(OTP_PEPPER + code), TTL 5 min,
  invalidates previous unconsumed codes for same phone+purpose.
- SMS text: `Albusto: your verification code is XXXXXX. Valid 5 minutes.`
- 200 `{ ok: true, resend_after_sec: 30 }`.

### POST /api/public/otp/verify
Body: `{ phone, purpose, code }`
- 3 attempts per code → then code consumed, 410 OTP_EXPIRED.
- Success → marks consumed, returns one-time `otp_token` (JWT, 10 min,
  signed with JWT_SECRET, payload {phone, purpose}) used by subsequent step.
- Errors: 401 OTP_INVALID (attempts left in payload), 410 OTP_EXPIRED.

### POST /api/public/onboarding  (authenticated — Bearer Keycloak token)
Body: `{ company_name, place: {place_id} | manual:{city,state,zip}, otp_token }`
- Requires: token user has NO active membership yet (else 409 ALREADY_ONBOARDED);
  `otp_token` with purpose signup matching a verified phone.
- Resolves place server-side → {city,state,zip,lat,lng,timezone}.
- `bootstrapCompany(...)` transaction (see architecture); saves phone to
  company_user_profiles.phone + crm_users; marks user onboarded.
- 201 `{ ok, company: {id,name,timezone}, redirect: '/pulse' }`.

### GET /api/public/places/suggest?q=...
- Proxies Google Places Autocomplete (types=(regions) cities+zips, country=US),
  returns `[{place_id, description}]` (≤ 5). 200 `{ suggestions: [] }` when the
  Google key is missing/fails (frontend falls back to manual city/state/zip).

### GET /api/public/places/resolve?place_id=...
- Place Details → geometry → Time Zone API → `{city,state,zip,lat,lng,timezone}`.

## 2. Login 2FA (trusted devices) — FEATURE_SMS_2FA

- `authenticate()` (FEATURE_AUTH on, feature flag on): after JWT ok and crm_user
  resolved, if user has verified phone AND no valid `albusto_td` cookie row →
  `401 PHONE_VERIFICATION_REQUIRED { phone_hint: '+1•••1416' }`.
- Frontend AuthProvider: on this code → OTP modal (send/verify purpose login) →
  `POST /api/auth/trust-device { otp_token }` (authenticated) → sets cookie
  `albusto_td=<random 128bit>` Max-Age 30d, stores sha256 in trusted_devices.
- Exemptions: `/api/public/*`, SSE endpoints, `/health*`, devMode, users
  WITHOUT a verified phone (legacy users until they add one).
- `PATCH /api/users/:id` phone change → revoke user's trusted_devices.

## 3. Platform companies API

- `GET /api/platform/companies?status&q&page&limit` → rows: id, name, slug,
  city/state, status, created_at, users_count, last_activity_at (max of
  jobs/leads/calls created_at, nullable).
- `GET /api/platform/companies/:id` → platform metadata + audit summary
  (last 20 audit_log rows for company) — NO tenant business data.
- `PATCH /api/platform/companies/:id` → {name, slug, timezone, locale,
  contact_email, contact_phone, status: active|suspended, status_reason}.
  suspend/restore writes audit `company.suspended|company.restored`.
- All require requirePlatformRole('super_admin'). 404 for unknown id.

## 4. HARDENING-002 contracts

- calls: list/detail/recording/transcript → `reports.calls.view` permission
  (canonical), company-scoped queries; provider scope: only calls whose
  timeline/contact is reachable from assigned jobs (same EXISTS as pulse).
- messaging/conversations: read → `messages.view_client`; send →
  `messages.send`; conversation/message lookups company-scoped; provider —
  own clients only.
- leads: `leads.view/create/edit/convert` per action; queries company-scoped;
  providers (assigned_only) get 404 on foreign leads, list filtered to leads
  linked to visible jobs' contacts (provider normally has no leads.view).
- email: read `messages.view_client`, send `messages.send`, mailbox admin →
  `tenant.integrations.manage`; account/thread/message lookups company-scoped.
- Non-visible/foreign entity by id → 404 (никогда 403).

## 5. Provider bridge UI

User drawer (CompanyUsersPage) → "Field tech" card:
- Toggle `is_provider`.
- When on: combobox "Zenbooker team member" — options from roster, current
  value resolved by id; "Not linked" state with amber dot; linked — green dot +
  member name; Unlink button.
- Save → PATCH /api/users/:id { profile: { is_provider, zenbooker_team_member_id } }.
- Success toast: "Provider linked — visible jobs refreshed".
- Roster fetch error → manual text input for the id + helper text.

## 6. Edge cases

- OTP send to landline / Twilio error → 502 OTP_DELIVERY_FAILED, friendly UI.
- Resend pressed < 30s → 429 (UI блокирует кнопку countdown'ом).
- Onboarding interrupted (no company yet, token valid) → /onboarding resumes.
- Google user with same email as existing Keycloak user → Keycloak link flow
  (idp account linking by verified email).
- Suspended company login → tenant routes 403 COMPANY_SUSPENDED; UI shows
  "Workspace suspended — contact support" screen.
- Trusted device cookie present but row revoked/expired → 401 → OTP flow.
