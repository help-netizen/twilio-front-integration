# Test Cases — TASKS-COUNT-BADGE-001

"Open tasks" counter badge in navigation (RBAC-scoped clone of LEADS-NEW-BADGE-001).

- **Backend unit** = Jest, DB mocked (`tests/routes/tasks.test.js` style: `jest.mock('../../backend/src/db/connection')`, real `tasksQueries`/route behind stub auth). New file `tests/tasksCount.test.js` (+ additions to `tests/routes/tasks.test.js` for the route/emit branches).
- **Integration** = REAL local Postgres, no mocks: `scripts/verify-tasks-count-001.js` (self-seeding / self-cleaning, unique tag `TCB1`, mirrors `scripts/verify-email-outbound-001.js`). `DATABASE_URL` defaults to `postgresql://localhost/twilio_calls`; never point at prod. Exit 0 only when every case passes.
- **Frontend** = manual / build-check (no FE test harness).
- **HOUSE LESSON (LIST-PAGINATION-001):** mocked Jest asserts the SQL string / call-shape only; the load-bearing count==list invariant (S9 / AC-1..AC-3) MUST be proven by the real-DB script, not mocks.

Spec scenarios: S1..S9 = requirements "User scenarios" 1..9. S10 = tenancy (AC-6). Emit-provenance case is folded into S8 (`HAS_ENTITY_PARENT`-excluded, `system`-provenance).

## Coverage

- **Total:** 41 — **P0:** 12 · **P1:** 16 · **P2:** 9 · **P3:** 4
- **Unit (Jest):** 21 · **Integration (real DB):** 14 · **Frontend (manual/build):** 6
- Every spec scenario S1–S10 covered; positive + negative per scenario; middleware 401/403 + cross-tenant isolation included.

---

## P0 — load-bearing invariant, security, core visibility

| ID | Type | Scenario | Preconditions / Input | Expected | Test file |
|----|------|----------|-----------------------|----------|-----------|
| **TC-1** | Integration | **S9 INVARIANT (THE load-bearing test)** — `countTasks(company, filters) === listTasks(company, filters).length` for `{status:'open', scopeOwnerId?}` across ≥4 seed states: (a) empty, (b) manager all-open, (c) provider own-open, (d) mixed open+done+cross-parent | Seed each state tagged `TCB1`; run BOTH real functions with the identical `filters` object | For every state, the two are exactly equal. This is the AC-1..AC-3 guarantee: **count can never exceed / differ from the list** | `scripts/verify-tasks-count-001.js` |
| **TC-2** | Unit | **Anti-drift guard** — `buildTaskListFilters(companyId, filters)` is the single shared builder; `listTasks` and `countTasks` both call it | Call `buildTaskListFilters` directly with a fixed `filters` (status+scopeOwnerId+assignee+parent_type+overdue+due_from+due_to); also spy the builder to confirm both `listTasks` and `countTasks` invoke it | Returns `{conditions[], params[]}`; `conditions[0]='t.company_id = $1'`, `conditions[1]=HAS_ENTITY_PARENT`; same `$n` numbering / same param order for the same input regardless of caller. Both callers produce **identical** `conditions.join(' AND ')` + `params` | `tests/tasksCount.test.js` |
| **TC-3** | Unit | `countTasks` SQL shape — `COUNT(*)` over bare `tasks t`, no `SELECT_TASK` join block | `countTasks('c1', {status:'open'})` with mocked db returning `[{count:5}]` | SQL matches `/SELECT COUNT\(\*\)::int AS count FROM tasks t WHERE/`; contains `t.company_id = $1`, `HAS_ENTITY_PARENT`, `t.status`; does **NOT** contain `LEFT JOIN` / `crm_users ow` / `parent_label`; returns `5` | `tests/tasksCount.test.js` |
| **TC-4** | Unit | `countTasks(null)` — no cross-tenant default | call with `companyId` null/undefined | Throws (`requireCompanyId`), NO query issued | `tests/tasksCount.test.js` |
| **TC-5** | Unit | Route `GET /api/tasks/count` happy path envelope | manager session; mocked db → `[{count:7}]` | 200, body `{ ok:true, data:{ count:7 } }` (exact envelope) | `tests/routes/tasks.test.js` |
| **TC-6** | Unit | Route gating — no `tasks.view` → 403, no query | session perms `['jobs.view']` | 403; `mockQuery` not called | `tests/routes/tasks.test.js` |
| **TC-7** | Unit | Route gating — 401 without auth | (documented: real `authenticate` at mount; suite asserts 403-path, 401 enforced in prod like the rest of `tasks.test.js`) | Unauthenticated request rejected before the handler; count never computed | `tests/routes/tasks.test.js` (note) |
| **TC-8** | Unit | **Manager vs non-manager scope branch** — `scopeOwnerId` set ONLY when `!canManage` | (a) manager (`tasks.manage`): assert `countTasks` called with filters **without** `scopeOwnerId`; (b) provider (`tasks.view` only): filters include `scopeOwnerId = actorId(req)` (= `req.user.crmUser.id`) | (a) count SQL has NO `t.owner_user_id = $` predicate; (b) count SQL has `t.owner_user_id = $2` bound to `ME` (crmUser.id, never `sub`) | `tests/routes/tasks.test.js` |
| **TC-9** | Integration | **S2 — provider counts only own** | Seed company A: 3 open tasks owned by ME + 2 open owned by OTHER (all entity-parented, tagged) | `countTasks(A,{status:'open',scopeOwnerId:ME})` = 3; OTHER's 2 never contribute | `scripts/verify-tasks-count-001.js` |
| **TC-10** | Integration | **S10 / AC-6 SECURITY — cross-tenant isolation** | Seed company B with N open entity-parented tasks (some owned by a company-A user id reused as owner value); run count for a company-A user | Company-A manager count and company-A user count **exclude** all company-B rows entirely (`t.company_id = $1` gate). Company B's open tasks contribute **0** to any company-A badge | `scripts/verify-tasks-count-001.js` |
| **TC-11** | Integration | **S8 — `HAS_ENTITY_PARENT`-excluded task counted by NEITHER** | Seed a `system`-provenance timeline-only task (`created_by='system'`, `thread_id` set, no job/lead/estimate/invoice/contact_id, `status='open'`) | It appears in **neither** `listTasks({status:'open'})` **nor** `countTasks({status:'open'})` (excluded by `HAS_ENTITY_PARENT`, which only admits `thread_id` tasks with `created_by IN ('user','agent')`). Count == list still holds | `scripts/verify-tasks-count-001.js` |
| **TC-12** | Unit | `emitTaskChange` payload is EXACTLY `{ company_id }` (PII-free) | call `emitTaskChange('c1')` with `realtimeService.broadcast` spied | broadcast called once with `('task.changed', { company_id:'c1' })` — no `owner_user_id`, `id`, `status`, name, phone, or email in the payload | `tests/tasksCount.test.js` |

---

## P1 — deltas, emit sites, alternate flows, freshness

| ID | Type | Scenario | Preconditions / Input | Expected | Test file |
|----|------|----------|-----------------------|----------|-----------|
| **TC-13** | Integration | **S1 — manager counts all** | Seed company A: open tasks owned by several users + entity parents of each type | `countTasks(A,{status:'open'})` (no `scopeOwnerId`) == total open entity-parented rows == `listTasks(A,{status:'open'}).length` | `scripts/verify-tasks-count-001.js` |
| **TC-14** | Integration | **S3 — create → +1 delta** | Baseline count C for user U; `createTask` a new open entity-parented task visible to U | new count == C+1 for U (and for the manager) | `scripts/verify-tasks-count-001.js` |
| **TC-15** | Integration | **S4 — complete → −1 delta** | Baseline C with an open task T visible to U; `updateTask(T,{status:'done'})` | new count == C−1 for U; done task drops from both list and count | `scripts/verify-tasks-count-001.js` |
| **TC-16** | Integration | **S5 — reopen → +1 delta** | A `done` task T (visible to U); `updateTask(T,{status:'open'})` | new count == C+1 for U; `completed_at` cleared, row re-enters list+count | `scripts/verify-tasks-count-001.js` |
| **TC-17** | Integration | **S6 — reassign moves between owners** | Open task T owned by U1; `updateTask(T,{owner_user_id:U2})` | U1 scoped count −1, U2 scoped count +1; **manager (company-wide) count unchanged** (still one open company task) | `scripts/verify-tasks-count-001.js` |
| **TC-18** | Integration | **S7 — due-only edit, NO delta** | Open task T; `updateTask(T,{due_at:<new>})` (no status/owner change) | count unchanged for every audience (due date is not in the predicate) | `scripts/verify-tasks-count-001.js` |
| **TC-19** | Unit | **PATCH emits only on status|owner change** | mocked PATCH: (a) `{status:'done'}` → emit; (b) `{owner_user_id:X}` → emit; (c) `{due_at:...}` only → NO emit; (d) `{description:'x'}` only → NO emit | `emitTaskChange` called for (a),(b); NOT called for (c),(d). One emit per PATCH max (no double-emit when both status+owner present) | `tests/routes/tasks.test.js` |
| **TC-20** | Unit | **POST create emits** | mocked successful `POST /` create (parentExists→ok, INSERT→id, getTaskById→row) | `emitTaskChange(companyId)` called once after create, before `res` | `tests/routes/tasks.test.js` |
| **TC-21** | Unit | **DELETE emits** | mocked successful `DELETE /:id` (getTaskById→owned row, DELETE→rowCount 1) | `emitTaskChange(companyId)` called once | `tests/routes/tasks.test.js` |
| **TC-22** | Unit | **`timelinesQueries.createTask` emits ONLY on NEW-INSERT for provenance `user`|`agent`** | mocked: (a) fresh insert, `createdBy='user'` → emit; (b) fresh insert, `createdBy='agent'` → emit; (c) `createdBy='system'` new insert → NO emit; (d) AUTO-provenance UPSERT-update branch (existing open task found) → NO emit | emit for (a),(b) only. `system`/`automation` never emit; the UPSERT-update branch never emits (updating an existing open task doesn't change the count) | `tests/tasksCount.test.js` |
| **TC-23** | Unit | **Route order** — `/count` resolves to the count handler, not `:id` | request `GET /api/tasks/count` | Hits the count handler (200 `{data:{count}}`), NOT parsed as `PATCH/DELETE '/:id'`-style `id='count'`; mounted in the static-segment cluster above `/:id` param routes | `tests/routes/tasks.test.js` |
| **TC-24** | Unit | Manager may pass `?assignee_id` to scope the count | manager session, `GET /api/tasks/count?assignee_id=U2` | `countTasks` filters include `assignee_id:U2` → SQL adds `t.owner_user_id = $n` = U2; non-manager query param is ignored (own scope already forced) | `tests/routes/tasks.test.js` |
| **TC-25** | Unit | `eventCatalog` lists `task.changed` with `sample_fields:['company_id']` only | require `eventCatalog.js` | entry `{ key:'task.changed', label:'Open-task count changed', sample_fields:['company_id'] }` present; no PII fields advertised | `tests/tasksCount.test.js` |
| **TC-26** | Frontend | **S8/AC-5 markup — badge on `tasks` nav, desktop + mobile** | build with `openTasksCount>0` | `pulse-unread-badge` span renders on the `tasks` item in BOTH `AppNavTabs` (desktop) and `BottomNavBar` (mobile); `title="{n} open tasks"`; identical class/markup to Pulse/Leads badges | manual + `cd frontend && tsc -b` |
| **TC-27** | Frontend | **S7/AC-5 — hidden at 0** | `openTasksCount === 0` | badge NOT rendered (no "0" circle) on either surface | manual |
| **TC-28** | Frontend | **AC-5 — `9+` cap** | `openTasksCount = 15` | renders `9+` (desktop + mobile), matching Pulse/Leads exactly | manual |

---

## P2 — freshness recipe, boundary counts, envelope

| ID | Type | Scenario | Preconditions / Input | Expected | Test file |
|----|------|----------|-----------------------|----------|-----------|
| **TC-29** | Frontend | **FR-4 freshness** — fetch on mount + on route change + 60s poll | navigate between routes; wait past 60s | `fetchOpenTasksCount` fires on mount, on each `location.pathname` change, and on the 60s interval (verbatim clone of `fetchLeadsNewCount`) | manual (network tab) |
| **TC-30** | Frontend | **FR-4 SSE refetch filtered by company** — `task.changed` triggers refetch only for own company | dispatch `task.changed` with `{company_id: own}` then `{company_id: other}` | refetch on own-company event; ignored for a foreign `company_id`. `'task.changed'` present in BOTH `useRealtimeEvents.ts` `genericEventTypes` AND `sseManager.ts` `namedEvents` (a name in one only is silently dead) | manual + grep both files |
| **TC-31** | Frontend | **S9 — opening `/tasks` does NOT clear the badge** | navigate to `/tasks` | badge value unchanged by viewing (state-derived, not a read-marker); only underlying open-task changes move it | manual |
| **TC-32** | Integration | **S9 delta chain end-to-end** — create → complete → reopen → reassign, re-asserting count==list after EACH step | run the full mutation sequence on tagged fixtures, asserting the invariant at every step | count==list holds at every step; deltas match TC-14..TC-17 | `scripts/verify-tasks-count-001.js` |
| **TC-33** | Integration | Boundary — count exactly 9 vs 10 (`9+` source value) | seed 9 open for U, then 10 | count returns literal `9` then `10` (the `9+` cap is a render concern; the API returns the true integer) | `scripts/verify-tasks-count-001.js` |
| **TC-34** | Integration | Zero — user with no visible open tasks | seed 0 open for U (only done / only OTHER's) | `countTasks` = 0; matches `listTasks(...).length` = 0 | `scripts/verify-tasks-count-001.js` |
| **TC-35** | Integration | Mixed parent types all counted | seed one open task per entity parent (job/lead/estimate/invoice/contact) + one `user` timeline task | all N counted; `agent` timeline task also counted; `system` timeline task excluded (ties to TC-11) | `scripts/verify-tasks-count-001.js` |
| **TC-36** | Unit | `listTasks` behavior byte-identical after the `buildTaskListFilters` extraction | run existing `tests/routes/tasks.test.js` GET-list suite (manager/provider/status) | all pre-existing list assertions stay green (same conditions, same `$n`, same ORDER BY / LIMIT-OFFSET) | `tests/routes/tasks.test.js` (regression) |
| **TC-37** | Unit | `emitTaskChange` best-effort — broadcast throw never breaks the write | spy `realtimeService.broadcast` to throw; run a create/PATCH | handler still returns success (200/201); error swallowed + `console.warn`, task write committed | `tests/tasksCount.test.js` |

---

## P3 — edge / rare

| ID | Type | Scenario | Preconditions / Input | Expected | Test file |
|----|------|----------|-----------------------|----------|-----------|
| **TC-38** | Unit | `emitTaskChange` with no companyId → no broadcast | `emitTaskChange(null)` / `undefined` | early return, `broadcast` not called | `tests/tasksCount.test.js` |
| **TC-39** | Integration | Reassign to a manager who already counts it company-wide | manager M's company count = C; reassign a task from U to M | M's company-wide count still C (already counted); U's scoped count −1 (S6 corner) | `scripts/verify-tasks-count-001.js` |
| **TC-40** | Integration | Count query cheapness — no per-row scan | `EXPLAIN` the real `countTasks` SQL against seeded data | plan uses index access on `tasks` (`company_id`/`status`/`owner_user_id`); no Seq-Scan-per-row regression (constraint: stays cheap on every mount/poll/event) | `scripts/verify-tasks-count-001.js` (EXPLAIN section) |
| **TC-41** | Frontend | Route-change refetch does not double-mount a second `useRealtimeEvents` | inspect `AppLayout.tsx` | `onGenericEvent` **extended** for `task.changed` (single existing `useRealtimeEvents` call); no second subscription added; Pulse/Leads channels un-regressed | manual (code review) |

---

## Regression (must stay green)

- **TC-R1:** existing `tests/routes/tasks.test.js` suite (gating, GET visibility, POST/PATCH/DELETE) unchanged after `buildTaskListFilters` extraction + emit calls.
- **TC-R2:** Pulse & Leads badges unchanged — same `pulse-unread-badge` class/behavior; `leadsNewCount`/`/new-count`/its SSE types untouched (Tasks badge added **alongside**).
- **TC-R3:** `GET /api/tasks` list output byte-identical (count only *reads* via the shared builder; AR-TASK-UNIFY-001 timeline coupling + `HAS_ENTITY_PARENT` definition intact).
- **TC-R4:** `useRealtimeEvents.ts` / `sseManager.ts` touched additively only — existing Pulse/Leads realtime channels do not regress.
- **TC-R5:** `cd frontend && tsc -b` exit 0; backend Jest green (`npm test`; in the worktree add `--testPathIgnorePatterns "/node_modules/"`).

## Notes for the Implementer / Tester

- **The one test that matters most is TC-1 (S9 invariant) run against the REAL DB.** Mocks (TC-2/TC-3) prove the two callers *share* the builder; only the real query proves the count equals the list for actual rows. Do not ship on green mocks alone (LIST-PAGINATION-001 lesson).
- **S8 seed subtlety:** `HAS_ENTITY_PARENT` admits `thread_id` tasks whose `created_by IN ('user','agent')`. To seed a genuinely-excluded "system-provenance timeline task," use `created_by='system'` (or `'automation'`) with only `thread_id` set. An `'agent'` timeline task is *included* by design (MAIL-AGENT-001) — TC-35 covers that positive.
- `actorId(req)` = `req.user.crmUser.id`, never `req.user.sub` (created_by-FK-crm-user-id rule); `companyId(req)` = `req.companyFilter.company_id`.
- Harness: mirror `scripts/verify-email-outbound-001.js` — tag `TCB1`, clean before each case + at start/end, company A = seed `…0001` (delta/row-targeted asserts, never whole-page absolutes), tagged company B for TC-10 cross-tenant, created+deleted by cleanup.
