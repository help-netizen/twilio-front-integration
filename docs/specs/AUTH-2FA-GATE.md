# AUTH-2FA-GATE — Spec

## Problem
FEATURE_SMS_2FA on + user has `phone_verified_at` + no trusted-device cookie
(expired after 30d, or new device) → backend returns `401
PHONE_VERIFICATION_REQUIRED` on every non-exempt API. The frontend had no
handler → raw "HTTP 401" → full app lockout, no way to re-verify.

## Behaviour
- `authedFetch` (services/apiClient.ts): on 401 whose body `code` ===
  `PHONE_VERIFICATION_REQUIRED` → `requireTwoFactor()` (await) → retry once.
- `twoFactorGate.ts`: coordinator; concurrent 401s share ONE in-flight
  verification (dedupe). `requireTwoFactor` / `completeTwoFactor` / `cancel` /
  `subscribe`.
- `TwoFactorGate.tsx` (mounted at App root): overlay "Confirm it's you".
  Auto-sends a code to the user's STORED phone via POST /api/auth/otp/send
  (shows masked `phone_hint`, no phone re-entry). 6-digit input + resend timer.
  On 6 digits → POST /api/auth/otp/verify → POST /api/auth/trust-device (30-day
  `albusto_td` cookie) → `completeTwoFactor()` → waiters retry → app continues.

## Phone reuse (owner requirement)
One phone may back MANY accounts — identity is the email; trusted-device rows are
keyed by `user.id`, not phone. Verified: NO unique constraint on any phone
column, NO "phone in use" check in signup/otp/onboarding. Works as-is (useful
for non-US shared numbers).

## Backend
Unchanged — authDevice.js (/otp/send, /otp/verify, /trust-device) already exists,
2FA-exempt on /api/auth/*.

## Validation
tsc clean + browser E2E on prod (qa-test@albusto.com): gate triggered, auto-sent
to +1••••••0320, resend, code 409751 → verified → device trusted → billing page
loaded seamlessly (no re-login); next page no re-prompt (cookie persists).
