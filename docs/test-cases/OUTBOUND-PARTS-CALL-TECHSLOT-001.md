# Test-cases: OUTBOUND-PARTS-CALL-TECHSLOT-001

## Coverage
- Total: 24 (18 jest + 4 FE build/logic-review + 2 manual/VAPI).
- P0: 9 | P1: 8 | P2: 5 | P3: 2
- Unit(jest): 18 | FE build/logic-review: 4 | Manual(VAPI/e2e): 2
- Files: `tests/slotEngineProxy.test.js` (extend), `tests/recommendSlots.test.js` (new/extend), `tests/partsCallService.test.js` (extend), `tests/outboundCallService.test.js` (extend). Mocks: ZB roster (`buildTechnicians`), the engine `fetch` (return canned `recommendations`), `getJobById`, VAPI `/call` fetch.

---

### Req 2 / §3 — slotEngineService single-tech filter + ranking widen

#### TC-TS-01: `technician_id` filters technicians to one — P0, Unit
- **Scenario:** FR-2.2, arch §3. **Mocks:** `buildTechnicians` → [{id:'A'},{id:'B'},{id:'C'}]; engine `fetch` capture request body.
- **Input:** `getRecommendations(co, { new_job:{ lat, lng, technician_id:'B' } })`.
- **Expected:** the engine request `technicians` array has **exactly one** element `id:'B'`; the other techs are absent.
- **File:** `tests/slotEngineProxy.test.js`.

#### TC-TS-02: no `technician_id` → all techs (backward-compat) — P0, Unit
- **Input:** `getRecommendations(co, { new_job:{ lat, lng } })`.
- **Expected:** engine request `technicians` = all active members (byte-identical to today); recs unchanged.

#### TC-TS-03: `technician_id` present → ranking caps widened in config_override — P0, Unit
- **Scenario:** arch §3 (verified gap: default `max_recommendations_per_technician:2`). **Mocks:** capture engine body.
- **Input:** `getRecommendations(co,{ new_job:{ …, technician_id:'B' } })`.
- **Expected:** `config_override.ranking.max_recommendations_per_technician >= 5` (candidate-window count) AND `top_n >= 5` AND `max_recommendations_per_same_timeframe >= 5`; other `config_override` keys (distance/overlap/buffer from `buildConfigOverride`) preserved (deep-merge, not replaced).

#### TC-TS-04: `technician_id` unknown/foreign → empty one-tech set, no throw — P2, Unit
- **Input:** `technician_id:'ZZZ'` not in the roster.
- **Expected:** engine `technicians` = `[]`; service returns `{ recommendations:[], engine_status:'ok'|... }` safely (no cross-tenant leak, no throw).

#### TC-TS-05: `earliest`/`latest` from `targetDay` forwarded to `new_request` — P1, Unit
- **Input:** `new_job:{ …, earliest_allowed_date:'2026-07-16', latest_allowed_date:'2026-07-16', technician_id:'B' }`.
- **Expected:** engine `new_request.earliest_allowed_date === new_request.latest_allowed_date === '2026-07-16'` (confirms the already-present pass-through still works with the new filter).

### Req 4/5 / §4 — recommendSlots new args + single-nearest re-rank

#### TC-TS-06: `technicianId` sets `new_job.technician_id` — P0, Unit
- **Mocks:** spy `slotEngineService.getRecommendations`.
- **Input:** `recommendSlots.run(co,{},{ lat,lng, technicianId:'B' })`.
- **Expected:** `getRecommendations` called with `new_job.technician_id === 'B'`.

#### TC-TS-07: `targetDay` → `earliest==latest==targetDay`, returns that day's windows (≤MAX_SLOTS) — P0, Unit
- **Mocks:** engine returns 5 windows on 2026-07-16 for B.
- **Input:** `{ …, technicianId:'B', targetDay:'2026-07-16' }`.
- **Expected:** `getRecommendations` `new_job.earliest_allowed_date==='2026-07-16'` and `latest_allowed_date==='2026-07-16'`; result `slots.length <= 3`, all `date==='2026-07-16'`.

#### TC-TS-08: `targetDay+targetTime`, requested window free → exactly the containing window — P0, Unit
- **Mocks:** recs windows 08:00–10:00, 10:00–12:00, 12:00–14:00, 14:00–16:00, 16:00–18:00 (that day).
- **Input:** `{ …, technicianId:'B', targetDay:D, targetTime:'14:30' }`.
- **Expected:** `slots.length === 1`; the one slot is `14:00–16:00` (contains 14:30, distance 0).

#### TC-TS-09: `targetDay+targetTime`, requested window busy → single nearest available — P0, Unit
- **Mocks:** recs windows for that day are `08:00–10:00`, `10:00–12:00`, `16:00–18:00` (14:00–16:00 absent = occupied).
- **Input:** `targetTime:'14:30'`.
- **Expected:** `slots.length === 1`; the one slot is `16:00–18:00` (`|16:00−14:30|=90` < `|12:00... `— nearest by start; the only later-or-equal near candidate). Assert exactly-one and the correct pick.

#### TC-TS-10: `targetTime` nearest tie → earlier start — P2, Unit
- **Mocks:** windows equidistant on both sides of T (e.g. T=12:00 with 10:00–12:00 and 12:00–14:00 both distance measured from start → 10:00 dist 120, 12:00 dist 0) — construct a real tie (e.g. T between two starts equidistant) and assert the earlier start wins.
- **Expected:** deterministic single slot = earlier start.

#### TC-TS-11: `targetTime` without `targetDay` → ignored (legacy soonest, tech-constrained) — P2, Unit
- **Input:** `{ technicianId:'B', targetTime:'14:30' }` (no targetDay).
- **Expected:** no single-day scoping; `slots` = legacy mapping (≤MAX_SLOTS) across horizon; `new_job.technician_id==='B'` still set.

#### TC-TS-12: no new args → byte-identical legacy behavior — P1, Unit
- **Input:** `{ lat,lng }`.
- **Expected:** identical to the pre-feature `recommendSlots` (no technician_id / date scoping); regression guard.

#### TC-TS-13: empty recs for the day → SLOT_FALLBACK (call continues) — P1, Unit
- **Mocks:** engine returns `[]`.
- **Input:** `{ technicianId:'B', targetDay:D, targetTime:'14:30' }`.
- **Expected:** `{ available:false, slots:[], fallback:true }`; never throws.

### Req 1 / §7 — startRobotCall multi_tech gate

#### TC-TS-14: ≥2 assigned_techs → `{ok:false, reason:'multi_tech'}`, NO insert, NO stamp — P0, Unit
- **Mocks:** `getJobById` → `{ blanc_status:'Part arrived', assigned_techs:[{id:'A'},{id:'B'}] }`; spy INSERT + `markRobotCallFailed`.
- **Input:** `startRobotCall(jobId, DEFAULT_COMPANY_ID, taskId, null, { startIso, endIso, techId:'A' })`.
- **Expected:** returns `{ ok:false, reason:'multi_tech' }`; **no** `outbound_call_attempts` INSERT; `markRobotCallFailed` **not** called; gate fires before v1/phone/slot steps.

#### TC-TS-15: exactly 1 assigned_tech → not blocked (proceeds) — P1, Unit
- **Mocks:** `assigned_techs:[{id:'A'}]`; app connected; phone present; valid dispatcher slot.
- **Expected:** no `multi_tech`; proceeds to INSERT (or existing SLOTPICK outcome).

#### TC-TS-16: 0 assigned_techs → not blocked — P2, Unit
- **Mocks:** `assigned_techs:[]`.
- **Expected:** no `multi_tech` (length not ≥2); proceeds.

### Req 2 / §2 — techId (+coords) through slot_json and placeCall

#### TC-TS-17: `buildRobotCallSlot` keeps `techId`; startRobotCall stores it (+coords) in slot_json — P0, Unit
- **Mocks:** single-tech job with `lat`/`lng`; capture INSERT params.
- **Input:** `startRobotCall(…, { startIso, endIso, techId:'B' })`.
- **Expected:** the inserted `slot_json` includes `techId:'B'` (and `lat`/`lng` from the job); existing keys (`key,date,start,end,label,techName:null,confidence:null`) unchanged; invalid ISO still → `invalid_slot` (SLOTPICK regression).

#### TC-TS-18: `placeCall` injects `technicianId` (+coords) into variableValues — P1, Unit
- **Mocks:** capture the VAPI `/call` request body.
- **Input:** `placeCall({ companyId, jobId, contactId, customerNumber, slot:{ label,date,start,end,key, techId:'B', lat, lng } })`.
- **Expected:** `assistantOverrides.variableValues.technicianId==='B'` (and `lat`/`lng` present); existing `slotLabel/slotDate/slotStart/slotEnd/slotKey/jobId/contactId/companyId` unchanged; `technicianId` absent when `slot.techId` absent (auto-compute path).

### Frontend (build + logic-review)

#### TC-TS-19: RobotCallSlotModal shows multi-tech message for ≥2 techs — P0, FE logic-review
- **Scenario:** FR-1.2. **Steps:** mount wrapper with a `getJob` mock returning `assigned_techs.length===2`.
- **Expected:** renders the "multiple technicians … call manually" copy; does NOT render `CustomTimeModal`; no POST possible. Single/zero-tech → renders `CustomTimeModal` as SLOTPICK.

#### TC-TS-20: RobotCallSlotModal captures `techId` into the POST body — P0, FE logic-review
- **Scenario:** FR-2.2. **Steps:** `handleQueue` receives `onConfirm`'s `{ start, end, techId:'B' }`.
- **Expected:** `runTaskAction(taskId,'robot_call',{ slot:{ startIso, endIso, techId:'B' } })` — `techId` no longer dropped. `npm run build` (tsc -b) green.

#### TC-TS-21: CustomTimeModal `recommendTechId` → `technician_id` in recs fetch; timelines unchanged — P1, FE logic-review
- **Scenario:** FR-3.1/3.2. **Expected:** when `recommendTechId` set, `fetchSlotRecommendations` body includes `technician_id`; `buildTechGroups` still renders ALL techs; omitted `recommendTechId` → no `technician_id` (new-job unchanged). `SlotRecommendationsInput` gains `technician_id?`. Build green.

#### TC-TS-22: JobInfoSections passes stable-sorted `assigned_techs[0]` — P1, FE logic-review
- **Scenario:** FR-3.1. **Expected:** the reschedule `CustomTimeModal` receives `recommendTechId = [...assigned_techs].sort(by-id)[0]?.id`; a 2+ tech job yields a deterministic id; new-job callers (`ConvertToJobSteps`/`WizardStep3`/`NewJobDialog`) pass nothing. After a reschedule save, `assigned_techs` is unchanged (assignment preserved — assert via the reschedule call being time-only). Build green.

### Manual / VAPI

#### TC-TS-23: VAPI OUTBOUND assistant `recommendSlots` schema PATCH — P0, Manual
- **Scenario:** arch §6. **Steps:** GET the OUTBOUND assistant (`VAPI_OUTBOUND_ASSISTANT_ID`); PATCH the `recommendSlots` tool `parameters` to add `targetDay` (string `YYYY-MM-DD`) + `targetTime` (string `HH:MM`), update description; re-inject `VAPI_TOOLS_SECRET` into `model.tools[].server`.
- **Expected:** GET-after-PATCH shows both params; `technicianId` NOT added (server-injected). A test call where the customer names a day and a day+time triggers `recommendSlots` with those args and the robot offers that tech's day windows / the single nearest window.

#### TC-TS-24: End-to-end owner test call (single-tech job) — P3, Manual/e2e
- **Steps:** queue a robot call on a single-tech part-arrived job picking tech B; answer; ask for a specific day, then a specific day+time.
- **Expected:** the opening slot is B's; the day request returns B's windows for that day; the day+time returns exactly one nearest window; a 2+ tech job cannot be queued (S1/S2).
