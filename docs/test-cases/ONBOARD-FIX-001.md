# Test Cases — ONBOARD-FIX-001

Backend security cases are Jest (`tests/keycloakAuth.test.js`). Frontend/theme are manual/dev-preview (no FE harness).

## P0 — tenant isolation (SEC)

| ID | Type | Scenario | Expected |
|----|------|----------|----------|
| TC-SEC-1 | Jest ✅ | `requireCompanyAccess` with `authz.company=null` + `user.company_id=seed` | 403 `TENANT_CONTEXT_REQUIRED`; `req.companyFilter` never set; `next` not called |
| TC-SEC-2 | Jest ✅ | `requireCompanyAccess` with `authz.company.id='company-A'` (shadow=seed) | `next()`; `companyFilter={company_id:'company-A'}` (shadow ignored) |
| TC-SEC-3 | Jest ✅ | `requireCompanyAccess` platform-only (super_admin) | 403 `PLATFORM_SCOPE_ONLY` |
| TC-SEC-4 | Jest ✅ | `authenticate` dev bypass while `NODE_ENV=production` | 500 `AUTH_MISCONFIGURED`; no dev user; no `companyFilter` |
| TC-SEC-5 | Manual (mig) | Run migration 140 on a DB with backfilled shadows | `crm_users.company_id` NULLed where no active membership; NOTICE logs count; re-run = 0 |
| TC-SEC-DB | Manual (prod) | Query prod: users with `company_id=seed` AND no active membership; and the row for `help@abchomes-appliance.com` (crm_users.company_id + any active membership) | Confirms exposure scope + whether the reporter's case was a genuine leak or a legit membership |

## P1 — onboarding access (A)

| ID | Type | Scenario | Expected |
|----|------|----------|----------|
| TC-A-1 | Manual (E2E) | New user completes onboarding (company + location + submit) | Lands on `/pulse` of THEIR new company; no flicker/redirect loop; no "You don't have access here" |
| TC-A-2 | Manual (E2E) | User who already belongs to a company reaches onboarding, submits | `ALREADY_ONBOARDED` → authz refreshed → lands on `/pulse` of the company they belong to |
| TC-A-3 | Build | `cd frontend && tsc -b` | exit 0 |

## P1 — phone mask (B)

| ID | Type | Scenario | Expected |
|----|------|----------|----------|
| TC-B-1 | Manual | Type digits in "Mobile phone" | Masks to `(617) 555-0142` as typed |
| TC-B-2 | Manual/Network | Send + verify OTP | Requests carry E.164 (`+1…`); code sends & verifies against the same normalized number |

## P2 — theme audit (C)

| ID | Type | Scenario | Expected |
|----|------|----------|----------|
| TC-C-1 | Manual | Hit each themed page (login-otp, select-authenticator, login-reset-password, login-update-password, error, idp-review-user-profile) | Renders in the albusto shell (branded), not bare Keycloak; forms submit correctly |
| TC-C-2 | Build | Keycloak loads theme after `up -d --force-recreate keycloak` | No FreeMarker parse errors; pages render |

## Regression
- TC-R-1: Existing users WITH a membership still access `/pulse` etc. (authz.company set → allowed).
- TC-R-2: `requireRole` / existing keycloakAuth tests stay green (27/27).
- TC-R-3: Dev mode still works locally (`NODE_ENV` unset/development → dev bypass active).
