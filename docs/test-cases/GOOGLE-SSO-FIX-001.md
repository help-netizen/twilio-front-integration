# Test Cases — GOOGLE-SSO-FIX-001

Frontend has no automated harness (RTL deferred) → FE cases are manual/dev-preview.
Keycloak/script cases are manual against a running Keycloak.

## P0

| ID | Type | Scenario | Expected |
|----|------|----------|----------|
| TC-01 | Manual (FE) | Click "Continue with Google" on `/signup` | No console `TypeError`; browser redirects to `accounts.google.com` with `code_challenge` present |
| TC-02 | Manual (E2E) | Complete Google auth for a NEW email | Returns to `/onboarding` authenticated; `crm_users` row has `full_name`+`email` from Google |
| TC-03 | Manual (E2E) | Google auth for an email that already has a password account | Auto-links (no manual-link prompt); single user; lands authenticated |
| TC-04 | Manual (KC) | Run `scripts/setup-google-idp.sh` twice against a test realm | Idempotent: 2nd run creates nothing new; IdP+mappers+flow present |
| TC-05 | Build | `cd frontend && tsc -b` | Exit 0 (strict; no unused `getKeycloak` import) |

## P1

| ID | Type | Scenario | Expected |
|----|------|----------|----------|
| TC-06 | Manual (FE) | Sign-in page (Keycloak `login.ftl`) with IdP enabled | "Continue with Google" button renders above password form + "or with email" divider |
| TC-07 | Manual (E2E) | Google user finishes `/onboarding` | Phone → SMS OTP step still required; company created; lands on `/pulse` |
| TC-08 | Manual (KC) | Fresh `--import-realm` of `realm-export.json` with `GOOGLE_IDP_CLIENT_ID/SECRET` set | `google` IdP + given/family/email mappers + "first broker login auto link" flow all present |
| TC-09 | Manual (KC) | Import with `GOOGLE_IDP_*` UNSET (dev) | Import still succeeds (empty-string defaults `${…:}`); realm boots |
| TC-10 | Manual (config) | Google Cloud OAuth client missing broker redirect URI | Google shows `redirect_uri_mismatch` → documents the required `…/broker/google/endpoint` URI |

## Regression
- TC-11: Email/password signup on `/signup` still works (unchanged `POST /api/public/signup`).
- TC-12: Existing password sign-in on `login.ftl` unaffected by the added social block.
- TC-13: App pages still init Keycloak once (no double-init) — `/pulse` loads normally.
