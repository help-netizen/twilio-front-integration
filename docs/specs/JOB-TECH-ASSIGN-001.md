# JOB-TECH-ASSIGN-001 — Reassign technician from the Job card (no reschedule)

**Status:** in progress · **Type:** improvement · **Surface:** frontend-only (reuses existing backend) · **Desktop + mobile job-detail card.**

## Problem
In the Job detail card the assigned technician is **read-only**. The only way to change it is the **Reschedule** flow, which also moves the appointment time. Dispatchers need to change/assign/unassign the technician **without** touching the schedule.

## Decisions (Step 0.5 interview — binding)
1. **UX:** a small **"Change" button** next to the technician → a **Popover** with a **searchable list** of technicians + an **Unassign** row. (Not inline auto-apply.)
2. **Unassign requires confirmation** — inline "Remove [tech] from this job?" → Remove / Cancel.
3. **Only in the open job-detail card** (renders on desktop + mobile); **not** on Jobs list tiles.
4. Reuse the existing reassign endpoint (no time change); permission = the endpoint's (`schedule.dispatch`).
5. Optimistic update + parent refresh; **local-only** (no Zenbooker tech push — same as the Schedule page's drag-reassign).

## Backend (reused endpoint, with two correctness fixes)
`PATCH /api/schedule/items/job/:id/reassign` (`backend/src/routes/schedule.js`), `requirePermission('schedule.dispatch')`, body `{ assignee_id: string|null, assignee_name?: string|null }` → `scheduleService.reassignItem(companyId,'job',id,assigneeId,assigneeName)` → `scheduleQueries.reassignJob`, recalcs route legs (`recalcAfterJobChange`), **does not change `start_at`/`end_at`**, local-only (no Zenbooker tech push — consistent with the existing schedule reassign).

**Two bugs in the reused path had to be fixed (they also affected the Schedule drag-reassign, just invisibly):**
1. `reassignJob` did `assigned_techs = COALESCE(...) || $3` — it **appended** (and stored only `{id}`, nameless). Changed to **replace**: `SET assigned_techs = $3::jsonb` with `[{id,name}]`, or `[]` to unassign. The name is now threaded through `reassignItem`/the route/`scheduleApi.reassignItem(…, assigneeName)` and `useScheduleData.handleReassign` so chips render named after a refresh.
2. The route rejected `assignee_id: null` (`if (!assignee_id) → 400`), so **Unassign was impossible**. Changed to `if (assignee_id === undefined)` — `null` is the explicit unassign sentinel.
Tests: `tests/scheduleReassign.test.js` (replace/null/name) + updated `tests/scheduleRoute.test.js` (name threading, null→200, missing→400).

## Frontend
- **New `hooks/useProviders.ts`** — `GET /api/zenbooker/team-members` → `ProviderInfo[] {id,name}` + `loading`; best-effort (error → `[]`). (Same source `useScheduleData` uses; the endpoint is dispatch-scoped.)
- **New `components/jobs/JobTechnicianControl.tsx`** — props `{ job: LocalJob, onJobUpdated?: (j: LocalJob) => void }`:
  - Renders the current tech name (`job.assigned_techs?.[0]`) or **"Unassigned"**.
  - A **"Change"** button (Pencil), shown only when `useAuthz().hasPermission('schedule.dispatch')`.
  - Click → **Popover** (`ui/popover`) containing a **Command** (`ui/command`) searchable list of `providers`; the current tech is checkmarked. Selecting a provider → `doReassign(id, name)`.
  - If currently assigned, an **Unassign** row at the bottom → inline confirm ("Remove [name]?") → `doReassign(null)`.
  - `doReassign(id, name)`: `busy=true` → `reassignItem('job', job.id, id)` → on success `toast.success` + `onJobUpdated?.({ ...job, assigned_techs: id ? [{id,name}] : [] })` (optimistic; parent `applyJobUpdate` re-renders) + close popover; on error `toast.error` + leave unchanged; `finally busy=false`.
- **Modify `components/jobs/JobInfoSections.tsx`** — replace the read-only "Providers" block (only-rendered-when-techs-exist) with `<JobTechnicianControl job={job} onJobUpdated={onJobUpdated} />`, **always rendered** in the schedule card (so an unassigned job can be assigned). No other change; reschedule path untouched.

## Behavior / edge cases
- **Unassigned job** → control shows "Unassigned" + Change (Assign). 
- **No permission** → control shows the tech name read-only (no Change button) — non-dispatchers see who's assigned but can't change it.
- **Same tech reselected** → no-op (or a harmless reassign); close popover.
- **Many techs** → Command search filters by name.
- **Error** (403/network) → toast, current tech unchanged.
- **Time is never sent** — only `assignee_id`. The appointment window is untouched (the whole point).
- **Schedule view** updates via the existing realtime/refresh path (best-effort, unchanged).

## Out of scope
- Multi-tech assignment (single replace — matches the reassign API). Zenbooker tech push. Quick-reassign on Jobs list tiles. Reassign for leads/tasks from their cards.

## Tests
No frontend test runner in this repo → verified by `npm run build` (tsc -b strict, `noUnusedLocals`) + independent review. The reused backend endpoint already has schedule reassign coverage. Pure helper logic (if any) is trivial.
