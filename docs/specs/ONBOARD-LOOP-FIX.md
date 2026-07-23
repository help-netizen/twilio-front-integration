# ONBOARD-LOOP-FIX — post-onboarding and super-admin redirect loop

**Status:** Fixed (frontend). Backend reproduced — no server-code change needed.
**Incident date:** 2026-07-23
**Area:** Authentication context, onboarding routing, SMS 2FA

## Scope and ownership

- Backend resolver, middleware reproduction, and Jest regressions: Codex (no server
  production-code change was required — the loop is entirely frontend state/race).
- `App.tsx` `OnboardingGate` + `AuthProvider`: Claude (frontend owner).

## Frontend fix applied (Claude)

`AuthProvider`:
- `authzReady: boolean` — flips true only after a SUCCESSFUL `/api/auth/me`; a failed
  load never becomes a "loaded empty" context. Retries the initial load once.
- `authzGenRef` monotonic generation on every `fetchAuthzContext` — a slow STALE
  pre-onboarding response (company=null) is dropped if a newer `refreshAuthz()` (the
  post-onboarding company) already resolved. **This is the root-B fix.**

`OnboardingGate` (App.tsx) redirects to `/onboarding` ONLY when
`!loading && authenticated && authzReady && platform_role === 'none' && !company`:
- `platform_role !== 'none'` (super_admin) never loops — company is null by design (root A).
- `authzReady` gate — never redirect during load or after a failed load.
- `OnboardingPage` already `await refreshAuthz()` before navigating (kept).

Verification: frontend `npm run build` clean; backend `tests/onboardLoopFix.db.test.js`
+ `tests/keycloakAuth.test.js` → 2 suites / 30 tests green (re-run by the team lead).

## Root A — platform-only super admin

`authorizationService.resolveAuthzContext` intentionally returns:

```text
scope: platform
platform_role: super_admin
company: null
membership: null
```

That is the platform/tenant separation contract, not missing onboarding data.
`GET /api/auth/me` serializes `authz.company || null` and therefore returns 200
for this context. Platform routes are mounted behind
`requirePlatformRole('super_admin')`, which reads `platform_role` and only uses
optional access for company audit context. Tenant middleware checks platform
scope before dereferencing company and deliberately returns
`403 PLATFORM_SCOPE_ONLY`.

Backend audit result: no authenticated platform or auth-context route redirects
or dereferences `req.authz.company` without a preceding tenant-context check.
The super-admin loop is therefore a frontend classification error: null company
does not imply onboarding when `platform_role !== 'none'`.

## Root B — real PostgreSQL reproduction

Harness: `tests/onboardLoopFix.db.test.js`. It inserts, inside a rolled-back
transaction:

- one active company;
- one active CRM user with `platform_role='none'`,
  `phone_verified_at=now()`;
- one active primary `tenant_admin` membership;
- zero trusted-device rows.

It uses a Bearer request through the real `authenticate` middleware, real
authorization resolver and membership/role queries, real 2FA gate, and real
auth router. Only Keycloak signature verification and the user-upsert boundary
are mocked.

Result:

- `GET /api/auth/me` returns **200 with the seeded company and membership**.
- `GET /api/company-probe`, a non-exempt tenant route using the same Bearer
  identity and no trusted-device cookie, returns
  **401 `PHONE_VERIFICATION_REQUIRED`**.

The decisive code path is:

1. `src/server.js:344` mounts `/api/auth` with `authenticate`, without
   `requireCompanyAccess`.
2. `backend/src/middleware/keycloakAuth.js:120-130` syncs the CRM user and
   resolves `req.authz`.
3. `backend/src/services/authorizationService.js:75-129` loads the active
   membership and returns its company.
4. `backend/src/db/membershipQueries.js:13-28` joins the company and filters
   `m.status='active'`.
5. `backend/src/middleware/keycloakAuth.js:136-156` evaluates SMS 2FA after
   authz resolution. At line 142, `/^\/api\/auth\//` exempts the original URL
   before any trusted-device lookup or 401.
6. `backend/src/routes/auth.js:4-21` returns the resolved company.

No Root-B backend fix is required: membership resolution and 2FA exemption
ordering are correct in the current backend.

## Regression contract

`tests/onboardLoopFix.db.test.js` pins:

- `SAB-A-RESOLVER`: super admin resolves to platform scope, null company, and
  null membership without a membership query or throw.
- `SAB-A-ME`: super admin receives 200/no redirect from `/api/auth/me`.
- `SAB-B-MEMBERSHIP`: an active tenant membership appears in `/api/auth/me`.
- `SAB-B-EXEMPT`: an untrusted verified-phone user still receives 200 from the
  exempt `/api/auth/me`.
- `SAB-B-GATE`: the same user receives
  `401 PHONE_VERIFICATION_REQUIRED` from a non-exempt route.

Minimum sabotage mutations:

- A resolver: change the super-admin return scope from `platform` to `tenant`.
- A `/me`: dereference `authz.company.id` in the `/me` response.
- B membership: change `m.status='active'` to `m.status='inactive'`.
- B exemption: make the `/api/auth/` exemption regex not match.
- B enforcement: exempt the non-auth `/api/company-probe` path.

Each mutation must make its named test red and be reversed exactly before final
verification.

## Frontend handoff

The frontend must model authz loading as at least three distinct states:
`loading`, `succeeded`, and `failed`.

- `OnboardingGate` must not redirect while authz is loading or after authz load
  failed.
- Only a **successfully loaded** context with both `company === null` and
  `platform_role === 'none'` may redirect to onboarding.
- A successfully loaded context with `platform_role !== 'none'` is a platform
  identity and must bypass onboarding even when company is null.
- `AuthProvider` must not convert a failed/non-2xx `/api/auth/me` request into a
  successful empty `{ company:null, platform_role:'none' }` context. Surface a
  retry/error state or retain the last successful context.
- Prevent an older init request from overwriting a newer post-onboarding
  `refreshAuthz()` result (single-flight or request-generation guard).
- Keep navigation after company creation behind a successful `refreshAuthz()`;
  do not navigate while the provider still exposes the pre-company snapshot.

## Verification

- `node --use-bundled-ca --experimental-vm-modules ../../../node_modules/jest/bin/jest.js --runTestsByPath tests/onboardLoopFix.db.test.js tests/keycloakAuth.test.js --testPathIgnorePatterns "/node_modules/" --runInBand`
  → 2 suites, 30 tests passed (including 3 incident regressions against real
  PostgreSQL).
- `node --use-bundled-ca --experimental-vm-modules ../../../node_modules/jest/bin/jest.js --runTestsByPath tests/onboardLoopFix.db.test.js --testPathIgnorePatterns "/node_modules/" --runInBand -t "SAB-A-RESOLVER"`
  with `scope:'platform'` changed to `scope:'tenant'`
  → expected red: 1 failed, 2 skipped; exact edit restored.
- `node --use-bundled-ca --experimental-vm-modules ../../../node_modules/jest/bin/jest.js --runTestsByPath tests/onboardLoopFix.db.test.js --testPathIgnorePatterns "/node_modules/" --runInBand -t "SAB-A-ME"`
  with `/me` changed to dereference `authz.company.id`
  → expected red: 1 failed, 2 skipped; exact edit restored.
- `node --use-bundled-ca --experimental-vm-modules ../../../node_modules/jest/bin/jest.js --runTestsByPath tests/onboardLoopFix.db.test.js --testPathIgnorePatterns "/node_modules/" --runInBand -t "SAB-B-MEMBERSHIP"`
  with the active-membership predicate changed to `status='inactive'`
  → expected red: 1 failed, 2 skipped; exact edit restored.
- `node --use-bundled-ca --experimental-vm-modules ../../../node_modules/jest/bin/jest.js --runTestsByPath tests/onboardLoopFix.db.test.js --testPathIgnorePatterns "/node_modules/" --runInBand -t "SAB-B-EXEMPT"`
  with the `/api/auth/` exemption made non-matching
  → expected red: 1 failed, 2 skipped; exact edit restored.
- `node --use-bundled-ca --experimental-vm-modules ../../../node_modules/jest/bin/jest.js --runTestsByPath tests/onboardLoopFix.db.test.js --testPathIgnorePatterns "/node_modules/" --runInBand -t "SAB-B-GATE"`
  with the non-exempt probe temporarily added to the exemption list
  → expected red: 1 failed, 2 skipped; exact edit restored.
