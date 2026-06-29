# Test Cases — TASKS-001 (Cross-entity Tasks)

Spec: `docs/specs/TASKS-001.md`. DB is mocked in Jest like other route suites. Frontend has no component
harness → frontend verified by `npm run build` (tsc -b strict) + dev preview + review.

## Coverage
- Total: 24 · P0: 9 · P1: 9 · P2: 6
- Unit (queries): 5 · Integration (route, supertest-style with mocked db): 15 · Frontend (build/preview): 4

---

### Backend — routes/tasks.js (integration, mocked db)

**TC-TASKS-001 (P0, security):** `GET /api/tasks` without token → **401**.
**TC-TASKS-002 (P0, security):** any `/api/tasks` call from a user with no company membership → **403**.
**TC-TASKS-003 (P0, security):** `GET /api/tasks` without `tasks.view` permission → **403**.
**TC-TASKS-004 (P0, isolation):** `GET /api/tasks/entity/job/:id` where the job belongs to another company
→ **404** (parent-existence join on `company_id`).
**TC-TASKS-005 (P0, isolation):** `PATCH /api/tasks/:id` for a task in another company → **404**.
**TC-TASKS-006 (P0):** `POST /api/tasks {parent_type:'job',parent_id,description,due_at}` with `tasks.create`
→ **201/200**, returns task with `author_user_id = req.user.crmUser.id`, `owner_user_id` defaulted to me,
`status:'open'`. Query insert includes `company_id`.
**TC-TASKS-007 (P1, validation):** `POST` with both `job_id` and `lead_id` (two parents) → **400**
`MULTIPLE_PARENTS`. With none → **400** `MISSING_PARENT`. Unknown `parent_type` → **400**
`INVALID_PARENT_TYPE`. Empty description → **400** `DESCRIPTION_REQUIRED`.
**TC-TASKS-008 (P1):** `POST` with non-existent `parent_id` in this company → **404**.
**TC-TASKS-009 (P0):** `PATCH /api/tasks/:id {status:'done'}` → sets `completed_at`; `{status:'open'}` →
clears it. Idempotent done → 200 no-op.
**TC-TASKS-010 (P1):** `PATCH /api/tasks/:id {due_at}` (snooze) updates `due_at`, leaves `status:'open'`.
**TC-TASKS-011 (P0, authz):** provider (has `tasks.view`+`tasks.create`, no `tasks.manage`) calling
`GET /api/tasks` → only tasks where `owner_user_id = me` (own scope). Manager → all company tasks.
**TC-TASKS-012 (P1, authz):** provider `PATCH`/`DELETE` a task they neither own nor authored → **403**;
on their own task → **200**.
**TC-TASKS-013 (P1):** `GET /api/tasks?overdue=1` returns only `status='open' AND due_at < now`.
**TC-TASKS-014 (P2):** `GET /api/tasks` default sort = `due_at` asc, nulls last; default filter
`status=open`.
**TC-TASKS-015 (P2):** `DELETE /api/tasks/:id` by an allowed user → row removed; foreign id → 404.

### Backend — tasksQueries.js (unit, mocked db)

**TC-TASKS-016 (P1):** `createEntityTask` builds INSERT with the correct single parent column populated and
`company_id` bound.
**TC-TASKS-017 (P1):** `listEntityTasks` filters `company_id` + parent column + `status` and LEFT JOINs
parent for `parent_label` + crm_users for assignee/author names.
**TC-TASKS-018 (P2):** `listTasksForUser` with `scopeOwnerId` set adds `owner_user_id = $` ; with null
(manager) omits it.
**TC-TASKS-019 (P2):** `updateEntityTask` with `status:'done'` writes `completed_at = now()`; with `'open'`
writes `completed_at = NULL`.
**TC-TASKS-020 (P2):** parent-existence helper returns 404-signal for an id not in company.

### Frontend (build + dev preview + review)

**TC-TASKS-021 (P0):** `npm run build` (tsc -b strict, noUnusedLocals) green with all new components.
**TC-TASKS-022 (P1, preview):** In a parent card, "Add task" beside "Add note"; creating a task pins it at
the top of the notes feed (Job/Lead/Contact) / the tasks block (Estimate/Invoice). 2+ tasks render as a
stack; clicking the stack expands; Done removes from open stack; Snooze menu shows 5 presets; pencil opens
edit.
**TC-TASKS-023 (P1, preview):** `/tasks` page lists tasks grouped by due bucket; clicking a row opens the
correct parent card (job→/jobs/:id, estimate→/estimates/:id, etc.); overdue rows highlighted.
**TC-TASKS-024 (P2, preview):** Mobile `/tasks` = date-grouped tiles; nav "Tasks" tab gated on `tasks.view`
(hidden for a role lacking it); estimate/invoice deep-link routes open their panels from the URL.
