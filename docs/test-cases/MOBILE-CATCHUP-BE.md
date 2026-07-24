# Verification — MOBILE-CATCHUP-BE

**Date:** 2026-07-23  
**Target:** main CRM backend only  
**Database policy:** every real-PostgreSQL test runs inside `BEGIN`/`ROLLBACK`

## Automated coverage

| Requirement | Suite | Evidence |
|---|---|---|
| Untrusted verified-phone user is blocked on `/api/sync/jobs` | `nativeTrustedDevice.test.js` | 401 `PHONE_VERIFICATION_REQUIRED` |
| Native header and web cookie are alternative trust transports | `nativeTrustedDevice.test.js` | header 200; cookie 200; bad header cannot override valid cookie |
| Native exchange contract | `nativeTrustedDevice.test.js` | Bearer + OTP + device id; no-store; no cookie; exact response; wrong-phone and validation failures |
| Hash at rest and user binding | `otpTrustedDeviceStorage.test.js`, `mobileCatchupBackend.db.test.js` | raw credential differs from stored 64-char hash; same user passes; another user fails |
| MCP isolation / mobile regression | `keycloakAuthMcpIsolation.test.js` | MCP azp/client_id 401; `crm-web` and `crm-mobile` 200 |
| Provider route-local gate and projection | `contactsProviderSearch.test.js` | provider assigned-only compact projection; office full response unchanged |
| R-matrix deny cells | `contactsProviderSearch.test.js` | no permission, company-wide provider scope, and provider list-without-search all 403 with zero SQL |
| T-own/T-foreign/T-blast | `mobileCatchupBackend.db.test.js` | own assigned contact only; foreign empty/404; same phone in two tenants; tenant B byte-identical |
| Live job name and rename delta | `syncJobs.test.js`, `mobileCatchupBackend.db.test.js` | same-company join; effective cursor; public `job.updated_at` unchanged; list/detail/search agree |
| Existing pagination/provider regressions | existing contacts/jobs suites | existing list, cursor, facets, and provider-scope suites remain green |

## Executed commands

Initial focused route/service diagnostic:

```sh
node --use-bundled-ca --experimental-vm-modules ../../../node_modules/jest/bin/jest.js --runTestsByPath tests/nativeTrustedDevice.test.js tests/otpTrustedDeviceStorage.test.js tests/contactsProviderSearch.test.js tests/keycloakAuthMcpIsolation.test.js tests/syncJobs.test.js tests/contactsListPagination.test.js tests/jobsListPagination.test.js tests/jobsProviderScope.test.js --testPathIgnorePatterns "/node_modules/" --runInBand
```

Result: all 8 suites and 96 assertions passed. The sandbox-denied first attempt
(`listen EPERM`) was rerun with localhost permission. The diagnostic runner
retained an existing open handle after printing its green summary and was
terminated; it is not the final release gate below.

Real PostgreSQL:

```sh
DOTENV_CONFIG_PATH=../../../.env node --use-bundled-ca --require ../../../node_modules/dotenv/config --experimental-vm-modules ../../../node_modules/jest/bin/jest.js --runTestsByPath tests/mobileCatchupBackend.db.test.js --testPathIgnorePatterns "/node_modules/" --runInBand --forceExit
```

Result: 1 suite, 2 tests passed; all rows rolled back.

Final affected-backend regression:

```sh
DOTENV_CONFIG_PATH=../../../.env node --use-bundled-ca --require ../../../node_modules/dotenv/config --experimental-vm-modules ../../../node_modules/jest/bin/jest.js --runTestsByPath tests/nativeTrustedDevice.test.js tests/otpTrustedDeviceStorage.test.js tests/contactsProviderSearch.test.js tests/keycloakAuthMcpIsolation.test.js tests/syncJobs.test.js tests/contactsListPagination.test.js tests/jobsListPagination.test.js tests/jobsProviderScope.test.js tests/otpService.test.js tests/keycloakAuth.test.js tests/onboardLoopFix.db.test.js tests/jobsService.test.js tests/contactsPulseTenantIsolation.test.js tests/jobsRbacGates.test.js tests/mobileCatchupBackend.db.test.js --testPathIgnorePatterns "/node_modules/" --runInBand --forceExit
```

Result: 15 suites, 178 tests passed, including both rollback-only PostgreSQL
suites. `--forceExit` is intentional because imported legacy route dependencies
retain a known open handle after Jest has completed; no process remains.

## Sabotage controls

All three controls were executed as break → red → exact restoration:

- `SAB-NATIVE-HEADER` — disable the `x-albusto-device` read; header trust test fails.
- `SAB-CONTACT-TENANT` — replace the contacts equality predicate with a
  non-scoping typed predicate; real-DB T-own receives the foreign tenant row.
- `SAB-SYNC-CONTACT-CLOCK` — reduce the effective cursor clock to
  `j.updated_at`; contact-only rename delta fails.

## Deferred mobile verification

Claude/mobile owner must verify in iOS Simulator:

1. Keychain survives cold restart and supplies `X-Albusto-Device`.
2. A stale/expired credential triggers OTP once and is atomically replaced.
3. Provider contact results consume `{id,name,phone,email}`, not the previous
   full contacts shape.
4. Contact rename appears after delta sync without changing the displayed job
   update timestamp.
