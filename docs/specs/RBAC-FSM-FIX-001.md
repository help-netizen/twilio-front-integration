# RBAC-FSM-FIX-001 — role-model fixes + main-entity access audit

**Status:** implemented · **Type:** bug-fix (RBAC) · **Surface:** backend only.

## Trigger
A field technician (`provider` role) assigned to a job gets **403** on Start / En-route / change status, while Complete works. (The reporter `a5085140320@gmail.com` is actually a `tenant_admin` whose 403 was a separate **onboarding-race**: the account row existed ~40 s before the company's role configs were seeded → resolved to **0 perms** in that window; a clean re-login fixes their client. The real role-model bug is the `provider` role.)

## Root cause
`requirePermission(...keys)` is OR-semantics. `complete` is gated `('jobs.close','jobs.done_pending_approval')` — providers pass via `jobs.done_pending_approval`. But `start`/`enroute`/`status` (and the notes routes) were gated on `jobs.edit` only, which `provider` does **not** have. The handlers already scope to the assignee (`getProviderScope` → 404 if not your job), so the gate was the only block.

## Decisions (Step 0.5 — binding)
- Provider may, on **their own** job: Start, En-route, set operational status, mark Done (pending approval) **and add/edit/delete their own notes & photos**.
- Provider may **not** Cancel (dispatch decision) — cancel stays `jobs.close`.
- Fix the resolver **lockout bug** (admin baseline must apply even when the role config is momentarily missing).
- Full matrix audit of the main entities.

## Changes (backend, no migration)
1. `backend/src/routes/jobs.js`: `start`, `enroute`, `PATCH /:id/status`, and notes `POST`/`PATCH`/`DELETE /:id/notes` → `requirePermission('jobs.edit', 'jobs.done_pending_approval')`.
2. `PATCH /:id/status` inner closing-guard **split**: `Canceled` requires `jobs.close`; `Job is Done` allows `jobs.close` OR `jobs.done_pending_approval`. (Was: both allowed `done_pending` → a provider could cancel.) Data scoping unchanged (`getProviderScope`); note edit/delete still gated to the author by `notesMutationService`.
3. `backend/src/services/authorizationService.js` `resolveEffectivePermissionsAndScopes`: no longer early-returns `[]` when `roleConfig` is null — role perms default to `[]` but the **MANDATORY_ADMIN baseline still applies** for `tenant_admin`, so an admin is never locked out (fixes the onboarding-race 0-perms).
4. `backend/src/routes/fsm.js` `POST /:machineKey/apply` — the **parallel** manual-transition endpoint had the *old* un-split closing guard, so a `dispatcher` (`jobs.edit`+`jobs.done_pending_approval`, no `jobs.close`) could **Cancel via the FSM side-door**, contradicting the matrix (D = no Cancel). Mirrored the same split here (Cancel → `jobs.close`; Done → close OR done_pending). Found by the adversarial review; shipped together so the "Cancel stays `jobs.close`" invariant holds across **both** transition paths.

## Main-entity access matrix (after the fix)
Roles: **A**=tenant_admin, **M**=manager, **D**=dispatcher, **P**=provider. ✅=allowed, —=blocked (by design).

| Area / action | A | M | D | P | Notes |
|---|---|---|---|---|---|
| Jobs: view | ✅ | ✅ | ✅ | ✅ | P scoped to own (providerScope) |
| Jobs: create | ✅ | ✅ | ✅ | — | |
| Jobs: edit details / coords / location / tags | ✅ | ✅ | ✅ | — | dispatch/office work |
| Jobs: **start / enroute / status (operational)** | ✅ | ✅ | ✅ | ✅** | **fixed** (P, own job) |
| Jobs: mark **Done** (pending approval) | ✅ | ✅ | ✅ | ✅ | inner guard |
| Jobs: **Cancel** | ✅ | ✅ | — | — | `jobs.close` (A/M only) |
| Jobs: **notes add/edit/delete** (own) | ✅ | ✅ | ✅ | ✅** | **fixed** (P, own job + own note) |
| Jobs: reschedule / reassign | ✅ | ✅ | ✅ | — | `jobs.edit` / `schedule.dispatch` |
| Schedule: view | ✅ | ✅ | ✅ | ✅ | P own |
| Schedule: dispatch (reschedule/reassign/settings) | ✅ | ✅ | ✅ | — | |
| Tasks: view / create | ✅ | ✅ | ✅ | ✅ | |
| Tasks: edit/delete | ✅ | ✅ | ✅ | own | gate `tasks.view` + inner `canActOn` (own vs manage) — **verified correct** |
| Leads / Contacts | ✅ | ✅ | ✅ | by-phone only | P has `pulse.view` for call pop-ups; no list/edit |
| Estimates / Invoices / Payments | ✅ | per-perm | per-perm | — | office staff; P correctly excluded |

Dispatcher correctly lacks `jobs.close` (no Cancel) and all financial collect perms beyond its seed — by design. **No over-grants found.** The only false-403s were the provider FSM + notes gaps (fixed); everything else maps correctly.

## Tests (`tests/jobsRbacGates.test.js`, 9 green)
Provider passes Start/En-route/operational-status/Done; provider **blocked** on Cancel; view-only blocked on Start; a `jobs.close` holder can Cancel; resolver gives `tenant_admin` the baseline on a null config and `[]` for a non-admin. Regression: jobsStatusUpdate / jobsProviderScope / jobsService / scheduleRoute / scheduleReassign all green.

## Notes
- No client-side gating on the Start/notes buttons → providers already see them; backend-only fix suffices.
- No DB/seed change: providers already hold `jobs.done_pending_approval` (seed 050); the fix is purely the route gates + the resolver. Deploy = app rebuild (backend only; frontend bundle unchanged → no logout-all strictly needed).
