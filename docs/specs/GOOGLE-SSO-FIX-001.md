# GOOGLE-SSO-FIX-001 — "Continue with Google" (fix + hardening)

**Status:** Implemented (pending deploy)
**Area:** Auth (Keycloak) · Frontend signup/login · Onboarding
**Predecessor:** ALB-101 self-registration, AUTH-FLOW-FIX-001

## Problem

Clicking **Continue with Google** on `https://app.albusto.com/signup` does nothing —
console throws `TypeError: Cannot read properties of undefined (reading 'login')`.

Root cause is **frontend**, not Keycloak: the prod `crm-prod` realm already has a
working `google` identity provider (verified — the broker correctly redirects to
`accounts.google.com` with client `730558866466-…` and scope `openid email profile`).
But the public `/signup` page skips `kc.init()` (the `publicPage` guard in
`AuthProvider`), so `getKeycloak().login()` runs on an instance whose `adapter` is
`undefined` — and, lacking `init`'s `pkceMethod`, would emit no PKCE `code_challenge`
while the `crm-web` client mandates PKCE (`error=invalid_request … Missing parameter:
code_challenge_method`).

Secondary findings:
- **Config drift:** the git realm export (`keycloak/realm-export.json`) had
  `identityProviders: []` — the prod IdP was added by hand and lives nowhere in source.
- No **auto-link** on verified email → a Google login for an email that already has a
  password account would hit the manual-link prompt.
- No given/family split; **Continue with Google** existed only on `/signup`, not sign-in.

## Behavior (target)

### B1 — Signup Google button initiates login (primary fix)
`loginWithIdp('google', origin + '/onboarding')` lazily runs
`kc.init({ pkceMethod:'S256', checkLoginIframe:false })` (no `onLoad` → no auto-redirect;
only wires the adapter + PKCE), then `kc.login({ idpHint:'google', redirectUri })`.
keycloak-js persists the PKCE verifier in callback storage; the `/onboarding` return page's
`kc.init({ onLoad:'login-required', pkceMethod:'S256' })` completes the code→token exchange.

### B2 — Registration data from Google
Scope `openid profile email` yields `email` (+`email_verified`), `name`, `given_name`,
`family_name`. `userService.findOrCreateUser` already upserts `crm_users.full_name` + `email`
from the token (`name`/`email` claims) on first authenticated request — unchanged. IdP
attribute mappers additionally set Keycloak `firstName`/`lastName` from `given_name`/`family_name`.
`picture`/`locale` are intentionally NOT consumed (no avatar column added).

### B3 — Auto-link on verified email
IdP `trustEmail: true` + first-broker-login flow **"first broker login auto link"**
(`idp-review-profile` DISABLED, `idp-create-user-if-unique` ALTERNATIVE, `idp-auto-link`
ALTERNATIVE). A Google identity whose verified email matches an existing account links
automatically — no prompt.

### B4 — Google on the sign-IN page
`login.ftl` renders `social.providers` as a styled "Continue with Google" button above the
password form, so existing users can also sign in with Google.

### B5 — Onboarding unchanged (SMS kept)
A Google user returns to `/onboarding` authenticated with no company and completes the
**existing** flow: phone → SMS OTP (kept) → company creation (`POST /api/onboarding`).
No onboarding code change.

## Non-goals
- No DB migration (given/family live in Keycloak; no avatar column).
- No change to protected files (`src/server.js`, `authedFetch.ts`, `useRealtimeEvents.ts`, `backend/db/`).
- Does not disable email/password signup.

## Apply to prod
Realm import only configures a realm on FIRST import, so `realm-export.json` edits do NOT
reach the existing prod realm. Run `scripts/setup-google-idp.sh` (idempotent Admin-REST
create-or-update) against prod with `GOOGLE_IDP_CLIENT_ID/SECRET` to (re)provision the IdP,
mappers, and auto-link flow. If the IdP already carries these settings on prod, the script
is a no-op-safe refresh.

## Files
- `frontend/src/auth/AuthProvider.tsx` — `ensureKeycloakInitialized()` + `loginWithIdp()`.
- `frontend/src/pages/auth/SignupPage.tsx` — button uses `loginWithIdp`.
- `keycloak-themes/albusto/login/login.ftl` + `resources/css/albusto-login.css` — social button.
- `keycloak/realm-export.json` — `identityProviders` + `identityProviderMappers` + auto-link flow.
- `scripts/setup-google-idp.sh` — idempotent prod applier.
- `.env.example` — `GOOGLE_IDP_CLIENT_ID/SECRET`.
