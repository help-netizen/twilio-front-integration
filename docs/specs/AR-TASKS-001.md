# AR-TASKS-001 — Pulse Action Required task rows

## Scope

- Return every open task for a Pulse timeline in the existing by-contact page query.
- Render one plaque row per task with task-id Done, Snooze, and Assign actions.
- Keep thread-level handling only for a taskless manual Action Required flag.
- Keep the first ordered task as the compatibility `open_task` sidebar preview.
- No migration and no new API route.

## Data and behavior decisions

- `tasks.owner_user_id` is the per-task assignee. Assignment uses the existing
  `PATCH /api/tasks/:id { owner_user_id }` contract.
- Snooze uses the existing `PATCH /api/tasks/:id { due_at }` contract.
- `GET /api/calls/by-contact` aggregates `open_tasks` as ordered JSON inside its
  existing company-scoped SQL page. It does not issue a request/query per row.
- Completing a timeline-linked task clears legacy timeline AR metadata only when
  no company-owned open task remains. The UI's canonical AR signal remains
  `open_tasks.length > 0`.
- `POST /api/pulse/threads/:id/mark-handled` may clear only a taskless manual flag;
  it never updates `tasks`.
- The sticky list has an internal viewport-relative height cap and scroll. No task
  is omitted or truncated from the payload.

## Tenancy & Roles
| surface (route/worker/webhook/SSE/aggregate) | scoped by | key used | permission | roles ✓/✗ | blast-radius risk |
|---|---|---|---|---|---|
| `GET /api/calls/by-contact` open-task aggregate | `req.companyFilter?.company_id` → `tl.company_id = $1`; task leg `ot.company_id = tl.company_id` | timeline id; phone/email only in existing channel legs | `reports.calls.view` OR `pulse.view` | default tenant_admin ✓; manager ✓; dispatcher ✓; provider ✓ (`pulse.view`); custom role lacking both ✗ | Hot unified page and shared phone/email signals; loss of either outer or task-leg tenant predicate could expose another tenant's task text/assignee. |
| `PATCH /api/tasks/:id` Done/Snooze/Assign | `req.companyFilter?.company_id`; task read/update and remaining-task probe each filter `company_id` | task id; raw `thread_id` only after company-scoped task read | `tasks.view` plus manage OR owner OR author action rule | tenant_admin/manager/dispatcher ✓ any (`tasks.manage`); provider ✓ own/authored and ✗ other-owned; missing `tasks.view` ✗ | An id-only update without `company_id`, or a remaining-task probe without company scope, could mutate/clear another tenant. |
| `GET /api/tasks/assignees` | `req.companyFilter?.company_id` passed to `userService.listUsers` | CRM user id | `tasks.create` OR `tasks.manage` | tenant_admin/manager/dispatcher/provider ✓ by default; custom role lacking both ✗ | A global user list would disclose identities and allow a foreign assignee id to be selected. |
| `POST /api/pulse/threads/:id/mark-handled` (manual-only) | `req.companyFilter?.company_id`; ownership preflight and conditional update both company-scoped | timeline id | `pulse.view` | default tenant_admin/manager/dispatcher/provider ✓; role lacking `pulse.view` ✗ | Former bulk task update was thread-wide; invariant now forbids every task write and refuses timelines with open tasks. |
| `task.changed` SSE refetch | `tasksService.emitTaskChange(company_id)` and same-company realtime broadcast | company id only; no task PII | originating task route's permission | same allow/deny result as originating `PATCH`; subscribers only receive own company | Wrong broadcast company could prompt cross-tenant clients; payload deliberately contains only `company_id`. |

## Test contract

- [x] `T-own`: own-company by-contact aggregate and task mutation work.
- [x] `T-foreign`: foreign task/timeline ids return 404 before mutation; query tests pin company predicates.
- [x] `T-blast`: by-contact channel legs and the new task aggregate each pin their company scope; id-keyed task writes do not use a natural key.
- [x] `R-matrix`: missing `pulse.view`/calls permission and missing `tasks.view` deny; provider other-owned task denies; default allow paths remain covered.
- [x] Regression: two open tasks on one timeline; completing task A leaves task B open and the derived AR signal set.
- [x] Sabotage: replace row `mutations.complete(task)` with thread `markHandled`, or remove the task-id/company predicates; the plaque regression/source invariant or backend tenant/remaining-task assertions fail.
