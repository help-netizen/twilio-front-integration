# LIST-VISIBILITY-FAILOPEN-001 — missing visibility fails closed

**Status:** IMPLEMENTED; read-only production scope probe pending  
**Backlog:** OB-15  
**Date:** 2026-07-20  
**Type:** security defect (within-company role visibility)  
**Migrations:** none pending production evidence

## Problem

Two broken-context branches widened role-level visibility inside an otherwise
correct company boundary:

1. `getProviderScope` treated a missing or unknown `job_visibility` as `all`.
2. Tasks list/count passed a missing actor as a falsy `scopeOwnerId`, which the
   shared query builder interpreted as “no ownership predicate.”

The sibling audit also found the same fail-open shape in `my_open_deals` and in
portal document-list scope handling. This change closes all four. It does not
change how `company_id` is sourced or applied.

## Requirements

- [x] Only the exact `job_visibility = 'all'` value grants company-wide record
  visibility. Missing, JSON null, malformed, and unknown values resolve to
  `assigned_only`.
- [x] A non-manager Tasks caller without `req.user.crmUser.id` is rejected with
  `500 INVALID_AUTH_CONTEXT` before list/count SQL.
- [x] A present but falsy `scopeOwnerId` independently adds `FALSE` in the shared
  Tasks predicate; it never removes the ownership restriction.
- [x] `my_open_deals` always derives its owner from the authenticated actor. A
  caller-supplied owner is only accepted when it matches that actor.
- [x] Portal document listing reaches the full-contact query only for exact
  `scope = 'full'`; unknown, incomplete, or mismatched narrow scopes return no
  documents.
- [x] Company predicates, company-id sources, permissions, and role seeds remain
  unchanged.
- [x] Regression tests cover every changed fail-closed branch and identify the
  minimum sabotage that makes each test red.
- [x] Production data risk is recorded without guessing at a backfill.

## Decisions taken

### D1 — provider visibility is an allowlist

`all` is the sole widening value. Every other value takes the `assigned_only`
branch. Testing `visibility !== 'assigned_only'` is forbidden because future or
corrupt values would become company-wide.

### D2 — broken Tasks actor context returns 500, not an empty page or 403

The selected fork is rejection with `500 INVALID_AUTH_CONTEXT` for both
`GET /api/tasks` and `GET /api/tasks/count` when a caller has `tasks.view`, lacks
`tasks.manage`, and has no `crmUser.id`.

Rationale: the permission check succeeded, so `403` would misdescribe the
failure as an authorization decision. Returning an empty page would hide a
server authentication-context invariant violation. A 500 is observable and
actionable. The query builder still adds `FALSE` for a present-but-empty owner
scope as defense in depth for non-route callers.

### D3 — no speculative `job_visibility` backfill

Migration 050 intentionally seeds different values by role. Rewriting missing
or corrupt production values without measuring them could grant or remove
customer access incorrectly. The runtime security fix ships independently; a
data migration is conditional on the read-only probe in “Data shape and rollout
risk.”

### D4 — sibling fixes stay at the authorization boundary

`my_open_deals` now requires the actor it claims to represent. Portal document
queries now explicitly distinguish full from narrow scope. Portal token scope
names and frontend request shapes are not changed in this task.

## Tenancy & Roles

| surface (route/worker/webhook/SSE/aggregate) | scoped by | key used | permission | roles ✓/✗ | blast-radius risk |
|---|---|---|---|---|---|
| Provider-scoped Jobs family (`GET /api/jobs`, `/api/jobs/:id` and scoped job actions) | `req.companyFilter.company_id` plus `getProviderScope(req)` | job id / assignee mirror | route-specific `jobs.*`, `messages.send`, or payment key | tenant_admin/manager/dispatcher with explicit `all` ✓ company-wide; provider ✓ assigned/✗ unassigned; any missing/unknown scope ✓ assigned/✗ unassigned | Company predicates are unchanged; a corrupt role scope can only narrow after this fix. |
| Provider-scoped Contacts family (`GET /api/contacts`, `/api/contacts/:id` and scoped contact actions) | `req.companyFilter.company_id` plus assigned-job reachability | contact id / assigned job mirror | `contacts.view` or `contacts.edit` | office roles ✓ per permission; provider default ✗, override holder ✓ assigned-contact/✗ other contact | Contact visibility inherits the same `job_visibility` helper; no natural key is used. |
| Provider-scoped Schedule, Calls, Pulse, Sync, Messaging detail, FSM-job, and job attachment reads/actions | `req.companyFilter.company_id` plus `getProviderScope(req)` | entity id/contact id and assignee mirror | existing `schedule.*`, `reports.calls.view`/`pulse.view`, `jobs.view`, messaging, FSM, or entity permission | explicit `all` holder ✓ company-wide; assigned-only holder ✓ own/✗ other; unresolved actor returns no rows/404 | Shared helper change narrows all consumers; their company filters and 404 behavior are untouched. |
| `GET /api/tasks` | `req.companyFilter.company_id`; owner from `req.user.crmUser.id` | task owner id | `tasks.view`; `tasks.manage` widens | tenant_admin/manager/dispatcher ✓ all by seeded manage; provider/view-only ✓ own/✗ others; missing actor → 500; no view → 403 | Query defense adds `FALSE` for an empty requested owner scope; cursor fingerprint records whether owner scope was applied. |
| `GET /api/tasks/count` | same shared Tasks predicate as list | task owner id | `tasks.view`; `tasks.manage` widens | same matrix as list; missing actor → 500 | Count cannot drift into the unowned company-wide branch. |
| `GET /api/crm/lists/my_open_deals` | route company id plus authenticated actor id | `crm_deals.owner_user_id` | `contacts.view` | permission holder ✓ own/✗ another owner; missing actor → 400; no permission → 403 | Caller-provided owner can no longer replace a missing actor. |
| Portal-session `GET /api/portal/documents` query | session token `company_id`, `contact_id`, scope and document tuple | document id + contact id | valid portal session; internal link minting retains `estimates.send`/`invoices.send` | exact full ✓ contact documents; matching estimate/invoice scope ✓ one document; unknown/incomplete/mismatch ✗ | Full-list SQL is reachable only through exact `full`; every SQL leg remains company/contact scoped. |

### Canon test contract

- `T-own`: existing allow controls prove own-company/own-record behavior for
  Jobs, Tasks, CRM lists, and portal documents.
- `T-foreign`: existing company-scoped route suites keep foreign ids at 404;
  this change does not alter those predicates or error translations.
- `T-blast`: none of the changed decisions resolves by phone, email, SID, or
  external id. Existing provider reachability joins pair entity ids with
  `company_id`; no mutation is added.
- `R-matrix`: existing route permission suites remain authoritative. New tests
  exercise the broken-context cells after their permissions have already
  allowed entry.
- Tenancy sabotage remains: removing a `company_id` guard must redden the
  existing tenant-safety/route suites. This task does not touch those guards.

## Sibling audit

### Genuine fail-open hits — fixed

| hit | verdict | reason |
|---|---|---|
| `backend/src/middleware/providerScope.js:16-23` | **fixed** | Missing/unknown `job_visibility` previously selected company-wide visibility; now only exact `all` widens. |
| `backend/src/routes/tasks.js:27-46,68-115` and `backend/src/db/tasksQueries.js:176-189` | **fixed** | Missing actor previously became falsy `scopeOwnerId`, and the query omitted ownership. Routes now reject; the query adds `FALSE`. |
| `backend/src/services/crmListsService.js:153-161` | **fixed** | Missing actor previously fell back to client `owner_user_id`, allowing another same-company owner on a “my” list. |
| `backend/src/db/portalQueries.js:170-202` | **fixed** | Non-full scope with an incomplete tuple previously fell through to the full-contact document query. Unknown/incomplete/mismatched scopes now return `[]`. |

### Related hits — already closed

| hit | verdict | reason |
|---|---|---|
| `backend/src/middleware/integrationScopes.js:1-23` | **already-closed** | Missing, malformed, or non-array scopes normalize to `[]`; the middleware returns 403. |
| `backend/src/routes/tasks.js:63-65` | **already-closed** | Missing actor makes non-manager ownership mutation checks falsy. |
| `backend/src/db/callsQueries.js:106-119` | **already-closed** | Assigned-only without user appends SQL `FALSE`. |
| `backend/src/db/scheduleQueries.js:49-50,77-85,195-203` | **already-closed** | Assigned-only without user adds `FALSE` to scoped union branches and excludes leads. |
| `backend/src/routes/pulse.js:30-39` | **already-closed** | Missing scoped user/contact returns false before the assigned-job reachability query. |
| `backend/src/routes/sync.js:121-153` | **already-closed** | Missing assigned user returns an explicit empty sync page. |
| `backend/src/routes/messaging.js:16-20` and `backend/src/db/conversationsQueries.js:71` | **already-closed** | Detail visibility calls the membership predicate; missing user returns false/404. |
| `backend/src/routes/noteAttachments.js:45-55` | **already-closed** | Missing scoped user returns false before attachment job access. |
| `backend/src/services/contactsService.js:112-126,231-236` | **already-closed** | Lists append `FALSE`; entity reads return null when assigned-only has no user. |
| `backend/src/services/jobsService.js:664-669,818-826` | **already-closed** | Entity reads return null and lists append `FALSE` when assigned-only has no user. |
| `backend/src/services/scheduleService.js:99-109,520-523` | **already-closed** | Missing user fails row checks and returns no route segments. |
| `backend/src/services/technicianAvailabilityService.js:176-179` and `backend/src/services/timeOffService.js:65-70` | **already-closed** | Missing user or provider bridge returns an empty list. |
| `backend/src/services/agentSkills/skills/getJobHistory.js:65-79` | **already-closed** | Unknown note shape is redacted; any explicit non-public visibility is treated as internal. |

### Permissive-looking hits — intentional

| hit | verdict | reason |
|---|---|---|
| `backend/src/routes/portal.js:55-73`, `backend/src/services/portalService.js:36-41,386-391`, `backend/src/db/portalQueries.js:26-32` | **intentional** | A missing portal-link scope is the existing full-link product default. Internal minting requires both send permissions for full; the public flow is feature-gated off by default; DB scope has a closed enum. Narrow-session reads now fail closed. |
| `backend/src/services/authorizationService.js:109,186` | **intentional** | The dispatcher fallback is legacy-role compatibility. `company_memberships.role` is NOT NULL and enum-constrained; `role_key` is enum-constrained, and migration 045 maps every legacy value. Unknown truthy role keys resolve to no role config/permissions. |
| `backend/src/services/authorizationService.js:249-253` and `frontend/src/auth/AuthProvider.tsx:82` | **intentional** | Explicit all/full scopes belong only to the development tenant-admin context; they are not missing-value defaults. |
| `backend/src/services/groupRouting.js:251-266`, `backend/src/routes/voice.js:92-93,266-275`, `backend/src/routes/userGroups.js:284-285` | **intentional** | Company-wide group lookup is reachable only behind explicit `_devMode`; normal missing users return empty/no match. |

Lexical `all` matches in `backend/src/db/emailQueries.js:131`,
`backend/src/routes/email.js:39`, `backend/src/routes/tasks.js:72`,
`backend/src/routes/jobs.js:184`,
`backend/src/services/zenbookerPaymentsSyncService.js:949`, and
`backend/src/services/jobsService.js:780,878` are data filters or tag-match
semantics, not authorization scope. They retain mandatory company/permission
guards and are not siblings.

## Data shape and rollout risk

Code/migration evidence:

- `company_role_scopes.scope_json` is NOT NULL, but no constraint requires a
  `job_visibility` row for every role config and no CHECK constrains its JSON
  value to `all|assigned_only` (`046_create_role_config_tables.sql`). JSON `null`
  is also legal.
- Membership scope overrides have the same unconstrained JSON shape
  (`047_create_override_tables.sql`).
- Migration 050 inserts role defaults with `ON CONFLICT DO NOTHING`; it does not
  repair missing or corrupt values.
- `ensureRoleConfigs` creates missing role config rows but does not seed their
  permission or scope children (`backend/src/db/roleQueries.js:128-159`).

Therefore a legitimate office-role row with a missing/corrupt value would become
assigned-only after rollout. No production data is available in this worktree.
Run this read-only probe:

```sql
SELECT rc.role_key,
       COUNT(*) FILTER (WHERE s.id IS NULL) AS missing_rows,
       COUNT(*) FILTER (
         WHERE s.id IS NOT NULL
           AND s.scope_json NOT IN ('"all"'::jsonb, '"assigned_only"'::jsonb)
       ) AS unknown_values,
       COUNT(*) FILTER (WHERE s.scope_json = '"all"'::jsonb) AS all_rows,
       COUNT(*) FILTER (WHERE s.scope_json = '"assigned_only"'::jsonb) AS assigned_only_rows
FROM company_role_configs rc
LEFT JOIN company_role_scopes s
  ON s.role_config_id = rc.id
 AND s.scope_key = 'job_visibility'
GROUP BY rc.role_key
ORDER BY rc.role_key;
```

**PROBE RESULT (prod, read-only, 2026-07-20):** every role on every company already
has an explicit `job_visibility` row — `missing_rows = 0` and `unknown_values = 0`
across dispatcher / manager / tenant_admin (5 companies each, all `all`) and provider
(5 companies, all `assigned_only`). **No migration or backfill is needed**, and the
rollout is genuinely behaviour-preserving on today's data: the fail-closed default is
a guard against future/corrupt rows, not a change to what anyone currently sees.

Backfill decision:

- all missing/unknown counts zero → no migration needed;
- missing rows nonzero → propose a reviewed role-aware insert (`provider` =
  `assigned_only`; office roles = `all`) before treating the rollout as
  behavior-preserving;
- unknown values nonzero → inspect values and affected role/company counts before
  rewriting them. Runtime remains secure because they fail closed immediately.

## Tests and sabotage minimum

| invariant | regression | minimum sabotage that must redden it |
|---|---|---|
| Missing/null/unknown `job_visibility` is assigned-only; exact `all` remains wide | `tests/jobsProviderScope.test.js` — `getProviderScope fail-closed defaults` | Restore `visibility !== 'assigned_only'` or default visibility to `all`; the missing/null/unknown cases fail. |
| Tasks list rejects a missing non-manager actor before SQL | `tests/routes/tasks.test.js` — `provider with missing crmUser.id gets 500 and no company-wide query` | Set `filters.scopeOwnerId = actorId(req)` directly; response becomes 200 and SQL runs. |
| Tasks count rejects the same broken actor | `tests/routes/tasks.test.js` — `provider with missing crmUser.id gets 500 and no unscoped count` | Remove `applyListVisibility` from `/count`; response becomes 200 and SQL runs. |
| Query callers cannot turn a present empty owner scope into no predicate | `tests/tasksCount.test.js` — `present but missing scopeOwnerId adds an impossible predicate` | Restore the truthy-only `if (filters.scopeOwnerId)` branch; `FALSE` disappears. |
| `my_open_deals` cannot accept a supplied owner when actor is missing | `tests/services/crmListsService.test.js` — missing-actor/cross-owner test | Restore `filters.owner_user_id || context.actorId`; the supplied-owner call resolves instead of rejecting. |
| Unknown/incomplete/mismatched portal scope cannot list all contact documents | `tests/portalScopeFailClosed.test.js` — fail-closed tuple table | Restore `if (scope !== 'full' && documentType && documentId)`; incomplete scope executes the full-list query. |

Negative control executed on 2026-07-20: all minimum sabotages above were
applied together, the five owning suites went RED with 11 failing tests, the
exact fail-closed edits were restored, and the focused set returned GREEN with
95/95 tests.

## Changelog

- **2026-07-20:** Initial durable artifact. Recorded D1–D4, fixed the two
  backlog defects plus two genuine siblings, added fail-closed regressions,
  documented the complete sibling audit and production data probe. No migration,
  frontend change, permission change, tenancy change, commit, or push.
