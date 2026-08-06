# FSM-JOB-ACTIONS-001 — job status action buttons driven by the per-company FSM

**Status:** approved (owner, 2026-08), implementation not started
**Owner backlog:** OB-55
**Tandem:** Claude = design + FE (Phases 2–3) + gates + this spec; Codex = backend (Phase 1) + tests

---

## 1. Problem & diagnosis (confirmed in code)

A job carries **two independent status axes**:

- **`blanc_status`** (`jobs.blanc_status`, migration `031`) — the *workflow* status: `Submitted, Waiting for parts, Part arrived, Follow Up with Client, Visit completed, Job is Done, Rescheduled, Canceled, On the way`. **Already FSM-driven end to end:**
  - The status dropdown (`frontend/src/components/jobs/JobDetailHeader.tsx:36-49`) lists reachable statuses from `GET /api/fsm/job/actions?state=<blanc_status>` via `useFsmActions` (`frontend/src/hooks/useFsmActions.ts`).
  - Every write goes through `PATCH /api/jobs/:id/status` → `jobsService.updateBlancStatus` (`backend/src/services/jobsService.js:1267`), which calls `fsmService.resolveTransition(companyId,'job',from,to)` (`:1280`) and rejects invalid transitions. The published per-company SCXML in `fsm_versions` is authoritative at runtime (see migration `127`). Hardcoded `ALLOWED_TRANSITIONS` (`jobsService.js:53-66`) is a **fallback only** when a company has no published graph.

- **`zb_status`** (`jobs.zb_status`) — an *operational* substatus (`scheduled → en-route → in-progress → complete`) that mirrored **Zenbooker**. **NOT FSM-driven.** The big action buttons "On the way / Start job / Complete job" (`frontend/src/components/jobs/JobStatusTags.tsx:135-173`, `JobOpsSection`) are gated on literal `job.zb_status` conditionals and fire dedicated endpoints `POST /api/jobs/:id/enroute|start|complete` (`jobsService.js:1806/1850/1894`) that set `zb_status` and bypass the FSM. The SCXML models **only** `blanc_status`; `zb_status` states are absent from it.

**Result (the OB-55 bug):** the *displayed* status is `blanc_status` (FSM) but the *big buttons* follow `zb_status` (hardcoded). They diverge → job 1634 shows status "On the way" **and** an "On the way" button; job 1545 in en-route can't be completed directly (needs zb `in-progress`); the FSM graph has no edges named "Start job / Complete job" because those buttons never came from the FSM.

## 2. Decision

1. **The big action buttons become FSM-driven** — rendered from the company's published `job` SCXML action-transitions (same source as the dropdown), applied through the FSM path. *What the owner draws is what appears.*
2. **Zenbooker is being removed** (owner, separate work) — so there is **no Zenbooker round-trip to preserve**. The `zb_status` axis is deprecated; `blanc_status` becomes the single job status.
3. The only operational side effect that remains is **customer notifications** (the "On the way" ETA SMS). Modeled as an optional per-transition hook, not a status axis.

## 3. Schema — SCXML transition attributes

Existing (parsed today in `fsmService.js:68-77`, keep as-is): `blanc:action` (bool), `blanc:label`, `blanc:icon`, `blanc:confirm` + `blanc:confirmText`, `blanc:roles` (csv), `blanc:order` (number), `blanc:hotkey`.

**New attributes (add to the parser + `getAvailableActions` output):**

| attr | type | meaning | default |
|---|---|---|---|
| `blanc:button` | bool | render this action as a prominent BUTTON (vs dropdown-only) | *unset → see §4 default* |
| `blanc:variant` | `primary` \| `secondary` \| `success` \| `danger` \| `neutral` | button visual weight/colour | *unset → see §4 default* |
| `blanc:op` | string enum: `notify_on_the_way` (extensible) | side-effect hook fired when the transition applies | none → pure status change |

`blanc:label`/`blanc:icon`/`blanc:order`/`blanc:confirm` already cover label/icon/order/confirm — reuse them, do **not** duplicate.

## 4. Default logic (when not configured manually)

Applied per current state's **actionable** transitions (`blanc:action===true`, already role-filtered + order-sorted by `getAvailableActions`):

**Which are buttons** (`blanc:button` unset):
- **Default = every actionable transition renders as a button.** ("What you draw is what you see.") Manually setting `blanc:button="false"` demotes a transition to dropdown-only.

**Variant** (`blanc:variant` unset):
- If the state has **exactly one** actionable transition → that button is **`primary`**.
- If **2+** → the lowest-`order` transition is **`primary`**, the rest **`secondary`** (outline).
- `Canceled`-targeting transitions default to **`danger`**; `Job is Done`/final-targeting default to **`success`**. (Name/`isFinal`-based, cheap; manual `blanc:variant` always wins.)

**Op** (`blanc:op` unset): none → the transition only changes `blanc_status`.

**No published graph / no actionable transitions:** fall back to the existing hardcoded `ALLOWED_TRANSITIONS` reachable set rendered as neutral buttons (status change only) — i.e. the app still works for a company that never touched the editor.

## 5. Backend — Phase 1 (Codex)

1. **Parser:** in `fsmService.parseTransition` add `button`, `variant`, `op` (parse `@_blanc:button` bool, `@_blanc:variant` string, `@_blanc:op` string).
2. **Actions API:** `getAvailableActions` (`fsmService.js:686`) — include `button`, `variant`, `op` in each returned item; apply the §4 defaults server-side (compute effective `button`/`variant` so the FE needs no heuristics). `GET /api/fsm/:machineKey/actions` (`routes/fsm.js:347`) passes them through.
3. **Apply path with side effects:** make `POST /api/fsm/:machineKey/apply` (`routes/fsm.js:218`, currently only used by the dead `ActionsBlock.tsx`) the canonical human apply path. In one transaction: `resolveTransition` → `updateBlancStatus(targetStatusName)` → if the resolved transition has `blanc:op`, run the hook (`notify_on_the_way` = the existing ETA-SMS flow used by `ONWAY`/`OnTheWayModal`; factor that send out of the old `/enroute` path). Keep the closing-permission gate + role checks.
4. **Seed migration** (next free number on `origin/master` — check the race, both ends on renumber): patch the default `job` SCXML so the operational forward transitions become annotated action-buttons, and mark the "On the way" transition `blanc:op="notify_on_the_way"` so existing companies keep the ETA SMS. Idempotent; per-company published graphs are untouched (authoritative).
5. **Deprecate `zb_status`:** stop writing `zb_status` from status changes; leave the column for now (drop in a later cleanup). `markEnroute/markInProgress/markComplete` + the `/enroute|start|complete` routes become dead once the FE stops calling them (remove in Phase 4).
6. **Tests:** parser (new attrs + defaults), `getAvailableActions` effective button/variant, apply-path applies status + fires `op`, invalid transition rejected, no-graph fallback, RBAC/closing-permission preserved.

## 6. Frontend — Phase 2 (Claude)

1. `JobStatusTags.tsx` / `JobOpsSection`: replace the hardcoded `zb_status` buttons with buttons rendered from `useFsmActions('job', job.blanc_status)` where `button===true`, styled by `variant` (map to the existing button colours), label/icon from the action, sorted by `order`.
2. Apply via the FSM path (`useApplyTransition` → `POST /api/fsm/job/apply`) instead of `markEnroute/markInProgress/markComplete`.
3. `blanc:op==='notify_on_the_way'` → open the existing `OnTheWayModal` as the confirm/ETA step, then apply.
4. Remove `ONWAY_SOURCE_STATUSES` + the `zb_status` conditionals + `markEnroute/Start/Complete` calls. The status dropdown (already FSM-driven) stays; buttons are the promoted (`button===true`) subset.

## 7. Editor — Phase 3 (Claude)

Add a **transition inspector** to `WorkflowBuilderPage.tsx` (the edge is already selectable — FSM-EDGE-LABEL work): when an edge is selected, let the owner set `blanc:action`, `blanc:button`, `blanc:variant` (colour), `blanc:label`, `blanc:icon`, `blanc:op`, `blanc:order`. Writes into the SCXML via the existing draft/publish flow. Unset fields fall back to §4 defaults at render time.

## 8. Cleanup — Phase 4

Remove the dead `frontend/src/components/workflows/ActionsBlock.tsx` (never mounted) once `/apply` is wired to the job UI; remove `/enroute|start|complete` routes + `markEnroute/markInProgress/markComplete` + `ONWAY_SOURCE_STATUSES`; plan a migration to drop `jobs.zb_status` after Zenbooker removal lands.

## 9. Verification

- **Repro fixed:** a job whose `blanc_status` is "On the way" shows the buttons drawn from *that* state's outgoing edges — no phantom "On the way" button, and "Complete"-type action present iff the graph has that edge from "On the way".
- **Owner-drawn graph honoured:** publishing a `job` graph with a new action edge makes a matching button appear; removing an edge removes the button; `blanc:variant`/`blanc:label` reflected.
- **Default logic:** a graph with only `blanc:action` (no `button`/`variant`) renders every action as a button, primary/secondary by the §4 rules.
- **Side effect:** the "On the way" action still sends the ETA SMS (via `blanc:op`), and only that one.
- **No-graph company:** falls back to the hardcoded reachable set as neutral buttons; nothing throws.
- **RBAC / closing-permission** gates unchanged. Backend rejects an out-of-graph transition (sabotage check: SAB-FSM-BYPASS — a FE-forged event not in the graph → 4xx, status unchanged).
- Frontend build green; `npx vitest run` green (worktree form); backend tests green.

## 10. Risks

- **Per-company custom graphs** already published won't have the new attributes → §4 defaults + no-graph fallback must degrade gracefully (status-only buttons). Covered.
- **Renumber race** on the seed migration (parallel sessions) — check `origin/master`, fix both the file number and any name references.
- **Deprecating `zb_status`** must not break filters/reporting mid-flight — Jobs filters already use `useFsmStates`; audit any `zb_status` reads before Phase 4 drop.
- Zenbooker removal is concurrent owner work — coordinate so Phase 1 doesn't reintroduce a Zenbooker call.

## 11. Deploy

Standard prod runbook when the owner says «да». The seed migration applies before the image (per-file `ON_ERROR_STOP`); `logout-all` after (bundle hash changes).
