# TASKS-001 — Cross-entity Tasks (no standalone card)

**Type:** feature · backend + frontend · **migration: 136** (extend existing `tasks` table; no new table).
**Status:** SPEC (orchestrate pipeline). Owner-confirmed decisions in the interview are binding.

---

## 1. Product requirements

### 1.1 Summary
A **Task** is a small actionable item (assignee + deadline + description) that **always belongs to a
parent entity** and has **no standalone detail view**. Tasks surface in two places:
1. **Inside the parent entity's card** — pinned at the top of the Notes feed (Job / Lead / Contact) or as a
   compact block near the top (Estimate / Invoice, which have no notes feed).
2. **A global "Tasks" page** — a cross-entity list; clicking a task **navigates to and opens the parent
   entity's card** (never a task card).

### 1.2 Parent entities (v1 scope — all five)
Job, Lead, Contact, Estimate, Invoice. A task links to **exactly one** parent.

### 1.3 User scenarios
1. **Create** — from a parent card: "Add task" button next to "Add note" (Job/Lead/Contact) or in the
   tasks block (Estimate/Invoice). Author = current user (auto). Assignee defaults to current user, editable.
   Deadline = date + time (default: today 17:00 company TZ, editable).
2. **See in card** — open tasks render as a **stack** pinned above notes (freshest on top). One task → a
   single card. Many → a stack; **tap the stack to expand** (reveals all); collapse again.
3. **Complete** — "Done" button on a task → one tap, optimistic, toast, reopenable.
4. **Snooze** — "Snooze" button → dropdown: **15 min / 1 hour / 3 hours / tomorrow 08:00 / custom date →
   08:00** (company TZ). Reschedules the deadline (`due_at`); task stays *open*.
5. **Edit** — pencil icon in the task corner → edit description / assignee / deadline.
6. **Global list** — "Tasks" nav tab → cross-entity list grouped by due date (Overdue / Today / Tomorrow /
   later). Click a task → opens its parent card. Role-scoped visibility (see §4).

### 1.4 Non-functional / constraints
- Multi-tenant: every query filters `company_id` via `req.companyFilter.company_id`. Foreign id → 404.
- Writes set FK user columns to `req.user.crmUser.id` (NOT `sub`) — see created-by-fk convention.
- No reminders/notifications in v1 (overdue is **visual only**). No cron, no SMS/push.
- Reuse the existing `tasks` table and the Sales-CRM task endpoints stay **untouched**.
- Blanc design system (CLAUDE.md): no `<hr>`, eyebrow headers, near-white surfaces, rounded cards.

### 1.5 Protected / must-not-break
- `src/server.js` core (only add one `app.use('/api/tasks', …)` mount line).
- `frontend/src/lib/authedFetch.ts`, `useRealtimeEvents.ts`.
- Existing `tasks` rows (Pulse `thread_id`, Sales CRM `account_id`/`deal_id`/`contact_id`) and the
  `GET/POST/PATCH /tasks` endpoints in `backend/src/routes/crm.js` (gated `sales.crm.write`).
- The `uq_tasks_one_open_per_thread` unique index (thread-only; irrelevant to new parents — multiple open
  tasks per job/lead/etc. are allowed).

---

## 2. Architecture

### 2.1 Data model — migration `136_extend_tasks_for_crm_entities.sql`
```sql
ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS job_id        BIGINT REFERENCES jobs(id)      ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS lead_id       BIGINT REFERENCES leads(id)     ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS estimate_id   BIGINT REFERENCES estimates(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS invoice_id    BIGINT REFERENCES invoices(id)  ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS author_user_id UUID  REFERENCES crm_users(id) ON DELETE SET NULL;
-- contact_id already exists (migration 089 → contacts(id)).
-- Partial indexes (company + parent + status + due_at) for each parent:
CREATE INDEX IF NOT EXISTS idx_tasks_company_job_due      ON tasks(company_id, job_id,      status, due_at) WHERE job_id      IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tasks_company_lead_due     ON tasks(company_id, lead_id,     status, due_at) WHERE lead_id     IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tasks_company_estimate_due ON tasks(company_id, estimate_id, status, due_at) WHERE estimate_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tasks_company_invoice_due  ON tasks(company_id, invoice_id,  status, due_at) WHERE invoice_id  IS NOT NULL;
```
- **No "exactly one parent" CHECK** (would break existing Pulse/Sales rows). The new `/api/tasks` API
  enforces exactly-one-parent at the application layer for the 5 supported types.
- Reused columns: `owner_user_id` = **assignee**, `due_at TIMESTAMPTZ` = **deadline (date+time)**,
  `status` (`open`|`done`), `completed_at`, `description`, `title`, `priority` (kept in DB, **not** surfaced
  in v1 UI), `created_at`. New `author_user_id` = **author**.
- **Rollback:** `rollback_136_extend_tasks_for_crm_entities.sql` drops the 4 indexes + 5 columns.

### 2.2 RBAC — migration `136` (same file, seed block) + permission catalog
New permission keys: `tasks.view`, `tasks.create`, `tasks.manage`.
- Seed into `company_role_permissions` for existing role configs:
  - `tenant_admin`, `manager`, `dispatcher` → all three (`view`, `create`, `manage`).
  - `provider` (Technician) → `tasks.view` + `tasks.create` only (acts on **own** tasks via ownership
    check; **no** `tasks.manage` = no see-all).
- Add a **"Tasks"** category to `backend/src/services/permissionCatalog.js` (3 keys) so the Roles & Access
  editor (RBAC-AUDIT-001 R4) lists them.
- Frontend dev bypass: add `tasks.view/create/manage` to `AuthProvider` `DEV_PERMISSIONS`.

**Visibility rule (list endpoint):** has `tasks.manage` → all company tasks; else → only tasks where
`owner_user_id = req.user.crmUser.id` (own).

**Action rule (PATCH/DELETE):** allowed if caller has `tasks.manage` OR is the task's `owner_user_id`
(assignee) OR `author_user_id`. Otherwise 403. (Create requires `tasks.create`.)

### 2.3 Backend
- **New** `backend/src/db/tasksQueries.js` — `listEntityTasks(companyId, {parentType, parentId})`,
  `listTasksForUser(companyId, {scopeOwnerId|null, status, overdue, dueFrom, dueTo, parentType})`,
  `createEntityTask(companyId, payload)`, `getEntityTaskById(companyId, id)`,
  `updateEntityTask(companyId, id, patch)`, `deleteEntityTask(companyId, id)`. All filter `company_id`.
  List queries LEFT JOIN each parent for a denormalized label + JOIN `crm_users` for assignee/author names.
- **New** `backend/src/routes/tasks.js` mounted in `src/server.js`:
  `app.use('/api/tasks', authenticate, requireCompanyAccess, tasksRouter)`. Per-route `requirePermission`.
- Endpoints (see §5).

### 2.4 Frontend
- **New shared** `frontend/src/components/tasks/`:
  - `TaskStack.tsx` — given `parentType`+`parentId`, fetches open tasks, renders the stack (collapsed
    peek → expand on click), each as `TaskCard`. Hosts the "Add task" affordance + create/edit dialog.
  - `TaskCard.tsx` — assignee · author · description · deadline (date+time, overdue highlight) +
    **Done**, **Snooze** (dropdown), **pencil** (edit).
  - `TaskSnoozeMenu.tsx` — the 5 presets; computes new `due_at` in company TZ via `companyTime` helpers.
  - `TaskFormDialog.tsx` — create/edit (description, assignee select, deadline date+time).
  - `tasksApi.ts` — `listEntityTasks`, `listMyTasks`, `createTask`, `updateTask`, `completeTask`,
    `snoozeTask` (→ updateTask with due_at), `deleteTask`.
  - `useEntityTasks.ts` — hook used by the in-card stack (fetch + optimistic mutate + refetch).
- **Mount points:**
  - Job/Lead/Contact: `frontend/src/components/shared/NotesSection.tsx` — render `<TaskStack>` pinned at
    the top of the notes feed; add an "Add task" button beside the existing "Add note" button. Covers all
    three via the shared component (entityType `'job'|'lead'|'contact'` → parentType).
  - Estimate: `EstimateDetailPanel.tsx`; Invoice: `InvoiceDetailPanel.tsx` — render `<TaskStack>` as a
    compact block near the top (no notes feed there).
- **Global page:** `frontend/src/pages/TasksPage.tsx` (+ desktop list & `TasksMobileList`) at route
  `/tasks` (`ProtectedRoute permissions={['tasks.view']}`); nav item in
  `appLayoutNavigation.tsx` WORKSPACE_TABS (`permission: 'tasks.view'`, icon `ListChecks`). Clicking a row
  → `navigate(parentPath)` where parentPath = `/jobs/:id` | `/leads/:id` | `/contacts/:id` |
  `/estimates/:id` | `/invoices/:id`.
- **New deep-link routes** for estimates & invoices: add `/estimates/:estimateId` and `/invoices/:invoiceId`
  in `App.tsx` and make `EstimatesPage`/`InvoicesPage` open the detail panel from the URL param (mirror
  `JobsPage`/`LeadsPage` pattern). Required so a task can open those cards.

### 2.5 Timezone
Client computes all `due_at` values in `company.timezone` (from `useAuthz().company.timezone`) using
`frontend/src/utils/companyTime.ts` (`dateInTZ`, `tomorrowAtInTZ`, `formatTimeInTZ`, `dateKeyInTZ`). Stored
as `TIMESTAMPTZ` (UTC). Overdue = `status='open' && due_at < now`.

---

## 3. Behavior scenarios

### 3.1 Create task (in card)
- **Pre:** user has `tasks.create`; parent card open.
- **Steps:** click "Add task" → `TaskFormDialog` (description required; assignee select defaults to me;
  deadline date+time default today 17:00 TZ) → Save → `POST /api/tasks`.
- **Result:** task appears at the top of the stack; toast "Task added". Optimistic insert + refetch.
- **Side effects:** row in `tasks` with the parent FK, `author_user_id=me`, `owner_user_id=assignee`,
  `status='open'`.

### 3.2 Stack expand/collapse
- 0 open tasks → no stack; only the "Add task" affordance.
- 1 open task → a single `TaskCard`.
- ≥2 → collapsed stack shows the top card + a "peek" of the rest with a count ("+N"); **click the stack →
  expands** (all cards); click again (or a collapse chevron) → collapses. Done tasks are hidden from the
  in-card stack by default (a small "Show done" toggle reveals recently completed).

### 3.3 Complete / reopen
- Click **Done** → `PATCH /api/tasks/:id {status:'done'}`; card animates out of the open stack; toast with
  **Undo** (reopen → `{status:'open'}`). `completed_at` set/cleared.

### 3.4 Snooze
- Click **Snooze** → menu (15 min / 1 h / 3 h / Tomorrow / Pick a date…). Selecting a relative option →
  `due_at = now + delta`. "Tomorrow" → `tomorrowAtInTZ(8,0)`. "Pick a date" → date picker → chosen day
  **08:00** company TZ via `dateInTZ`. → `PATCH /api/tasks/:id {due_at}`. Toast "Snoozed to <when>".

### 3.5 Edit
- Pencil → `TaskFormDialog` prefilled → Save → `PATCH /api/tasks/:id {description?,owner_user_id?,due_at?}`.

### 3.6 Global Tasks page
- `GET /api/tasks` (role-scoped). Group by due bucket: **Overdue** (red), **Today**, **Tomorrow**,
  **This week**, **Later**, **No date**. Each row: parent-type chip + parent label + description + assignee
  + deadline; Done/Snooze inline. Click row (not the action buttons) → open parent card. Default filter:
  `status=open`, sorted `due_at` asc (nulls last). Mobile = date-grouped tiles (Jobs/Leads pattern).

---

## 4. Edge cases
1. Parent deleted → `ON DELETE CASCADE` removes its tasks (no orphan rows).
2. Assignee removed from company → `owner_user_id` stays (name shows "—"); task still actionable by
   managers. (`crm_users` row persists.)
3. Two parents supplied to create → 400 `MULTIPLE_PARENTS`. Zero parents → 400 `MISSING_PARENT`.
4. Unknown parentType / non-existent parent id in company → 404.
5. due_at in the past at create → allowed (immediately overdue/ highlighted).
6. Provider tries to view others' tasks (global list) → only own returned (no error). Provider PATCHes a
   task that isn't theirs → 403.
7. Cross-tenant id (PATCH/GET task from another company) → 404.
8. Complete an already-done task → idempotent (no-op, 200).
9. Custom snooze date in the past → allowed but warn (toast); still sets 08:00 of that day.
10. Estimate/Invoice with no `/:id` route before this feature → handled by the new routes; old links to
    `/estimates` (list) still work.

---

## 5. API contracts (all `authenticate, requireCompanyAccess`, company-scoped, `req.companyFilter.company_id`)

- `GET /api/tasks` — `requirePermission('tasks.view')`. Query: `status?`, `parent_type?`, `overdue?`,
  `due_from?`, `due_to?`, `assignee_id?` (managers only). Visibility: `tasks.manage` → all; else own.
  Resp: `{ ok:true, data:{ tasks:[{ id, parent_type, parent_id, parent_label, parent_path, description,
  status, due_at, owner_user_id, assignee_name, author_user_id, author_name, completed_at, created_at }] } }`.
- `GET /api/tasks/entity/:parentType/:parentId` — `requirePermission('tasks.view')`. Open + recently-done
  tasks for one parent (validates parent belongs to company → 404 else). Resp: `{ ok, data:{ tasks:[…] } }`.
- `POST /api/tasks` — `requirePermission('tasks.create')`. Body: `{ parent_type, parent_id, description,
  owner_user_id?, due_at? }`. Validates exactly-one parent + parent in company. Sets `author_user_id=me`,
  `owner_user_id = body.owner_user_id ?? me`. → `{ ok, data:{ task } }`.
- `PATCH /api/tasks/:id` — action rule (manage OR owner OR author). Body any of `{ description,
  owner_user_id, due_at, status }`. `status:'done'` sets `completed_at=now`; `'open'` clears it. → updated task.
- `DELETE /api/tasks/:id` — action rule. Soft? No — hard delete (tasks are lightweight). → `{ ok:true }`.

Errors: `401` no token · `403` lacks permission / not allowed to act · `404` foreign/unknown id ·
`400` validation (`MISSING_PARENT`, `MULTIPLE_PARENTS`, `INVALID_PARENT_TYPE`, `DESCRIPTION_REQUIRED`).

### Data isolation
Every SELECT/UPDATE/DELETE includes `AND company_id = $companyId`. Parent-existence checks join on
`company_id`. Foreign ids return 404, never another company's data.

---

## 6. Out of scope (v1)
Reminders/notifications (SMS/push/in-app/cron); recurring tasks; subtasks/checklists; task comments;
attachments on tasks; priority UI; bulk actions; calendar/schedule integration (`show_on_schedule` columns
exist but stay untouched); SSE live push (local optimistic refetch instead — SSE can be a fast-follow).
