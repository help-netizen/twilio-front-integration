# OUTBOUND-PARTS-CALL-BTN-001 — Test cases

## Coverage
- Backend (jest): 4 | Frontend (manual / logic-review — no frontend test runner): 5 | Build: 1
- P0: 4 | P1: 3 | P2: 2 | P3: 1

---

### TC-BTN-01 (P0, Unit/jest) — SELECT_TASK returns `actions`
- **Scenario:** S-BTN-1 / AC-BTN-1.
- **Steps:** with a company-scoped task carrying `actions=[robot_call,manual_call]`, call
  `getTaskById(companyId, id)` and `listEntityTasks(companyId, {parentType:'job', parentId})`.
- **Expected:** each returned row has `actions` = the 2-item array; a task with no actions →
  `actions` null. Queries still company-scoped.
- **File:** `tests/tasksActionsProjection.test.js` (new) or extend `tests/routes/tasks.test.js`.

### TC-BTN-02 (P0, Unit/jest) — Pulse open_task carries `actions`
- **Scenario:** S-BTN-4 / AC-BTN-3.
- **Steps:** exercise the by-contact assembly (`calls.js` open_task mapping) with a row whose
  `open_task_actions` is set.
- **Expected:** the assembled `open_task.actions` equals the array; absent → null; the by-contact
  WHERE/ORDER BY/params are byte-unchanged.
- **File:** extend the existing pulse by-contact route test, or a focused mapping test.

### TC-BTN-03 (P0, Integration/jest) — execute route still gated + typed (regression)
- **Scenario:** protected contract.
- **Steps:** `POST /api/tasks/:id/actions/robot_call` (manager); `.../unknown` (→400); foreign id
  (→404); caller without `tasks.manage` (→403).
- **Expected:** existing `tests/tasksActionRoute.test.js` stays 100% green (route unchanged).
- **File:** `tests/tasksActionRoute.test.js` (existing).

### TC-BTN-04 (P0, Unit/jest) — existing task suites green (additive column)
- **Steps:** run `tests/tasksCount.test.js`, `tests/routes/tasks.test.js`, `tests/db/crmQueries.test.js`.
- **Expected:** adding `t.actions` / `open_task_actions` breaks no assertion (additive projection).
- **File:** existing suites.

### TC-BTN-05 (P1, Frontend logic-review) — 🤖 robot_call confirm gate
- **Scenario:** S-BTN-2.
- **Expected:** clicking 🤖 fires `window.confirm('Start automated call to the customer?')`; confirm
  → POST + spinner + toast + `onChanged`; cancel → no POST / spinner / state change.
- **File:** manual / code-review of `TaskActionButtons.tsx`.

### TC-BTN-06 (P1, Frontend logic-review) — 📞 manual_call has NO confirm
- **Scenario:** S-BTN-3.
- **Expected:** clicking 📞 POSTs with no confirm → desktop `openDialer`, mobile `tel:`;
  `phone:null` → toast "No reachable number"; no refetch.
- **File:** manual / code-review of `TaskActionButtons.tsx`.

### TC-BTN-07 (P1, Frontend logic-review) — manage-gate hides buttons on both surfaces
- **Scenario:** edge 1/2, AC-BTN-4.
- **Expected:** `hasPermission('tasks.manage')===false` → `TaskActionButtons` renders nothing on the
  Job card AND the Pulse AR banner; Done/Snooze/Edit visibility unchanged.
- **File:** manual / code-review of `TaskActionButtons.tsx` + `PulsePage.tsx`.

### TC-BTN-08 (P2, Frontend logic-review) — failed-reason surfaces after refetch
- **Scenario:** S-BTN-5.
- **Expected:** an action with `state:'failed'`+`reason` renders the reason under the button (both
  surfaces).
- **File:** manual / code-review.

### TC-BTN-09 (P2, Frontend logic-review) — Pulse AR wiring + snoozed hide
- **Scenario:** S-BTN-4, edge 6.
- **Expected:** buttons render inside the `!isSnoozed` AR block only; a snoozed thread → buttons
  hidden; `onChanged=p.refetchContacts`.
- **File:** manual / code-review of `PulsePage.tsx`.

### TC-BTN-10 (P3, Build) — frontend build green
- **Steps:** `cd frontend && npm run build`.
- **Expected:** exit 0; `TaskActionButtons` typed; `PulseTask.actions?: TaskAction[]`; no
  noUnusedLocals error.
- **File:** build.

---

## Regression / Protected (must stay green)
- **TC-BTN-R1 (P0):** `taskActions/registry.js` + execute route unchanged — `tasksActionRoute.test.js` green.
- **TC-BTN-R2 (P1):** `tasks.actions` stays additive/nullable — TASKS-COUNT-BADGE / AR-TASK-UNIFY
  queries (`tasksCount.test.js`) unaffected.
- **TC-BTN-R3 (P1):** Pulse by-contact pagination (LIST-PAGINATION-001) — only additive SELECT
  columns; WHERE/ORDER/params identical; cross-tenant isolation preserved.
- **TC-BTN-R4 (P2):** softphone canon — `openDialer(phone, contactName?)` signature and desktop-only
  rule (MOBILE-NO-SOFTPHONE-001) unchanged.
