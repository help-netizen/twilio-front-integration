# ONBOARD-FIX-001 — onboarding access, tenant-isolation hardening, phone mask, theme audit

**Status:** Implemented (pending deploy) · **Area:** Auth (tenant isolation) · Frontend onboarding · Keycloak theme
**Follow-up to:** GOOGLE-SSO-FIX-001

## Parts

### SEC — tenant-isolation leak (P0)
**Problem.** `requireCompanyAccess` resolved the tenant as
`req.authz?.company?.id || req.user?.company_id`. `req.user.company_id` is the
`crm_users.company_id` "shadow" that migration 012 backfilled to the seed company
(`00000000-0000-0000-0000-000000000001`, Boston Masters). So any user with **no active
membership** but a stale shadow resolved to Boston Masters and could read its data.
The dev bypass (`!FEATURE_AUTH`) also hard-codes that same seed company — a total leak if
it ever runs in prod.

**Fix.**
- `requireCompanyAccess`: `const companyId = req.authz?.company?.id || null;` — tenant scope
  comes **only** from an active membership (`company_memberships`, via `resolveAuthzContext`).
  No membership → `403 TENANT_CONTEXT_REQUIRED`. (`req.user.company_id` remains for
  audit-log context only — marked `tenant-safety-allow`.)
- `authenticate`: the `!FEATURE_AUTH` dev branch **fails closed in production**
  (`NODE_ENV==='production'` → `500 AUTH_MISCONFIGURED`), never serving the seed company.
- Migration 140: clears `crm_users.company_id` wherever it isn't backed by an active
  membership in that company (neutralizes the mig-012 backfill; logs affected row count;
  idempotent). Preserves the shadow where it correctly mirrors a membership.

### A — onboarding lands with no access / flicker
**Problem.** After `POST /api/onboarding` creates the company + tenant_admin membership, the
SPA navigates client-side to `/pulse`, but the authz context (`company`, `permissions`) was
fetched once at app init (pre-company) and never refreshed → `OnboardingGate` (App.tsx) sees
`company == null` and loops back to `/onboarding` (the flicker), and `/pulse`'s
`ProtectedRoute` denies (`pulse.view` missing) → "You don't have access here."

**Fix.** `AuthProvider` exposes `refreshAuthz()` (re-`GET /api/auth/me` with the current
token — the backend resolves from `company_memberships`, so no token refresh needed).
`OnboardingPage.createCompany` `await refreshAuthz()` **before** navigating, on both the
success and `ALREADY_ONBOARDED` paths. `useAuthz` reads from `useAuth`, so `ProtectedRoute`
sees the refreshed permissions immediately.

**Note on the reporter's case (UNCONFIRMED).** The actual Google signup account was
`help@abchomes-appliance.com` (the `office@bostonmasters.com` seen earlier was on an
"Account already exists" confirm page and may be a separate test). A fresh cross-domain email
is unlikely to be a pre-seeded Boston Masters member, so this may be a **genuine leak** rather
than an expected "already a member" case. A brand-new user created after mig 012 would have
`company_id=NULL` → 403 (not Boston Masters); seeing Boston Masters implies a seed `company_id`
(pre-mig-012 row or another path). Must be confirmed with a prod DB check (TC-SEC-DB, run with
`help@abchomes-appliance.com`). The SEC fix closes the structural hole either way.

### B — masked phone on onboarding
`OnboardingPage` "Verify your phone" used a raw `<input type=tel>`. Now it masks input via
the shared `formatUSPhone` util (same formatting as the New Lead card's `PhoneInput`) and
sends `toE164(phone)` to `/api/public/otp/send` and `/otp/verify`. The onboarding card's own
input styling is kept (consistent with its other fields).

### C — Keycloak theme audit
The albusto theme ships only `albusto-login.css` (no base styles), so any non-overridden
page renders unstyled. Themed the 6 reachable-but-missing templates:
`login-otp.ftl`, `select-authenticator.ftl`, `login-reset-password.ftl`,
`login-update-password.ftl`, `error.ftl`, `idp-review-user-profile.ftl` — all via
`registrationLayout` + `.field`/`.btn` classes.

## Files
- `backend/src/middleware/keycloakAuth.js` — remove shadow fallback; dev fail-closed.
- `backend/db/migrations/140_clear_orphan_company_id_shadow.sql` — data hygiene.
- `frontend/src/auth/AuthProvider.tsx` — `refreshAuthz()`.
- `frontend/src/pages/auth/OnboardingPage.tsx` — refresh authz post-onboarding; masked phone.
- `keycloak-themes/albusto/login/{login-otp,select-authenticator,login-reset-password,login-update-password,error,idp-review-user-profile}.ftl`.
- `tests/keycloakAuth.test.js` — leak regression + fail-closed.

## Non-goals
No change to protected files; no token-shape change; the reporter's account-linking UX
(auto-link vs "create new company") is unchanged (tracked separately).
