# TASKS-COUNT-BADGE-001 — "open tasks" counter badge in navigation

**Status:** Spec · **Area:** Tasks backend (count route + shared predicate + `task.changed` SSE) + Frontend nav badge
**Type:** feature · **Migrations:** none · **New permission:** none · **Realtime:** additive PII-free `task.changed`
Direct clone of [LEADS-NEW-BADGE-001](LEADS-NEW-BADGE-001.md) applied to Tasks. Builds on
[TASKS-001](TASKS-001.md) / [AR-TASK-UNIFY-001](AR-TASK-UNIFY-001.md). Architecture:
`Docs/architecture.md` §TASKS-COUNT-BADGE-001. Requirements: `Docs/requirements.md` §TASKS-COUNT-BADGE-001.

## Problem
The `tasks` nav item (`appLayoutNavigation.tsx`, `ListChecks` icon, perm `tasks.view`) renders bare. A user
has no at-a-glance signal of how many open tasks await them. Add a number-in-a-circle badge — the same
`pulse-unread-badge` used by the Pulse and Leads badges — showing the count of **open tasks visible to the
current user**, i.e. exactly the row count `GET /api/tasks?status=open` returns for that user.

## General description
The badge is a **live, state-derived count** (not a read/unread marker). It equals the number of open tasks
the user would see on `/tasks` under the "Only Open" filter. Visibility follows the Tasks model verbatim:
a `tasks.manage` user counts **all** open company tasks; every other role counts **only** tasks they own
(`owner_user_id = their crm_users.id`). Company-scoped. It never clears on viewing `/tasks`; it changes only
as the underlying open tasks change (create / complete / reopen / reassign / delete). Freshness = the Leads
recipe (mount + route-change + 60s poll) plus an instant refetch on a coarse `task.changed` SSE ping.

---

## The load-bearing invariant (AC-1..AC-3)
For the same session, the badge value **MUST equal** the row count of `GET /api/tasks?status=open`. This is
guaranteed **structurally**, not by discipline: the count is a `COUNT(*)` over the **byte-identical WHERE**
the list builds. To make drift impossible, the shared predicate is refactored out of `listTasks` into one
builder both the list and the count consume.

### Shared-predicate refactor contract — `buildTaskListFilters`

`backend/src/db/tasksQueries.js` today inlines the filter/param assembly inside `listTasks` (the
`conditions = ['t.company_id = $1', HAS_ENTITY_PARENT]` block that then pushes
`scopeOwnerId` / `status` / `assignee_id` / `parent_type` / `overdue` / `due_from` / `due_to`). Extract it:

- **Signature:** `buildTaskListFilters(companyId, filters = {})` → `{ conditions: string[], params: any[] }`.
- **Seed (unchanged order):** `params = [companyId]`; `conditions = ['t.company_id = $1', HAS_ENTITY_PARENT]`.
- **Pushes (identical order and `$n` numbering to today's `listTasks`):** `scopeOwnerId` → `t.owner_user_id = $n`;
  `status` → `t.status = $n`; `assignee_id` → `t.owner_user_id = $n`; `parent_type` (valid only) →
  `t.<col> IS NOT NULL` (no param); `overdue` → `t.status = 'open' AND t.due_at IS NOT NULL AND t.due_at < now()`
  (no param); `due_from` → `t.due_at >= $n::timestamptz`; `due_to` → `t.due_at <= $n::timestamptz`.
- It does **NOT** append `limit` / `offset` — those stay in `listTasks`, pushed after the shared block.

**Both consumers of the builder produce a byte-identical `WHERE`:**

- **`listTasks`** becomes: call `buildTaskListFilters`, then push `limit`/`offset` to `params`, and run
  `SELECT_TASK … WHERE ${conditions.join(' AND ')} ORDER BY t.due_at ASC NULLS LAST, t.created_at DESC
  LIMIT $… OFFSET $…`. Output byte-identical to today (same conditions, same push order → same `$n`).
- **`countTasks(companyId, filters = {}, client = null)`** (new sibling, exported):
  `requireCompanyId(companyId)`; `{ conditions, params } = buildTaskListFilters(companyId, filters)`; run
  **`SELECT COUNT(*)::int AS count FROM tasks t WHERE ${conditions.join(' AND ')}`** with `params`; return
  `rows[0]?.count || 0`. **No `SELECT_TASK` join block** — `HAS_ENTITY_PARENT` and every filter reference only
  `t.*` columns, so the count runs against the bare `tasks t` (all the `LEFT JOIN`s in `SELECT_TASK` are
  label-hydration, irrelevant to `COUNT(*)`). This keeps it cheap.

**Result:** `countTasks({ status:'open', scopeOwnerId })` and `listTasks({ status:'open', scopeOwnerId })`
share one predicate source; the count can never exceed / diverge from the list (AC-1..AC-3).

---

## API — `GET /api/tasks/count`

- **Method / path:** `GET /api/tasks/count`.
- **Auth / middleware chain:** inherits `app.use('/api/tasks', authenticate, requireCompanyAccess, tasksRouter)`;
  own gate `requirePermission('tasks.view')` (same gate as `GET /`). No `server.js` change.
- **Company scope:** `companyId(req)` = `req.companyFilter?.company_id`. `countTasks` SQL is
  `WHERE t.company_id = $1 AND …` (tenancy AC-6).
- **Identity / scoping (mirrors the `GET /` visibility branch verbatim):**
  `actorId(req)` = `req.user?.crmUser?.id` (created_by-FK-crm-user-id rule — **no `sub` fallback**);
  `canManage(req)` = `!!req.user._devMode || permissions.includes('tasks.manage')`.
  - `filters = { status: 'open' }` (fixed — the badge is the open backlog).
  - If `canManage(req)`: manager counts **all** company open tasks; `if (req.query.assignee_id) filters.assignee_id = req.query.assignee_id` (parity with the list, optional).
  - Else: `filters.scopeOwnerId = actorId(req)` — non-manager counts only own.
- **Response (success):** `{ ok: true, data: { count: <int> } }` — matches the Tasks routes' `{ ok, data }`
  envelope and the leads-badge contract. `count` is a non-negative integer.
- **Route order — critical.** Mount `/count` in the **static-segment cluster near the top** of `routes/tasks.js`
  — immediately after `GET /`, alongside `GET /assignees` and `GET /entity/:parentType/:parentId`, and
  **before** the `/:id` param routes (`PATCH /:id`, `DELETE /:id`). A literal `GET /count` can't collide with
  those verbs, but this follows the `/new-count`-before-`/:uuid` discipline (`leads.js`) and stays safe against
  a future `GET /:id`.

---

## Behavior scenarios (expected outcomes)

| ID | Scenario | Expected outcome |
|----|----------|------------------|
| **S1** | **Manager count.** User has `tasks.manage`. | Count = **all** open company tasks that satisfy `HAS_ENTITY_PARENT` — identical to their `/tasks?status=open` row count. Owner scope omitted. |
| **S2** | **Provider / dispatcher count.** Non-manager user. | Count = only open tasks with `owner_user_id = actorId(req)`. Another user's open task never contributes. |
| **S3** | **Create → +1.** A new open task is created via `POST /api/tasks` (any parent: job/lead/contact/estimate/invoice, or a `user`/`agent` timeline task). | Count increments by 1 for every user to whom it is visible; `task.changed` emitted; visible users' badges refetch and reflect +1 (instant via SSE, else ≤60s). |
| **S4** | **Complete → −1.** An open task is `PATCH`ed to `status:'done'`. | Count decrements by 1 for its visible audience; `task.changed` emitted. |
| **S5** | **Reopen → +1.** A `done` task is `PATCH`ed back to `status:'open'`. | Count increments by 1 for its visible audience; `task.changed` emitted. |
| **S6** | **Reassign owner A → B.** `PATCH` changes `owner_user_id` from A to B. | Per-user counts move: A's badge −1, B's badge +1. Manager badges unaffected (still one open company task). `task.changed` emitted; both A and B refetch their own server-scoped count. |
| **S7** | **Description / due-date / snooze-only edit.** `PATCH` with only `description` and/or `due_at`, no `status`/`owner_user_id` change. | Count **UNCHANGED**; **NO** `task.changed` emitted (status not flipped, owner not moved). |
| **S8** | **Agent/system auto timeline task.** Inbound SMS/call/email or rules creates a `system`/`automation`-provenance timeline task (no entity parent). | **NOT counted** — excluded by `HAS_ENTITY_PARENT` (timeline tasks count only when `created_by IN ('user','agent')`). **NO** `task.changed` emitted from that write. (An `agent`-provenance timeline task on a NEW insert IS counted and DOES emit — matches `HAS_ENTITY_PARENT` and MAIL-AGENT-001.) |
| **S9** | **Count == list.** Same session, same user. | `GET /api/tasks/count` `.count` **equals** `GET /api/tasks?status=open` `.tasks.length` exactly (shared predicate — including `HAS_ENTITY_PARENT`, `status='open'`, and manager-vs-owner scope). |
| **S10** | **Rendering thresholds.** | `count === 0` → badge **not rendered** (no "0" circle). `count > 9` → renders **`9+`**. `1..9` → the number. Identical desktop (`AppNavTabs`) + mobile (`BottomNavBar`). |

Additional guarantees: **S-idempotent** — navigating to `/tasks` does **not** clear the badge (state-derived, not a
read-marker). **S-tenancy (AC-6)** — a user in company A never sees company B's tasks in the badge.

---

## SSE contract — `task.changed`

**Chosen (Architect): one coarse, PII-free `task.changed` event carrying EXACTLY `{ company_id }`.** No
`owner_user_id`, no `id`, no `status`. Rationale: `realtimeService.broadcast` fans out to **all** connected
clients regardless of tenant; a richer payload would tempt client-side count math that could drift from the
server predicate (the very failure AC-3 forbids). The client simply **refetches its own server-scoped
`/api/tasks/count`** (which re-applies manager-vs-owner) whenever it sees a `task.changed` whose
`company_id === company.id`.

- **Emit helper:** new `backend/src/services/tasksService.js` (~15 lines), mirroring `emitLeadChange`:
  `emitTaskChange(companyId)` → `require('./realtimeService').broadcast('task.changed', { company_id: companyId })`,
  wrapped in try/catch (`console.warn` on failure), guarded `if (!companyId) return`.
- **Best-effort:** a broadcast failure **never** blocks or fails the task mutation (leads discipline).
- **Catalog:** add `{ key: 'task.changed', label: 'Open-task count changed', sample_fields: ['company_id'] }`
  to `backend/src/services/eventCatalog.js` (currently only `agent_task.succeeded/failed`).

### Exact emission sites (only where an open-visible count can change)

| Site | File / handler | Emit? | Guard |
|------|----------------|-------|-------|
| User create | `routes/tasks.js` `POST /` — after `createTask` succeeds, before `res` | **yes** | always (a new open task) |
| Complete / reopen | `routes/tasks.js` `PATCH /:id` | **yes** | only when `status` was in the patch (status flip) |
| Owner reassign | `routes/tasks.js` `PATCH /:id` | **yes** | only when `owner_user_id` was in the patch |
| Description / due / snooze-only | `routes/tasks.js` `PATCH /:id` | **no** | status & owner both absent from patch |
| Delete | `routes/tasks.js` `DELETE /:id` | **yes** | always (removes an open task) |
| Agent/inbound/rules timeline task | `db/timelinesQueries.js` `createTask` | **conditional** | **ONLY the NEW-INSERT branch AND `provenance IN ('user','agent')`** |

- **PATCH simplification (one guard, no double-emit):** since `emitTaskChange` is coarse and idempotent from
  the client's side (it only triggers a refetch), emit **once per PATCH whenever `status` OR `owner_user_id`
  was present in the patch**; skip pure description/due edits. (Covers S4/S5/S6; excludes S7.)
- **`timelinesQueries.createTask` — pin precisely (guards an existing code shape):** the function's final
  `INSERT` branch is reached for **all** provenances that did not hit the `AUTO`-upsert-**update** branch —
  including `system` and `automation` (which fall through to the INSERT when no existing AUTO open task
  exists). Therefore the emit MUST be **explicitly gated `provenance IN ('user','agent')` at the INSERT
  site** — do **not** emit for `system`/`automation` (their tasks are `HAS_ENTITY_PARENT`-excluded, Pulse-only)
  and do **not** emit from the `AUTO`-upsert-**update** branch (updating an existing open task doesn't change
  the count). Because that module is DB-layer, call
  `require('../services/tasksService').emitTaskChange(companyId)` best-effort (or inline the
  `realtimeService.broadcast`), consistent with how the leads emit lives in the service layer.

### Frontend wiring for the event (additive — a name in only ONE list is silently dead)
- `frontend/src/hooks/useRealtimeEvents.ts` — append `'task.changed'` to `genericEventTypes`.
- `frontend/src/hooks/sseManager.ts` — append `'task.changed'` to `namedEvents`.
- `AppLayout.tsx` — extend the **existing** `useRealtimeEvents.onGenericEvent` (do NOT add a second
  `useRealtimeEvents` call): `if (type === 'task.changed' && d?.company_id === company?.id) fetchOpenTasksCount();`.

---

## Frontend threading (`openTasksCount`, parallel to `leadsNewCount`)

- **`frontend/src/components/layout/AppLayout.tsx`:** add `const [openTasksCount, setOpenTasksCount] = useState(0)`
  + `fetchOpenTasksCount` — a verbatim clone of `fetchLeadsNewCount`: `authedFetch('/api/tasks/count')`, read
  `json?.data?.count ?? 0`, gated on `company`. Fetch on mount + on `location.pathname` change + 60s
  `setInterval` poll. Pass `openTasksCount` into both `<AppNavTabs …>` and `<BottomNavBar …>`.
- **`frontend/src/components/layout/appLayoutNavigation.tsx`:**
  - Add `openTasksCount: number` to `AppNavProps` and the `BottomNavBar` prop type; thread both destructures.
  - `AppNavTabs`: add `t.key === 'tasks'` to the `position: relative` set; render next to the pulse/leads badges:
    `{t.key === 'tasks' && openTasksCount > 0 && <span className="pulse-unread-badge" title={\`${openTasksCount} open tasks\`}>{openTasksCount > 9 ? '9+' : openTasksCount}</span>}`.
  - `BottomNavBar`: matching `t.key === 'tasks'` branch using the same absolute-position `pulse-unread-badge` span.
- **No CSS change** — reuses `pulse-unread-badge` (AppLayout.css); the `9+` cap and zero-hides-badge rules
  come free from the render guard (S10), identical to Pulse/Leads.

---

## Error handling
- **Count DB error** → `500` with the house envelope `{ ok:false, error:{ code:'INTERNAL', message:'Failed to count tasks' } }`
  (log `[Tasks] GET /count failed:` + `err.message`). The badge simply keeps its last value; next poll retries.
- **Unauthenticated** → `401` (from `authenticate`, before the handler).
- **Missing `tasks.view`** → `403` (from `requirePermission('tasks.view')`).
- **SSE emit failure** → swallowed (`console.warn`), never blocks the mutation; badge self-heals within 60s via poll.
- **Client fetch failure / malformed body** → `?? 0` fallback (no crash); recovers on the next mount/route/poll.

## Interaction / data flow
- `AppLayout.fetchOpenTasksCount` → `authedFetch('/api/tasks/count')` → `routes/tasks.js GET /count`
  (`requirePermission('tasks.view')`) → `tasksQueries.countTasks(companyId, { status:'open'[, scopeOwnerId] })`
  → `SELECT COUNT(*) … FROM tasks t WHERE <buildTaskListFilters>` → `{ ok, data:{ count } }` → badge render.
- Mutation (`POST` / `PATCH` status|owner / `DELETE` / `timelinesQueries.createTask` new-insert user|agent)
  → `emitTaskChange(companyId)` → `realtimeService.broadcast('task.changed', { company_id })` → all clients →
  those with `company_id === company.id` call `fetchOpenTasksCount` → re-scoped count.

## Security & tenancy isolation
- Count filtered by `company_id = $1` (tenancy AC-6) — same guarantee the Tasks routes enforce.
- Manager-vs-owner scope resolved from `req.authz.permissions` + `req.user.crmUser.id` only (no `sub` fallback).
- SSE payload is a single UUID (`company_id`) — PII-free; server scopes, client only filters by `company_id`.

## Files to change
| File | Change |
|------|--------|
| `backend/src/db/tasksQueries.js` | Extract `buildTaskListFilters(companyId, filters)`; refactor `listTasks` onto it (behavior byte-identical); add + export `countTasks`. |
| `backend/src/routes/tasks.js` | Add `GET /count` (gated `tasks.view`) in the static-segment cluster, above `/:id`; mirror the `GET /` manager-vs-owner branch. Add `emitTaskChange` calls in `POST /`, `PATCH /:id` (status-or-owner guard), `DELETE /:id`. |
| `backend/src/services/tasksService.js` | **New** (~15 lines): `emitTaskChange(companyId)` → PII-free `task.changed` broadcast, best-effort. |
| `backend/src/db/timelinesQueries.js` | In `createTask`, emit `task.changed` **only** on the NEW-INSERT branch when `provenance IN ('user','agent')` (not the AUTO-upsert-update branch, not `system`/`automation`). |
| `backend/src/services/eventCatalog.js` | Add the `task.changed` catalog entry. |
| `frontend/src/components/layout/AppLayout.tsx` | `openTasksCount` state + `fetchOpenTasksCount` + mount/route/60s poll; pass to `AppNavTabs` + `BottomNavBar`; extend `onGenericEvent` for `task.changed`. |
| `frontend/src/components/layout/appLayoutNavigation.tsx` | `openTasksCount` prop (both nav components); render the `tasks` badge (desktop + mobile) with `pulse-unread-badge`. |
| `frontend/src/hooks/useRealtimeEvents.ts` | Append `'task.changed'` to `genericEventTypes` (additive only). |
| `frontend/src/hooks/sseManager.ts` | Append `'task.changed'` to `namedEvents` (additive only). |

## Non-goals / protected
- **No migration, no new permission** — a read over existing `tasks` rows; served by existing
  `company_id`/`status`/`owner_user_id` access, no per-row scan, no new index.
- **No change to `GET /api/tasks` list behavior** or its visibility model — the count *reuses* the extracted
  builder; `HAS_ENTITY_PARENT`, `canManage`/`scopeOwnerId`, and the AR-TASK-UNIFY-001 timeline coupling are
  untouched.
- **No clearing-on-open** — the badge is a live count, not a notification / read-marker.
- **No** overdue-only / due-today-only counting, per-parent-type breakdowns, or a badge on any surface other
  than the `tasks` nav item.
- **LEADS-NEW-BADGE-001 wiring** (`leadsNewCount`, `/new-count`, its SSE types) and the shared
  `pulse-unread-badge` markup are added *alongside* and must keep working unchanged; `useRealtimeEvents.ts` /
  `sseManager.ts` touched **additively only**.
- Deploy to prod only with explicit owner consent (standing rule).

## Verify
- Backend Jest (`tasks.test.js`): `countTasks({status:'open'})` returns the same integer as
  `listTasks({status:'open'}).length` over the same fixture (S9); manager omits owner scope (S1), non-manager
  applies `scopeOwnerId` (S2); `GET /count` returns `{ok:true,data:{count}}`, `401`/`403`/`500` on the error
  paths. Assert `emitTaskChange` fires on POST / PATCH-status / PATCH-owner / DELETE and does **not** fire on
  description/due-only PATCH (S7) nor on a `system`/`automation` `timelinesQueries.createTask` write (S8).
  **GOTCHA:** Jest mocks the DB, so the byte-identical-WHERE invariant (AC-1..AC-3) is only truly verified by
  running `countTasks` vs `listTasks().length` against a real DB copy — do that before deploy (per
  LIST-PAGINATION-001 lesson). Worktree run needs `--testPathIgnorePatterns "/node_modules/"`.
- Frontend: `npm run build` (tsc -b strict) green; badge shows for a manager = company open count and for a
  provider = own open count; hidden at 0, `9+` above 9, desktop + mobile identical; creating/completing a task
  updates it (instant via `task.changed`, else ≤60s); no console errors.
