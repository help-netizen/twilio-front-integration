# OUTBOUND-PARTS-CALL-TECHSLOT-001 — Spec: robot offers ONE tech's real windows; block multi-tech; in-call day / day+time

## Overview
Extends OUTBOUND-PARTS-CALL-001 / -BTN-001 / -SLOTPICK-001. Three things: (1) **forbid** the robot call on jobs with 2+ technicians (modal message + non-bypassable server reject); (2) constrain every window the robot offers — opening and in-call — to **the technician the dispatcher picked** in the slot modal (`techId` threaded end-to-end into the in-call `recommendSlots`); (3) handle in-call counter-proposals: a **specific day** → that tech's windows on that day; a **specific day+time** → the **single nearest** available window. Plus: desktop **reschedule** recommendations default to the job's current tech (`assigned_techs[0]`, stable-sorted), timelines still showing all techs; assignment stays unchanged (time-only reschedule).

**Crux (verified):** NO slot-engine algorithm change. `slot-engine/src/engine.js` ranks across whatever `technicians` array it is handed (`:67,144`) and honors `earliest_allowed_date`/`latest_allowed_date` (`:75-79`); it has no target-time concept (`:312`). Single-tech = a one-element `technicians` array; day = `earliest=latest=targetDay`; nearest-to-time = re-rank the ≤5 same-day windows **in the skill**. All work is backend-proxy input-shaping (`slotEngineService`) + the `recommendSlots` skill + the thread + the two gate surfaces.

**Binding decisions:** first tech of a 2+ job = `assigned_techs[0]` (deterministic stable, by-id); in-call nearest = exactly ONE window; req-1 gate = modal message AND server reject `reason:'multi_tech'`; assignment preserved on reschedule (already true).

**Storage:** `outbound_call_attempts.slot_json.techId` (+ `slot_json.lat`/`lng` for in-call location) — freeform JSONB, **NO migration**; copied forward on retry.

## Behavior scenarios

### S1 — Multi-tech job blocked at the modal (req 1)
- **Pre:** part-arrived job with `assigned_techs.length >= 2`; open `part_arrived_call` task; viewer has `tasks.manage`.
- **Steps:** click 🤖 (Job card or Pulse AR) → `RobotCallSlotModal` `getJob(jobId)` → the wrapper sees `assigned_techs.length >= 2`.
- **Result:** the modal renders "This job has multiple technicians — the robot call isn't available; please call manually" **instead of** `CustomTimeModal`. No slot picker, no CTA, no POST. The dispatcher uses 📞 manual.
- **Side effects:** none.

### S2 — Multi-tech job blocked at the server (req 1, non-bypassable)
- **Steps:** a direct `POST /api/tasks/:id/actions/robot_call` (with or without `slot`) for a ≥2-tech job (bypassing the modal).
- **Result:** `startRobotCall` loads the company-scoped job, sees `assigned_techs.length >= 2`, returns `{ ok:false, reason:'multi_tech' }` **before** the v1 gate / phone / slot steps. The execute route maps it to a **200** domain refusal `{ ok:true, data:{ ok:false, state:'failed', reason:'multi_tech' } }`. **No** `outbound_call_attempts` row; the task stays open, **not** stamped failed. `recommendSlots` is not run.

### S3 — Single-tech pick threads to the call (req 2, happy path)
- **Pre:** part-arrived single-tech (or zero-tech) job; smart-slot-engine app connected; outbound v1 gate satisfied (`DEFAULT_COMPANY_ID` + `settings.enabled`).
- **Steps:** click 🤖 → `CustomTimeModal` (title "Schedule the robot call", CTA "Queue robot call") shows recs (scoped to the job's tech, §req 3) + ALL techs' timelines → the dispatcher picks a window on a technician lane → "Queue robot call".
- **Result:** `onConfirm({ start:<ISO>, end:<ISO>, techId:B })` → `handleQueue` POSTs `{ slot:{ startIso, endIso, techId:B } }`. `startRobotCall` → `buildRobotCallSlot` derives company-tz `slot_json` and **keeps `techId:B`** (+ the job's `lat`/`lng`); enqueues one `pending` attempt. `200 { ok:true, data:{ state:'queued', attemptId } }`.
- **Side effects:** `slot_json = { key,date,start,end,label,techName:null,confidence:null, techId:B, lat, lng }`. Later the worker `placeCall`s with `variableValues.technicianId=B` (+ `lat`/`lng`); the opening slot and any in-call `recommendSlots` are constrained to B.

### S4 — Dispatcher overrides the technician (req 2)
- **Steps:** the job's repair tech is A, but the dispatcher clicks a free window on technician **B**'s lane (timelines show all techs) → "Queue robot call".
- **Result:** `slot_json.techId=B`; the placed call offers **B**'s windows only. The pick — not the job's repair assignment — drives the call's tech. (Assignment is unchanged; this is who the robot offers, not who is assigned.)

### S5 — In-call: customer asks a specific DAY (req 4)
- **Pre:** an in-flight outbound call; `variableValues.technicianId=B` (+ `lat`/`lng`) injected.
- **Steps:** customer says "can you come Thursday?" → the assistant calls `recommendSlots({ …, technicianId:B, targetDay:'2026-07-16' })` (targetDay from the model; technicianId from `variableValues`).
- **Result:** backend sets `new_job.technician_id=B`, `earliest=latest='2026-07-16'`, widens ranking caps → the engine returns B's feasible 2026-07-16 windows; the skill returns up to `MAX_SLOTS` (3) of them. The robot offers those windows for that day.
- **Edge:** none feasible that day → `{ available:false, fallback:true }`; the robot says none available and offers another day (call continues).

### S6 — In-call: customer asks a specific DAY+TIME, window free (req 5)
- **Steps:** "Thursday around 2:30pm" → `recommendSlots({ …, technicianId:B, targetDay:'2026-07-16', targetTime:'14:30' })`.
- **Result:** the skill fetches B's 2026-07-16 windows, finds the 14:00–16:00 window contains 14:30 (distance 0), returns **exactly that one** window.

### S7 — In-call: customer asks DAY+TIME, requested window busy → single nearest (req 5)
- **Steps:** same call; B's 14:00–16:00 is occupied but 16:00–18:00 is free.
- **Result:** the skill re-ranks that day's windows by `|start − 14:30|` and returns **exactly one** — the 16:00–18:00 window (the single nearest available). Never a list.

### S8 — Desktop reschedule recs scoped to current tech (req 3)
- **Pre:** rescheduling an existing job from `JobInfoSections` (`initialSlot` present).
- **Steps:** open the reschedule `CustomTimeModal`.
- **Result:** recommendations are requested with `technician_id = stableSortById(assigned_techs)[0]` → the engine returns only that tech's windows; the technician **timelines still show ALL techs** so the dispatcher can override. Saving reschedules **time-only** (`rescheduleItem`) — `assigned_techs` unchanged (both techs stay for a 2+ job). New-job flows send no `technician_id` (all-tech, unchanged).

### S9 — Permission / marketplace gates
- 🤖 self-gates `tasks.manage` (`TaskActionButtons:58`) — never shown to a user who would 403 on execute. The desktop recs route is gated `schedule.dispatch` (`schedule.js:200`); the in-call `recommendSlots` gates on the smart-slot-engine marketplace app (`recommendSlots.js:86`) and safe-fails when off. Adding `technician_id`/`targetDay`/`targetTime` changes none of these gates.

### S10 — Company scoping
- Recs route: `companyId = req.companyFilter?.company_id`; foreign job/task id → 404. `startRobotCall`/`buildRobotCallSlot`/`getRecommendations`/the skill are all `companyId`-scoped; `buildTechnicians` is per-company. The injected `technicianId` never influences company scope. A single-tech filter only narrows within the company's own roster.

## Edge cases
1. **Slot with no `techId`** (should not occur — req 1 blocks 2+ jobs; the modal always yields a lane pick): the in-call `recommendSlots` falls back to the job's single assigned tech; absent that, legacy all-tech. Never an error.
2. **`technicianId` for a tech with no base and no jobs that day:** the engine can't place an empty-day based-less tech → no windows → `{ available:false, fallback:true }` (req-4 edge). Not an error.
3. **`targetTime` without `targetDay`:** ignored (no single-day set to search) → behaves as legacy soonest (tech-constrained). The VAPI tool description instructs pairing them.
4. **`targetDay` out of horizon / in the past:** the engine's own past/horizon filter drops it → empty → fallback.
5. **Ranking cap not widened (defensive):** if the widen were missing, a single-tech day query would return ≤2 windows and req-5 nearest could miss the true-nearest — hence the widen is mandatory (§arch 3), asserted by a test.
6. **Retry:** `slot_json` (with `techId`/coords) is copied forward (`outboundCallWorker.js:307-312`) → the constraint + location persist across retries.
7. **2+ tech job whose `assigned_techs` ordering is nondeterministic across fetches:** req-3 uses a stable by-id sort so `[0]` is deterministic.
8. **Reschedule of a job whose tech has a full day:** recs may be empty for that tech → the modal recs column is empty but all-tech timelines still allow a manual pick (unchanged CustomTimeModal behavior).

## Error handling
- **In-call `recommendSlots`:** every fault (app off / engine unavailable / no location / empty / throw) → `SLOT_FALLBACK` `{ available:false, slots:[], fallback:true }`; the call always continues (never a 500, never a fabricated window).
- **`multi_tech`:** a **200** domain refusal (like `not_dialable`), not a 400 — it is a job-state block, not a bad client slot. The modal never reaches it (self-blocks at S1); a direct API caller gets the refusal.
- **`invalid_slot`** (SLOTPICK): unchanged — still HTTP 400.
- **Recs route errors:** unchanged safe-fail (`fetchSlotRecommendations` resolves to disabled/empty; never throws to the UI).

## Component interaction
- **Constraint thread:** `CustomTimeModal.onConfirm({…techId})` → `RobotCallSlotModal.handleQueue({start,end,techId})` → `POST /api/tasks/:id/actions/robot_call { slot:{ startIso,endIso,techId } }` → route `slot:req.body?.slot` (opaque) → `registry.robotCall` (opaque) → `startRobotCall` → `buildRobotCallSlot` (keeps `techId`; adds job coords) → INSERT `slot_json` → worker `placeCall({ slot })` → `variableValues.technicianId`(+`lat`/`lng`) → `buildSkillInput` spread → `recommendSlots` input.
- **Desktop recs (req 3):** `JobInfoSections` → `CustomTimeModal recommendTechId` → `fetchSlotRecommendations({…,technician_id})` → `POST /api/schedule/slot-recommendations { new_job }` → `getRecommendations` → one-tech filter + ranking widen → engine.
- **No new SSE, no new route, no new migration.**

## API / tool contracts
- **`POST /api/tasks/:id/actions/robot_call`** — body `slot` now optionally carries `techId`: `{ slot:{ startIso, endIso, techId? } }`. Gate `tasks.manage`; company-scoped; foreign id → 404. ≥2-tech job → 200 `reason:'multi_tech'` (no enqueue). `invalid_slot` → 400 (unchanged). No `slot` → auto-compute (backward-compat).
- **`POST /api/schedule/slot-recommendations`** — request `new_job` gains optional `technician_id` (single-tech scope). Gate `schedule.dispatch`; `companyId = req.companyFilter.company_id`. Response shape unchanged.
- **`recommendSlots` (in-call tool)** — new optional input args: `technicianId` (string; **server-injected** via `variableValues`), `targetDay` (string `YYYY-MM-DD`; **model**), `targetTime` (string `HH:MM` 24h; **model**, with `targetDay`). Semantics: `technicianId`→constrain to one tech; `targetDay`→that day only (≤`MAX_SLOTS`); `targetDay+targetTime`→exactly ONE nearest window (contains-T else `argmin|start−T|`, tie→earlier). Return shape unchanged (`{ available, slots[] }`); never throws.
- **VAPI OUTBOUND assistant PATCH** — add `targetDay`,`targetTime` to the `recommendSlots` tool `parameters` (model-fillable) + description; `technicianId` NOT in the schema (server-injected). Manual REST PATCH on `VAPI_OUTBOUND_ASSISTANT_ID`.

## Data isolation
- Every query company-scoped (recs route `req.companyFilter.company_id`; skill/service/partsCall `companyId` arg; `buildTechnicians` per-company). The `technician_id` filter only narrows within the company's own roster; a foreign/unknown id yields an empty one-tech set → fallback, never cross-tenant data. Injected `variableValues` never affect scope.

## Non-goals
- Any `slot-engine/src/*` change (single-tech / day / nearest are all input-shaping + in-skill).
- A new migration, a new route, or a new `outbound_call_attempts` column.
- Reassigning technicians on reschedule (time-only; both techs stay).
- A list of nearest windows for day+time (owner: exactly one).
- Adding `technicianId` to the VAPI tool schema (server-injected).
- Making the robot call available for 2+ tech jobs (explicitly forbidden).
- Resolving relative day phrases in the skill (v1 expects `YYYY-MM-DD` from the model).
