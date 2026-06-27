# AUTH-FLOW-FIX-001 — Post-signup email-verification UX + 2FA SMS loop & throttle

Status: PLANNED (orchestrate pipeline, 2026-06-27). Owner-reported after a real prod signup.
Areas: Keycloak `albusto` theme (FreeMarker), frontend (onboarding + 2FA gate), backend (otpService, onboarding).

## Problem (observed on prod)

1. **Email-verify pages render duplicated text** — "Confirm validity of e-mail address …" ×2 and
   "Your account has been updated." ×2. Cause: our `registrationLayout` (`template.ftl:44‑51`) prints
   `message.summary` AND the inherited base `info.ftl` prints it again.
2. **Unnecessary intermediate "» Click here to proceed"** step (KC base `info.ftl` cross-session
   confirm) before the success page.
3. **Bland "Your account has been updated"** instead of a human success page.
4. **Post-signup 2FA reload loop + repeated SMS.** After onboarding, `crm_users.phone_verified_at`
   is set but no trusted-device cookie exists → landing on `/pulse` returns
   `401 PHONE_VERIFICATION_REQUIRED` (`keycloakAuth.js:114‑134`) → `TwoFactorGate` opens and
   **auto-sends an SMS** (`TwoFactorGate.tsx:56‑57`); the page reloads and re-mounts the gate →
   another SMS → loop.
5. **Flat rate-limit** (`otpService.js`: 5/hour + 30s) — owner wants an escalating per-phone throttle.

## Decisions (owner interview, 2026-06-27)

- D1: **Onboarding completion auto-trusts the device** (sets `albusto_td`) → no immediate gate / 2nd SMS.
- D2: Email link → **straight to a styled success page** (no "proceed" click; accept minor link-scanner risk).
- D3: **Escalating per-phone SMS throttle on BOTH** signup (`/api/public/otp/send`) and login
  (`/api/auth/otp/send`) paths; **reset on successful verification**; server-enforced.
- D4: Replace "account updated" with a **branded Albusto success page + "Sign in to Albusto" button**
  (→ app.albusto.com, no auto-redirect); de-dupe message text.

## Requirements

- R1 (D4,#1): Email-verification & generic info/account pages render each message exactly once, in the
  Albusto/Blanc shell (product name "Albusto", never "Blanc").
- R2 (D2): Clicking the email link reaches the success state without a manual "proceed" click.
- R3 (D4): A dedicated, human success page after email verification with a "Sign in to Albusto" CTA → app.albusto.com.
- R4 (D1): Completing `/api/onboarding` trusts the current device (30-day `albusto_td` cookie) so the
  user is NOT challenged by the 2FA gate immediately after signup.
- R5: No reload/SMS loop on the post-signup `/pulse` landing.
- R6 (D3): SMS send throttle per E.164 phone (across purposes): ≤3 sends / 5 min (keep base 30s cooldown);
  then escalating minimum gap before the next send — 1 min → 5 min → 15 min → 1 h; ladder resets after a
  successful `verifyCode` for that phone, or after ≥1 h idle. Applies in `otpService.sendCode` (both routes).
- R7: Throttled sends return HTTP 429 with `{ code: 'OTP_RATE_LIMITED', message, retry_after_sec }`; the
  gate + onboarding UIs show the wait and do not spam.
- R8: Security/tenancy conventions unchanged (no company_id leak; `/api/auth/*`, `/api/public/*`,
  `/api/onboarding` stay 2FA-exempt). No regressions to existing OTP verify/trust-device.

## Architecture / approach

### Workstream A — Keycloak theme (`keycloak-themes/albusto/login/`)
- **A1** `info.ftl` (new): call `registrationLayout` with `displayMessage=false`; render the message once;
  when this is the email-verified/account-updated terminal page, show R3 success copy + "Sign in to
  Albusto" button (`${properties.appUrl!'https://app.albusto.com'}`). For pages that carry an
  `actionUri`/`pageRedirectUri` (the cross-session confirm, #2/D2), **auto-proceed** (immediate redirect)
  instead of a manual link → user lands on the terminal success page.
- **A2** `login-verify-email.ftl` (new): branded "check your inbox" instruction page, message once.
- **A3** `messages/messages_en.properties` (new): humanize `emailVerifyInstruction`, `accountUpdated`,
  and any reused keys. Verify exact base keys/variables against **KC 26** base theme during implementation.
- **A4** `theme.properties`: add `appUrl=https://app.albusto.com`.
- Deploy note: theme/CSS changes require `docker compose up -d --force-recreate keycloak` (stale gzip cache).

### Workstream B — Backend
- **B1** `otpService.sendCode`: replace the flat limit with the R6 escalation. Compute from send history
  per phone (windowed COUNT on `phone_otp.created_at`, scoped to sends since the last successful verify);
  add `last_verified_at` tracking per phone for ladder reset (new column on a small table or derive from
  `phone_otp.consumed_at` of verified rows — Implementer picks the cleanest; migration only if needed,
  next number after 123 = **124**). Throw `OtpError('OTP_RATE_LIMITED', msg, 429, { retry_after_sec })`.
- **B2** `routes/onboarding.js`: after company bootstrap + phone store, `otpService.trustDevice(userId)` and
  set the `albusto_td` cookie on the response (mirror `authDevice.js` trust-device cookie attrs).
- **B3** Keep `verifyCode` resetting the ladder (it already consumes the row; ensure throttle reads "since
  last verified").

### Workstream C — Frontend
- **C1** `TwoFactorGate.tsx`: on 429 show the retry countdown instead of erroring; don't auto-resend while
  throttled; ensure a single in-flight send per open.
- **C2** Confirm `services/twoFactorGate.ts` dedupes concurrent 401s (one gate, one send) — fix if not.
- **C3** Diagnose the full-page **reload** source on `/pulse` (suspect: the Fly-served `/pulse` mishandling
  the 401, or a redirect bounce). With R4 the gate won't fire post-signup; still eliminate any reload loop
  so a later genuine gate can't loop. (Investigate during implementation; fix root cause.)
- **C4** `OnboardingPage.tsx`: after `/api/onboarding` success, land on `/pulse` cleanly (device now trusted).

### Workstream D — Tests (Jest)
- otpService escalation: 3 sends ok → 4th blocked < 1 min → ok after; ladder steps 5m/15m/1h; reset after verify.
- onboarding: success path sets trusted device (no gate on next authed call); 2FA-exempt unaffected.
- Regression: existing otp send/verify/trust-device + onboarding tests stay green.

## Task plan

| ID | Workstream | Files | Notes |
|----|-----------|-------|-------|
| T1 | B1 | backend/src/services/otpService.js (+ migration 124 if needed) | Escalation ladder, reset-on-verify, 429+retry_after |
| T2 | B2 | backend/src/routes/onboarding.js | Trust device + set albusto_td on onboarding success |
| T3 | C1/C2/C3/C4 | frontend/src/components/auth/TwoFactorGate.tsx, services/twoFactorGate.ts, pages/auth/OnboardingPage.tsx, /pulse routing | 429 handling, dedupe, kill reload loop |
| T4 | A1–A4 | keycloak-themes/albusto/login/{info.ftl,login-verify-email.ftl,messages/messages_en.properties,theme.properties} | De-dupe, auto-proceed, branded success |
| T5 | D | tests/* | otpService + onboarding tests |
| T6 | deploy | — | backend rebuild + migration apply + KC force-recreate; smoke |

Priority: **T1, T2, T3 are P0** (live SMS/loop). T4 (theme) is P1. T6 deploy after review.
