# TASKS-FORM-PANEL-001 — Task form as a right-side panel

**Type:** improvement (UI) · frontend-only · no backend / migration / RBAC / API change.
Builds on [TASKS-001](TASKS-001.md). Single component: `frontend/src/components/tasks/TaskFormDialog.tsx`.

## Decision (owner-confirmed)
- The task form must open as a **right-side slide-out panel** (`<DialogContent variant="panel">`), the same
  layer mechanic as estimate creation — **not** a centered modal.
- Applies to **both modes** of the (single) `TaskFormDialog` component: **create ("New task")** and
  **edit (pencil)** — "обе задачи".
- Fields adopt the **FORM-CANON floating-label** style (`FloatingField` / `FloatingSelect` /
  `FloatingLabel`), matching estimate/lead/job forms.
- Standard panel width (`--blanc-layer-width`, the dialog's default panel size).

## Behavior (unchanged from TASKS-001 — only the presentation changes)
- Header: "New task" (create) / "Edit task" (edit).
- Body fields:
  - **Description** — `FloatingField` textarea, required (Save disabled while empty).
  - **Assignee** — `FloatingSelect` (Unassigned + company users from `GET /api/tasks/assignees`); a new
    task defaults to the current user (matched by email); empty → server self-assigns / unassigns on edit.
  - **Deadline** — date + time, each wrapped in `FloatingLabel` (`filled` keyed to the value so the label
    floats correctly for native date/time inputs); time disabled until a date is set. Combined to an ISO
    `due_at` in company TZ on save (existing `localPartsToIso`).
- Footer (sticky `DialogPanelFooter`): **Delete** (edit mode only, left, red) · **Cancel** · **Save /
  Add task** (right).
- All existing logic kept verbatim: prefill on open, lazy-load assignees, optimistic `onSaved`/`onDeleted`,
  sonner toasts, `createTask`/`updateTask`/`deleteTask`/`listAssignees`. No prop/contract change — callers
  (`TaskStack` create + edit instances) are untouched.

## Edge cases
- Mobile: `variant="panel"` already renders as a bottom-sheet on `<md` (shared dialog behavior) — no extra work.
- Required-description guard, invalid/empty deadline (date cleared → no deadline), delete confirm — all as
  in TASKS-001.

## Out of scope
Any change to the in-card stack, the global Tasks page, the backend, or the task data model.

## Verify
`npm run build` (tsc -b strict) green; dev-preview the panel (create + edit) renders as a right-side layer
with floating-label fields, Save/Cancel/Delete work; no console errors. No Jest (frontend has no component
harness; logic unchanged so backend `tasks.test.js` still 23/23).
