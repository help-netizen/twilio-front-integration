# SCHEDULE-JOB-DEEPLINK-001 — Schedule job-card deep links

**Status:** Implemented, pending owner/reviewer acceptance

**Date:** 2026-07-23

**Type:** Frontend routing and interaction

**Backend / migration / permission change:** None

## Scope

Opening a job card from Schedule changes the browser URL from `/schedule` to
`/schedule/jobs/:jobId`. The URL is copyable, survives a direct page load, and
is the single source of truth for which job detail panel is open.

The parameterized route renders the same `SchedulePage` as `/schedule`. The
existing Schedule date, view, filters, cards, map behavior, job detail component,
single-job API, mutations, tenancy checks, and role permissions are not changed.

## Requirements

- [x] `/schedule` and `/schedule/jobs/:jobId` render the same `SchedulePage` and
  require the existing `schedule.view` frontend permission.
- [x] A positive integer `:jobId` is passed to `useJobDetail`; malformed,
  non-integer, zero, and negative values resolve to no selected job and make no
  single-job request.
- [x] A direct `/schedule/jobs/:jobId` load opens the full job panel through the
  existing `GET /api/jobs/:id` fetch even when the job is absent from the
  currently visible Schedule items.
- [x] Opening the first job from `/schedule` uses history PUSH, so browser Back
  returns to `/schedule` and closes the panel.
- [x] Selecting job B while job A is open uses history REPLACE, so browser Back
  closes B instead of reopening A.
- [x] Closing the detail panel navigates to `/schedule` and clears the linked
  Schedule highlight.
- [x] A rejected single-job fetch reports `Job not found or unavailable` and
  replaces the stale/forbidden deep URL with `/schedule`.
- [x] Non-job Schedule entities retain the existing `SidebarStack` selection
  path and do not write a job URL.
- [x] Desktop and mobile inherit the same behavior because both render
  `SchedulePage`, use the shared item-selection callback, and use the shared
  `FloatingDetailPanel`.

## Decisions taken

### D1 — the route parameter is the selected-job state

`SchedulePage` does not keep a second local `selectedJobId`. It validates
`useParams().jobId` as an integer greater than zero and passes the result to
`useJobDetail`. Removing the parameter closes the panel; adding or changing it
loads the corresponding job.

This avoids URL/panel drift and makes browser Back a normal route transition
rather than a second state synchronization path.

### D2 — first open pushes; card switching replaces

The central job-card callback selects:

- `replace: false` when no URL job is open;
- `replace: true` when a URL job is already open.

This creates exactly one detail entry above `/schedule`, regardless of how many
cards the user examines before pressing Back.

### D3 — visible-card highlighting is best effort

When the URL-selected job exists in `scheduledItems`, Schedule sets its existing
`selectedScheduleItemKey`. An out-of-range deep link still opens the fetched
detail panel but does not change the current Schedule date, view, or filters and
does not fabricate a visible card.

### D4 — invalid and unavailable routes fail closed

Invalid IDs never enter the detail-fetch path. A fetch rejection clears the
detail state through `useJobDetail.onNotFound`, shows one error toast, and
replaces the bad URL with `/schedule`. The client does not distinguish missing,
foreign, provider-invisible, or permission-denied records.

## Architecture

The durable seams are intentionally small:

- `frontend/src/App.tsx` registers `/schedule/jobs/:jobId` beside `/schedule`
  with the same page and frontend permission.
- `frontend/src/pages/SchedulePage.tsx` owns route parsing, PUSH/REPLACE
  selection, close navigation, visible-card highlighting, and not-found
  navigation.
- `frontend/src/hooks/useJobDetail.ts` remains the reusable single-job detail
  owner and exposes the optional `onNotFound(jobId)` callback for route owners.
- `frontend/src/services/jobsApi.ts` continues to issue the existing
  `GET /api/jobs/:id` request.
- `FloatingDetailPanel` and `JobDetailPanel` are reused without a Schedule-only
  detail implementation.

The requirements and architecture blocks are warranted even for this
frontend-only change because history PUSH versus REPLACE and URL-as-state are
behavioral invariants that a visually equivalent local-state implementation
could silently regress.

## Tenancy & Roles

| surface | frontend permission | backend permission / scope | durable behavior |
|---|---|---|---|
| `/schedule` | `schedule.view` | Existing company-scoped Schedule reads | Unchanged. |
| `/schedule/jobs/:jobId` | `schedule.view` | Page loads, then full detail still calls `GET /api/jobs/:id`. | The deep route is not an authorization grant. |
| `GET /api/jobs/:id` | N/A | Existing `jobs.view`, `req.companyFilter.company_id`, and provider visibility scope | Unchanged; foreign or provider-invisible jobs remain indistinguishable from missing jobs. |

There is deliberately no RBAC widening. Default roles currently able to open a
job card continue to open it by click or URL. A custom role with
`schedule.view` but without `jobs.view` can reach the Schedule route but cannot
load the full job through either interaction; the API rejection follows the
same unavailable-job path and returns the URL to `/schedule`.

No new API, SQL, natural-key lookup, tenant join, mutation, worker, webhook, SSE
event, or aggregate is introduced. Existing backend tenancy and provider-scope
tests remain authoritative.

## Non-goals

- No redirect to `/jobs/:jobId`.
- No automatic change to the Schedule date, view, provider filter, or tag filter
  for an out-of-range job.
- No change to Schedule map marker selection.
- No backend, migration, permission, role-seed, or provider-scope change.
- No distinct public/not-found page and no disclosure of why a job fetch was
  rejected.

## Test contract

`frontend/src/pages/ScheduleJobDeepLink.test.tsx` exercises the real in-memory
router history while mocking calendar-heavy rendering:

1. direct out-of-range deep link opens job 1463;
2. first open PUSHes and Back closes;
3. A-to-B switching REPLACEs and Back closes;
4. panel close returns to `/schedule`;
5. invalid IDs keep the panel closed;
6. `onNotFound` toasts and replaces the URL;
7. non-job selection remains in `SidebarStack`;
8. the App route retains `schedule.view` and `SchedulePage`.

`frontend/src/hooks/useJobDetailDeepLink.test.ts` separately pins the real hook
effect: a positive ID calls the existing jobs API, a null ID does not fetch, and
a rejected request fires `onNotFound` with the rejected ID.

### Named sabotage minimum

| invariant | named control | minimum breaking edit | expected red test |
|---|---|---|---|
| First job open adds a history entry; later switches do not | `SAB-SJD-PUSH-REPLACE` | Replace `replace: selectedJobId != null` with `replace: true` in the real `SchedulePage` callback | `first open pushes so Back returns to /schedule and closes the panel` fails because Back remains on the job URL |

The sabotage must be applied on top of the uncommitted implementation, observed
red, and reversed with the exact inverse edit. Do not restore it with git
checkout/reset because that would discard the owner’s uncommitted routing work.

## Verification

- `env NODE_USE_SYSTEM_CA=0 ./node_modules/.bin/vitest run src/pages/ScheduleJobDeepLink.test.tsx src/hooks/useJobDetailDeepLink.test.ts --reporter=verbose`
  — **PASS**, 2 files / 12 tests.
- `SAB-SJD-PUSH-REPLACE` — **RED as required** after forcing every selection to
  REPLACE: the first-open Back assertion failed on
  `/schedule/jobs/41`; the A-to-B history assertion also failed. The exact line
  was restored.
- `env NODE_USE_SYSTEM_CA=0 ./node_modules/.bin/vitest run src/pages/ScheduleJobDeepLink.test.tsx --reporter=verbose`
  — **PASS after restore**, 1 file / 9 tests.
- `env NODE_USE_SYSTEM_CA=0 npm test` (from `frontend/`) — **PASS**, 53 files /
  293 tests.
- `env NODE_USE_SYSTEM_CA=0 npm run build` (from `frontend/`) — **PASS**;
  TypeScript build and Vite production build completed, 3549 modules
  transformed. Existing dynamic-import and large-chunk warnings remain
  non-fatal.

The explicit `NODE_USE_SYSTEM_CA=0` avoids the documented Node 25 macOS
keychain crash and does not change application behavior.

## Changelog

- **2026-07-23:** Initial durable artifact. Recorded the URL-as-selected-job
  model, first-open PUSH/card-switch REPLACE history contract, direct
  out-of-range fetch, invalid/unavailable handling, unchanged tenancy and RBAC,
  focused route/hook tests, and the proven `SAB-SJD-PUSH-REPLACE` negative
  control. No backend, migration, permission, role, commit, or push.
