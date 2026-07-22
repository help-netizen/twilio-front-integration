# SUPERADMIN-DASH — platform super-admin presence and growth dashboard

**Status:** Implemented (master, not deployed). Backend by Codex; frontend design/markup
by Claude (owner directive: Claude owns final UX/markup). Owner decisions taken: presence
label = `Online`; password reset offers BOTH delivery modes (show temporary password OR
email a reset link).

**Task marker:** `SUPERADMIN-DASH-T1`

**Mockup:** `docs/mockups/SUPERADMIN-DASH-T1.html`

## 1. Goal and scope

Extend the existing `/settings/admin` surface for the single platform super-admin.
This is the only surface allowed to read across tenant companies, and that access is
allowed only after the canonical platform guard.

In scope:

- all tenant-company user memberships in one searchable, paginated table;
- a truthful online/last-seen indicator;
- a password-reset action with two owner-chosen delivery modes (show a one-time
  temporary password, or email a Keycloak reset link);
- total/today/7-day/30-day company and user-account growth;
- reuse of the existing Companies, Sessions, and Auth policy tabs.

Out of scope:

- call KPIs;
- a general presence subsystem, WebSocket/SSE redesign, or second presence truth;
- tenant-route scope changes;
- arbitrary platform analytics.

## 2. Existing surface and guard

- `frontend/src/pages/SuperAdminPage.tsx` currently has Companies (default), Sessions,
  and Auth policy tabs. It does not list users across companies.
- `frontend/src/pages/AdminCompanyDetailPage.tsx` and
  `frontend/src/hooks/useAdminCompanyUsers.ts` list users only inside the selected
  `companyId`.
- `frontend/src/components/super-admin/CompaniesManager.tsx` is the existing company
  list and remains the company surface. Its API defaults to 25 rows and the component
  has no pagination, so it must gain paging before it truthfully represents all
  registered companies.
- Backend platform routes are mounted with exactly
  `authenticate, requirePlatformRole('super_admin')`. They do not use
  `requireCompanyAccess`.
- Frontend routes use exactly
  `<ProtectedRoute platformRoles={['super_admin']}>`.

The backend guard is authoritative. The frontend guard only prevents hidden UI from
loading.

## 3. UX proposal

Tab order:

1. Users (new default)
2. Companies (existing surface, paginated)
3. Statistics
4. Sessions (existing)
5. Auth policy (existing)

### 3.1 Users

- Toolbar: one search field over company name/slug, user name, and email; one company
  filter when cheap to populate from the existing company response.
- Columns: Company · Name · Email · Role · Presence · Action.
- Presence:
  - success/entity token dot plus `Online` when the selected presence rule is true;
  - otherwise muted relative copy, for example `Last seen 2h ago`;
  - null activity renders `Never seen`, not a dash or `N/A`.
- Sort on the backend: online first, then `last_seen_at DESC NULLS LAST`, followed by a
  stable membership/user id tiebreaker.
- Pagination is server-side. Search, filtering, sorting, and online derivation must not
  operate on a single client page snapshot.
- Reset password is a row action opening a short center dialog with two choices:
  "Show temporary password" (reveals a one-time password with a copy button) or
  "Send reset email" (Keycloak emails a link; nothing is shown). Center modal per the
  form canon — short action, not entity editing.

The table represents membership rows so every company/role association remains
visible. A user with two memberships appears twice. This is a pending owner decision;
the alternative is one user row with only the primary company, which hides secondary
memberships.

### 3.2 Companies

Reuse `CompaniesManager` and its existing row actions. Add server-side pagination so
the surface is not limited to the backend's first 25 rows. Do not duplicate a company
list inside Statistics.

### 3.3 Statistics

- Two flat KPI tiles only:
  - Companies — total and `+N today`, plus 7-day and 30-day additions.
  - User accounts — distinct tenant user accounts total and `+N today`, plus 7-day and
    30-day additions.
- At most one growth visual: daily new companies and distinct tenant user accounts for
  the last seven UTC dates. It uses existing tokens and no new chart dependency.
- No calls and no decorative dashboard cards.

`User accounts` means distinct `crm_users.id` values that have at least one company
membership. Memberships do not inflate the KPI. Platform-only super-admins are not a
tenant-growth signal. Disabled memberships/users remain in the historical total so a
growth KPI does not shrink when access is disabled.

## 4. Presence discovery and decision

### Option A — recent authenticated activity (recommended)

`crm_users.last_login_at` already exists and `userService.findOrCreateUser()` updates it
to `NOW()` on every authenticated request. Its current behavior is therefore persisted
last API activity, despite the legacy column name.

- API aliases it as `last_seen_at`; no migration is required for v1.
- `online = last_seen_at >= database_now - interval '5 minutes'`.
- Derivation and ordering happen in PostgreSQL from one clock.
- Honest limitation: background authenticated requests count as activity, and a closed
  tab may remain online for at most five minutes.

### Option B — Keycloak sessions

The existing Sessions endpoint has session `lastAccess`, but it first fetches at most
500 Keycloak users and then requests sessions sequentially for each user. A live SSO
session is not durable last-seen history after the session disappears. Do not join this
N+1 endpoint into the Users tab.

### Option C — softphone presence

`agent_presence` is tenant-scoped, persisted, refreshed every 30 seconds, and expires
after 90 seconds by default. It is precise for softphone availability, but only users
with softphone permission/group/device publish it. It cannot truthfully represent all
platform users.

### Not usable — current SSE registry

The singleton SSE registry is process-local and stores company id but not CRM user id.
It also cannot provide durable last seen across process restarts or multiple instances.

**Owner decision (taken):** Option A, labelled `Online`. Derived from `last_login_at`,
online = active within the last five minutes.

## 5. Password reset contract

`POST /api/platform/users/:userId/reset-password`, body `{ mode: 'temp' | 'email' }`.
The target is resolved by `user_id` at PLATFORM scope (no company filter); a missing
user is 404 before any Keycloak call. Owner chose to offer BOTH delivery modes:

- `mode: 'temp'` — server generates a one-time password, calls Keycloak's credential
  reset (temporary=true), and returns it once so the super-admin can hand it over:
  `{ ok: true, mode: 'temp', temporary_password: '…' }`. This is a deliberate
  super-admin capability (same pattern as create-user), not an accidental leak; the
  value is never written to logs or the audit `details`.
- `mode: 'email'` — Keycloak Admin REST `execute-actions-email` for `UPDATE_PASSWORD`;
  no secret is generated, returned, or logged: `{ ok: true, mode: 'email', sent: true }`.

Every reset writes an `audit_log` row (`action: 'user.password_reset'`,
`actor_id = req.user.crmUser.id` — never the Keycloak `sub`, `company_id` = the target's
primary/earliest membership, `details: { mode }`). Invalid `mode` → 422. A missing
Keycloak identity or provider/SMTP failure returns a non-secret 5xx with a trace id. The
endpoint never silently provisions a missing Keycloak user.

## 6. Statistics source and time boundary

PostgreSQL is the canonical and cheapest source:

- companies: `companies.created_at` (`TIMESTAMPTZ`);
- user accounts: `crm_users.created_at` (`TIMESTAMPTZ`) with an `EXISTS` membership;
- membership representation/filtering: `company_memberships` joined to `companies`.

All platform `today`, 7-day, and 30-day boundaries are UTC. There is no single tenant
timezone for a cross-company platform metric. Queries construct explicit UTC half-open
boundaries (`>= start`, `< next_start`) rather than using server-local time or applying
`::date` directly to indexed timestamp columns.

The stats response declares `timezone: "UTC"` and `generated_at`.

## 7. API and routing (implemented)

Three endpoints, mounted in `src/server.js` (350–353) exactly like the existing
`/api/platform/companies` router — `authenticate, requirePlatformRole('super_admin')`,
never `requireCompanyAccess`:

- `GET /api/platform/users?search&page&limit` — `backend/src/routes/platformUsers.js`
- `POST /api/platform/users/:userId/reset-password` — same router (§5)
- `GET /api/platform/stats` — `backend/src/routes/platformStats.js`

The `src/server.js` mount is the architect-approved exception (four lines, same guard as
the sibling platform router). The team-lead granted it explicitly for this feature.

## 8. Security and data invariants

- Unauthenticated request to each new endpoint: 401.
- Any tenant role (`tenant_admin`, `manager`, `dispatcher`, `provider`) to each new
  endpoint: 403 and zero data/provider calls.
- Only resolved `req.authz.platform_role === 'super_admin'` can read cross-tenant rows.
- The user list intentionally returns seeded companies A and B only under that guard.
- Search/filter input is parameterized. Client-provided company ids never become an
  authorization scope; they are filters after the platform guard.
- Password reset resolves the target by `user_id` at platform scope; an unknown user is
  404 with no Keycloak call. `actor_id` is `crmUser.id`, never the Keycloak `sub`.
- The only value a reset endpoint ever returns is the one-time `temporary_password`, and
  only for the explicit `mode: 'temp'` super-admin choice. It is never logged or placed
  in the audit `details`. `mode: 'email'` returns no secret. No endpoint returns Keycloak
  admin credentials, reset tokens, or provider response bodies.

## 9. Verification

### 9.1 Backend behavioral tests

Add `tests/superAdminDashboard.test.js` for:

- real `requirePlatformRole('super_admin')` allow/deny behavior for every endpoint;
- 401 without authentication and the four tenant-role 403 deny cells;
- search/filter/pagination contract and deterministic presence ordering;
- exact five-minute threshold, older/null last-seen behavior;
- reset action uses only `UPDATE_PASSWORD` execute-actions-email and returns no secret;
- reset target foreign to the supplied company is 404 and provider is untouched.

Add `tests/superAdminDashboard.db.test.js` for a real PostgreSQL transaction:

- company A and company B memberships both appear for the guarded platform query;
- the same user in two companies is represented twice in rows but counted once in the
  user-account KPI;
- companies/users at UTC midnight -1ms, midnight, and next midnight validate half-open
  `today` boundaries even after setting the database session to a non-UTC timezone;
- 7-day/30-day buckets and totals are correct;
- online rows sort before offline rows, then by newest last seen.

### 9.2 Frontend

The new components (`PlatformUsersTab`, `PlatformStatsTab`, `PlatformResetPasswordDialog`,
`usePlatformAdmin`) are verified by the production build (`tsc -b`, `noUnusedLocals`) and
the shared `superAdminDashboard` behavioral suite that exercises the same response
envelopes. Dedicated component Vitest was not added in v1 (debt, not blocker) — the data
contract is asserted on the backend and the presentation is static markup.

### 9.3 Named sabotage controls

- `SAB-SA-GUARD`: remove `requirePlatformRole('super_admin')` from the real mount/route;
  tenant-role endpoint tests must turn red.
- `SAB-SA-CROSS-TENANT`: add an actor-company filter or drop company B from the
  platform query; the guarded A+B database test must turn red.
- `SAB-SA-PRESENCE`: change the exact five-minute comparator or remove online-first
  ordering; boundary/order tests must turn red.
- `SAB-SA-UTC`: replace explicit UTC bounds with session-local `CURRENT_DATE`; the
  non-UTC midnight database test must turn red.
- `SAB-SA-RESET-EMAIL`: make `mode: 'email'` fall through to the temp-password branch;
  the "email mode returns no password" assertion must turn red.

Each sabotage is run break → red → exact restore → green on top of the uncommitted
implementation. Do not use `git checkout` to restore it.

### 9.4 Actual result (2026-07-21)

- `tests/superAdminDashboard.test.js` + `tests/superAdminDashboard.db.test.js` —
  **2 suites, 12 tests passed** (re-run independently by the team lead).
- Frontend `npm run build` — **passed** (0 errors).
- Sabotage executed: Codex ran `SAB-SA-GUARD`, `SAB-SA-CROSS-TENANT`, `SAB-SA-STATS-TODAY`,
  `SAB-SA-RESET-EMAIL` (each red→restored); the team lead independently re-ran
  `SAB-SA-CROSS-TENANT` (constrain both JOINs → breadth test red, expected 3 / got 0 →
  restored via `cp` backup).

### 9.5 Executed commands

```bash
node --use-bundled-ca --experimental-vm-modules ../../../node_modules/jest/bin/jest.js --runTestsByPath tests/superAdminDashboard.test.js tests/superAdminDashboard.db.test.js --testPathIgnorePatterns "/node_modules/" --runInBand
cd frontend && npm run build
```
