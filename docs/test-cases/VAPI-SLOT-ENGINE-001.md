# Test Cases: VAPI-SLOT-ENGINE-001 — Sara offers engine-ranked windows; the caller's pick becomes a schedule-blocking hold on the lead

Spec: `Docs/requirements.md` §VAPI-SLOT-ENGINE-001 (AC-1..AC-8, scenarios S1..S7) · Architecture: `Docs/architecture.md` §VAPI-SLOT-ENGINE-001 (Decisions A–F).
The task's S-axis (S1..S8) maps onto the spec scenarios: **S5** = held-lead occupancy blocks re-offering (spec scenario 7 + AC-5), **S2** = `createLead` persists the hold + renders in Schedule (spec scenario 2 + AC-2), **S6/S7** = confirm/lose lifecycle (spec scenarios 5–6 + AC-6), **S8** = two-caller (spec scenario 7). S1/S3/S4 cover the offer, deeper mode and fallback (spec scenarios 1/3/4 + AC-1/AC-3/AC-4).

## Coverage
- Total test cases: **31**
- P0: **14** · P1: **12** · P2: **5** · P3: **0**
- Unit (jest, mocked): **17** · Integration (real DB, `scripts/verify-vapi-slot-engine-001.js`, tag `VSE1`): **11** · Assistant-JSON (JSON.parse): **3**
- **Two P0 must-pass gates:** `VSE-INT-01` (S5 — held lead enters occupancy, terminal leads excluded) and `VSE-INT-05` (S2 — `createLead` persists the hold + it renders in the Schedule UNION). The **tz-combine DST correctness** unit gate `VSE-U-01` is P0 too.

### Load-bearing findings from the code read (drive several cases)
- **Case-mismatch trap (S6/S7 — `VSE-INT-08` targets it):** the occupancy sub-read and the Schedule UNION filter on `l.status NOT IN ('converted','lost','spam')` **lowercase, no `LOWER()`** (`scheduleQueries.js:136`), but `markLost` writes `status='Lost'` and `convertLead` writes `status='Converted'` **capitalized** (`leadsService.js:459/655/698`). Postgres `IN` is case-sensitive, so a capitalized `'Lost'`/`'Converted'` lead does **not** match the exclusion set and would **stay** in the hold — the slot would never free. The lifecycle cases assert the **actual observed behavior** and flag this: implementation must reconcile the case (lowercase the writes, `LOWER()` the filter, or normalize on read) or AC-6/AC-5-free-again silently fail. This is exactly the "cross-check the terminal-status filter is the lowercase set" bullet.
- **tz-combine has no backend implementation today** — `slotEngineService.localDate`/`localHHMM` are the *inverse* (instant→wall-clock). The new `combine(date,'HH:MM',tz)→ISO` helper must mirror `frontend/src/utils/companyTime.ts::dateInTZ` (`Date.UTC(y,mo-1,d,hh,mm)` minus the tz offset read via `Intl…longOffset`). Unit-test it directly across a DST boundary.
- **Gate/company constants:** `DEFAULT_COMPANY_ID='00000000-0000-0000-0000-000000000001'` (`vapi-tools.js:25`), `APPOINTMENT_DURATION_MIN=120`, `MAX_SLOTS=3`; gate `marketplaceService.isAppConnected(DEFAULT_COMPANY_ID, marketplaceService.SMART_SLOT_ENGINE_APP_KEY)` where `SMART_SLOT_ENGINE_APP_KEY='smart-slot-engine'` (`marketplaceService.js:19`).
- **Pinned engine per-slot shape** (Decision B): `{ rank, date:'YYYY-MM-DD', time_frame:{start:'HH:MM',end:'HH:MM'}, technicians:[{id,name}], score, confidence, … }`; load-bearing fields = `date` + `time_frame.{start,end}`. Stable slot key = `` `${date}|${time_frame.start}|${time_frame.end}` `` (tech-agnostic).
- **Max migration on disk = 155** (`155_backfill_outbound_email_links.sql`) — no `156`; **no migration** in this feature.

---

## A. Unit tests (jest, mocked) — `backend/tests/…`

Target files (per architecture "Files to change"):
`backend/tests/services/slotEngineService.tzCombine.test.js` (helper), `backend/tests/routes/vapiTools.recommendSlots.test.js` (tool + createLead + auth).

### VSE-U-01: tz-combine composes correct ISO across a DST boundary (America/New_York) — **P0**
- **Priority:** P0 · **Type:** Unit · **Scenario:** S2 (AC-2), Decision B tz-combine
- **Preconditions:** the new backend `combine(dateStr, 'HH:MM', tz)` helper exported from `slotEngineService` (mirrors `dateInTZ`).
- **Inputs / expected (three assertions in one case):**
  - **EDT (summer):** `combine('2026-07-08','10:00','America/New_York')` → `.toISOString() === '2026-07-08T14:00:00.000Z'` (UTC-4).
  - **EST (winter):** `combine('2026-01-14','10:00','America/New_York')` → `'2026-01-14T15:00:00.000Z'` (UTC-5).
  - **DST boundary day:** `combine('2026-03-08','09:00','America/New_York')` → `'2026-03-08T14:00:00.000Z'` (that Sunday 02:00 springs forward; 09:00 wall-clock is already EDT, so UTC-4 not UTC-5). Proves the offset is read **at that instant**, not a fixed offset.
- **Expected:** all three ISO strings match exactly.
- **File:** `backend/tests/services/slotEngineService.tzCombine.test.js`

### VSE-U-02: tz-combine honors a non-ET timezone — **P1**
- **Priority:** P1 · **Type:** Unit · **Scenario:** S2, Decision B
- **Inputs / expected:**
  - `combine('2026-07-08','09:00','America/Los_Angeles')` → `'2026-07-08T16:00:00.000Z'` (PDT UTC-7).
  - `combine('2026-07-08','09:00','America/Chicago')` → `'2026-07-08T14:00:00.000Z'` (CDT UTC-5).
- **Expected:** matches; confirms the helper is not ET-hardcoded.
- **File:** `backend/tests/services/slotEngineService.tzCombine.test.js`

### VSE-U-03: tz-combine of end-window composes `lead_end_date_time` consistently — **P2**
- **Priority:** P2 · **Type:** Unit · **Scenario:** S2
- **Inputs:** `date='2026-07-08'`, `start='10:00'`, `end='13:00'`, `tz='America/New_York'`.
- **Expected:** `combine(date,end,tz)` → `'2026-07-08T17:00:00.000Z'`; `combine(date,end)` > `combine(date,start)` (end after start, positive duration).
- **File:** `backend/tests/services/slotEngineService.tzCombine.test.js`

### VSE-U-04: recommendSlots is GATED — app not connected ⇒ fallback, engine NOT called — **P0**
- **Priority:** P0 · **Type:** Unit · **Scenario:** S4 (AC-4, AC-8), FR-1
- **Mocks:** `marketplaceService.isAppConnected` → resolves `false`; `slotEngineService.getRecommendations` → jest spy (asserted **not called**).
- **Steps:** invoke `handleRecommendSlots({ zip:'02101' })`.
- **Expected:** returns `{ available:false, slots:[], fallback:true }`; `getRecommendations` spy `.not.toHaveBeenCalled()` (short-circuits before the engine); `isAppConnected` called with `(DEFAULT_COMPANY_ID, 'smart-slot-engine')`.
- **File:** `backend/tests/routes/vapiTools.recommendSlots.test.js`

### VSE-U-05: recommendSlots SAFE-FAIL — engine_status 'unavailable' ⇒ fallback — **P1**
- **Priority:** P1 · **Type:** Unit · **Scenario:** S4 (AC-4), FR-1
- **Mocks:** `isAppConnected`→`true`; `getRecommendations`→`{ recommendations:[], summary:null, engine_status:'unavailable', coverage:{} }`.
- **Expected:** `{ available:false, slots:[], fallback:true }`; no throw.
- **File:** `backend/tests/routes/vapiTools.recommendSlots.test.js`

### VSE-U-06: recommendSlots SAFE-FAIL — getRecommendations throws ⇒ fallback (no 500) — **P1**
- **Priority:** P1 · **Type:** Unit · **Scenario:** S4 (AC-4), Decision C try/catch
- **Mocks:** `isAppConnected`→`true`; `getRecommendations`→`throws new Error('NEW_JOB_LOCATION_REQUIRED')` (also stands for a bad-location 422).
- **Expected:** handler catches → `{ available:false, slots:[], fallback:true }`; the rejection never propagates to the caller.
- **File:** `backend/tests/routes/vapiTools.recommendSlots.test.js`

### VSE-U-07: recommendSlots SAFE-FAIL — engine 'ok' but empty recommendations ⇒ fallback — **P1**
- **Priority:** P1 · **Type:** Unit · **Scenario:** S4 (AC-4)
- **Mocks:** `isAppConnected`→`true`; `getRecommendations`→`{ recommendations:[], engine_status:'ok', … }`.
- **Expected:** `available:false` (spec: `available:true` only when `engine_status:'ok'` **and** ≥1 slot survives) → `{ available:false, slots:[], fallback:true }`.
- **File:** `backend/tests/routes/vapiTools.recommendSlots.test.js`

### VSE-U-08: recommendSlots caps result to ≤3 with stable key `date|start|end` — **P0**
- **Priority:** P0 · **Type:** Unit · **Scenario:** S1 (AC-1), Decision C result shape
- **Mocks:** `isAppConnected`→`true`; `getRecommendations`→ **5** recommendations across distinct windows (`date`+`time_frame`).
- **Expected:** `available:true`; `slots.length === 3` (`.slice(0,3)`); each `slot.key === \`${date}|${time_frame.start}|${time_frame.end}\``; each slot carries `{ key, date, start, end, label, confidence }` (and optional `techName`); `start===time_frame.start`, `end===time_frame.end`.
- **File:** `backend/tests/routes/vapiTools.recommendSlots.test.js`

### VSE-U-09: same window from two techs collapses to one keyed slot — **P2**
- **Priority:** P2 · **Type:** Unit · **Scenario:** S1, Decision C ("tech-agnostic key")
- **Mocks:** two recommendations with identical `date`+`time_frame` but different `technicians[0].id`.
- **Expected:** they dedupe to a single offered slot (one key); result count reflects the collapse (not two identical offers).
- **File:** `backend/tests/routes/vapiTools.recommendSlots.test.js`

### VSE-U-10: excludeSlots filters already-offered keys (deeper mode) — **P0**
- **Priority:** P0 · **Type:** Unit · **Scenario:** S3 (AC-3), FR-3
- **Mocks:** `isAppConnected`→`true`; `getRecommendations`→ 3 recs with keys `K1,K2,K3`.
- **Inputs:** `handleRecommendSlots({ zip:'02101', excludeSlots:['K1','K2'] })` where `K1='2026-07-08|10:00|13:00'`, `K2='2026-07-09|13:00|16:00'`.
- **Expected:** returned `slots` contains only `K3`; `K1`/`K2` absent; `available:true` (K3 survived). If all keys are excluded ⇒ `{ available:false, slots:[], fallback:true }` (nothing survives).
- **File:** `backend/tests/routes/vapiTools.recommendSlots.test.js`

### VSE-U-11: daysAhead extends latest_allowed_date in the getRecommendations input — **P1**
- **Priority:** P1 · **Type:** Unit · **Scenario:** S3 (AC-3), FR-3
- **Mocks:** `isAppConnected`→`true`; `getRecommendations`→ jest spy capturing its `input` arg.
- **Inputs:** `handleRecommendSlots({ zip:'02101', daysAhead:14 })`.
- **Expected:** the captured `input.new_job.latest_allowed_date` reflects `today + 14` (company-local), i.e. later than the default `horizon_days` window; asserts the deeper "extend the window" lever reaches the engine input. (No `exclude_job_id` — prospective caller.)
- **File:** `backend/tests/routes/vapiTools.recommendSlots.test.js`

### VSE-U-12: location precedence lat/lng → address → zip built into new_job — **P1**
- **Priority:** P1 · **Type:** Unit · **Scenario:** S1 (FR-2), Decision C location
- **Mocks:** `getRecommendations` spy capturing `input.new_job`.
- **Inputs (three sub-assertions):**
  1. `{ lat:42.36, lng:-71.06 }` → `new_job.lat/lng` set to those values.
  2. `{ address:'1 City Hall Sq, Boston MA' }` (no lat/lng) → `new_job.address` set, engine geocodes.
  3. `{ zip:'02101' }` (no lat/lng/address) → `new_job.address` carries the zip (centroid path).
- **Expected:** `new_job.job_type` = `unitType?unitType+' Repair':'Appliance Repair'`; `new_job.duration_minutes` = `durationMinutes||120`.
- **File:** `backend/tests/routes/vapiTools.recommendSlots.test.js`

### VSE-U-13: createLead WITH chosenSlot adds LeadDateTime/LeadEndDateTime/Latitude/Longitude to the body — **P0**
- **Priority:** P0 · **Type:** Unit · **Scenario:** S2 (AC-2), Decision D, FR-4
- **Mocks:** `leadsService.createLead` → jest spy resolving `{ uuid:'lead-x' }`; company tz resolves `America/New_York`.
- **Inputs:** `handleCreateLead({ firstName:'Ann', phone:'+16175551212', zip:'02101', lat:42.36, lng:-71.06, chosenSlot:{ date:'2026-07-08', start:'10:00', end:'13:00' } })`.
- **Expected:** the body passed to `createLead` contains `LeadDateTime:'2026-07-08T14:00:00.000Z'`, `LeadEndDateTime:'2026-07-08T17:00:00.000Z'` (tz-combine), `Latitude:42.36`, `Longitude:-71.06`; still contains the existing `Phone/FirstName/Status:'Review'/JobSource:'AI Phone'/Comments` fields; second arg `=== DEFAULT_COMPANY_ID`; returns `{ success:true, leadId:'lead-x' }`.
- **File:** `backend/tests/routes/vapiTools.recommendSlots.test.js`

### VSE-U-14: createLead WITHOUT chosenSlot is byte-identical to today (no slot fields) — **P0**
- **Priority:** P0 · **Type:** Unit · **Scenario:** S4 back-compat (AC-2/AC-4), Decision D
- **Mocks:** `leadsService.createLead` spy.
- **Inputs:** `handleCreateLead({ firstName:'Ann', phone:'+16175551212', zip:'02101', preferredSlot:'morning' })` (no `chosenSlot`).
- **Expected:** the body passed to `createLead` has **no** `LeadDateTime`/`LeadEndDateTime`/`Latitude`/`Longitude` keys (`expect(body).not.toHaveProperty('LeadDateTime')` etc.); the object **deep-equals the pre-feature body** for the same inputs (snapshot/`toEqual` against the legacy shape incl. the `Comments` "Slot: morning" label). Proves the Comments summary path is untouched when the caller didn't pick a structured slot.
- **File:** `backend/tests/routes/vapiTools.recommendSlots.test.js`

### VSE-U-15: createLead phone guard still enforced (slot cannot bypass it) — **P1**
- **Priority:** P1 · **Type:** Unit · **Scenario:** S2 protected-parts, Decision D
- **Inputs:** `handleCreateLead({ firstName:'Ann', chosenSlot:{date:'2026-07-08',start:'10:00',end:'13:00'} })` — no phone, not disqualified.
- **Expected:** `{ success:false, error:'Phone number is required to create lead' }`; `leadsService.createLead` **not** called (a slot without a phone still can't create a valid lead).
- **File:** `backend/tests/routes/vapiTools.recommendSlots.test.js`

### VSE-U-16: createLead with malformed chosenSlot degrades to no-hold (never throws) — **P2**
- **Priority:** P2 · **Type:** Unit · **Scenario:** S4 safe-fail, Decision D ("when present and valid")
- **Inputs:** `chosenSlot:{ date:'not-a-date', start:'99:99', end:null }` + a valid phone.
- **Expected:** lead is still created (call never blocked); slot columns omitted/NULL when the pick can't be composed into valid timestamps; no exception.
- **File:** `backend/tests/routes/vapiTools.recommendSlots.test.js`

### VSE-U-17: vapiSecretAuth still enforced on the endpoint (fail-closed) — **P0**
- **Priority:** P0 · **Type:** Unit (supertest against the router) · **Scenario:** AC-8, protected-parts
- **Cases:**
  1. `VAPI_TOOLS_SECRET` unset → `POST /` → **503** `{ error:'vapi tools not configured' }` (fail-closed).
  2. `VAPI_TOOLS_SECRET` set, wrong/missing `x-vapi-secret` header → **401** `{ error:'Unauthorized' }`.
  3. correct header, a `recommendSlots` tool-call envelope → **200** with `{ results:[{ toolCallId, result }] }` and `result` a JSON string. The new tool is reachable **only** through this authed-by-secret endpoint, never the proxy.
- **Expected:** all three; confirms the new tool inherits the existing envelope + secret gate and adds no session/auth of its own.
- **File:** `backend/tests/routes/vapiTools.recommendSlots.test.js`

---

## B. Integration tests (real DB) — `scripts/verify-vapi-slot-engine-001.js` (self-seeding/cleaning, tag `VSE1`)

House harness pattern per `scripts/verify-tasks-count-001.js`: `DATABASE_URL` defaults to `postgresql://localhost/twilio_calls` (never prod); tiny `check/eq` kit; `CASE(id,title,fn)`; `cleanupAll()` before every case + at start/end; PASS/FAIL lines; `process.exit(fail>0?1:0)`. All fixtures tagged `VSE1` — leads `first_name='VSE1'` (or `uuid LIKE 'vse1%'`), jobs by company, cleaned in FK order. Company A = seed `…0001`; a temp tagged Company B (`…00b1`-style) for the isolation case. Held-lead occupancy is exercised by calling `slotEngineService._buildScheduledJobs(companyId, startDate, endDate, tz)` **directly** (exported at `slotEngineService.js:245`) and the Schedule render by `scheduleQueries` UNION; the tz-combine + `createLead` slot write via `handleCreateLead`-equivalent with `leadsService.createLead` hitting the real DB. Engine-dependent offer/deeper checks (S1/S3) run only when `SLOT_ENGINE_URL` + a connected `smart-slot-engine` app are present (else the case records `SKIP` with a reason, like the harness's conditional cases).

### VSE-INT-01: **S5 (P0 MUST-PASS)** — held OPEN lead enters buildScheduledJobs occupancy; terminal + geo-less excluded
- **Priority:** P0 · **Type:** Integration · **Scenario:** S5 (spec scenario 7, AC-5), FR-5, Decision A
- **Seed (all `VSE1`, Company A):**
  - `L_open`: `status='Review'`, `lead_date_time` = a window inside the test date-range, `lead_end_date_time` = +3h, `latitude`/`longitude` set.
  - `L_conv`: same window+coords but `status='Converted'`.
  - `L_lost`: same window+coords but `status='Lost'`.
  - `L_nogeo`: `status='Review'`, `lead_date_time` set but `latitude`/`longitude` **NULL**.
- **Steps:** `occ = await slotEngineService._buildScheduledJobs(COMPANY_A, startDate, endDate, tz)`.
- **Expected:**
  - `occ` contains an entry for `L_open` with `id === 'lead:'+L_open.id` (the `'lead:'`-prefixed id per Decision A — assert the actual prefix the impl uses; task shorthand "lead-<id>"), `date`/`window_start`/`window_end` derived from its `lead_date_time`/`lead_end_date_time` (company tz), `lat`/`lng` = its coords, `assigned_technicians: []`.
  - `L_conv` and `L_lost` are **absent** (terminal-status filter `NOT IN ('converted','lost','spam')`) — **subject to the case-mismatch finding**: if the impl stores `'Converted'`/`'Lost'` capitalized and filters lowercase without `LOWER()`, they would wrongly appear — this case fails and surfaces the bug (that is the intended guard). Seed statuses to match whatever normalization the implementation adopts, and assert exclusion.
  - `L_nogeo` is **absent** (`buildScheduledJobs` skips rows without finite lat/lng, `slotEngineService.js:121`; geo requirement).
- **Sabotage note:** covered by `VSE-INT-11`.

### VSE-INT-02: held-lead occupancy is company-scoped (no cross-tenant leak) — **P1**
- **Priority:** P1 · **Type:** Integration · **Scenario:** S5 isolation, Decision A (`WHERE company_id=$1`), agent-04 data-isolation rule
- **Seed:** `L_A` (Company A) and `L_B` (temp Company B) — both open, coords, overlapping window.
- **Steps:** `occA = _buildScheduledJobs(COMPANY_A, …)`; `occB = _buildScheduledJobs(COMPANY_B, …)`.
- **Expected:** `occA` contains `L_A`, **not** `L_B`; `occB` contains `L_B`, **not** `L_A`. The occupancy sub-read is bound to the passed company id only.

### VSE-INT-03: held-lead occupancy respects the date window (out-of-range hold excluded) — **P2**
- **Priority:** P2 · **Type:** Integration · **Scenario:** S5, Decision A date-window
- **Seed:** `L_in` (window inside `[startDate,endDate]`), `L_out` (window a month later).
- **Steps:** `_buildScheduledJobs(COMPANY_A, startDate, endDate, tz)`.
- **Expected:** `L_in` present, `L_out` absent (`lead_date_time` between the tz-adjusted day boundaries).

### VSE-INT-04: EXPLAIN — held-lead sub-read is date-windowed/small (no seq-scan regression) — **P2**
- **Priority:** P2 · **Type:** Integration · **Scenario:** non-functional (Decision A "small, `idx_leads_lead_date_time`"), verify-plan step 2
- **Steps:** reproduce the held-lead sub-read SQL (company + `NOT IN` + `lead_date_time NOT NULL` + coords + date window) and `EXPLAIN (FORMAT TEXT)` it (mirror `verify-tasks-count-001.js::TC-40`).
- **Expected:** the plan uses the date/company index (or is a trivially cheap small scan) — assert **no** correlated SubPlan / cross-table Nested-Loop; confirms the occupancy add didn't introduce an expensive per-request read on the hot path.

### VSE-INT-05: **S2 (P0 MUST-PASS)** — createLead persists the hold AND it renders in the Schedule UNION
- **Priority:** P0 · **Type:** Integration · **Scenario:** S2 (spec scenario 2, AC-2), Decision D + tz-combine
- **Steps:**
  1. `res = await handleCreateLead({ firstName:'VSE1', phone:'+16175550001', zip:'02101', lat:42.36, lng:-71.06, chosenSlot:{ date:<in-range>, start:'10:00', end:'13:00' } })` against the **real** DB.
  2. Read the created lead row by returned id.
  3. Run the schedule UNION (`scheduleQueries` list for that date range, `wantLead` on) for Company A.
- **Expected:**
  - lead row has `lead_date_time`/`lead_end_date_time` = the composed timestamps (assert equal to the backend `combine()` of `date`+`start`/`end`+tz, i.e. `…T14:00:00Z`/`…T17:00:00Z` for ET-summer), and `latitude=42.36`/`longitude=-71.06`.
  - the UNION returns a `entity_type='lead'` item for that lead with `start_at`=`lead_date_time`, `end_at`=`lead_end_date_time`, `status='Review'` (renders as a hold at that time — no schedule-render change needed).
- **Back-compat sub-assert:** a second `handleCreateLead` **without** `chosenSlot` → its row has `lead_date_time`/`lead_end_date_time` **NULL** and does **not** appear as a timed hold (AC-2 "no fabricated slot").

### VSE-INT-06: createLead tz-combine correct against a known EDT and EST instant (real write) — **P1**
- **Priority:** P1 · **Type:** Integration · **Scenario:** S2 (AC-2), verify-plan step 1
- **Steps:** create two held leads via `handleCreateLead` — one `chosenSlot.date` in July (EDT), one in January (EST) — read both rows.
- **Expected:** July row `lead_date_time` = `date+'T14:00:00.000Z'` for `start='10:00'`; January row = `date+'T15:00:00.000Z'`. Proves the persisted timestamp (not just the helper) is DST-correct end to end.

### VSE-INT-07: **S6 (P0)** — convert the held lead → job carries the slot; lead drops from occupancy + UNION
- **Priority:** P0 · **Type:** Integration · **Scenario:** S6 (spec scenario 5, AC-6), Decision F
- **Seed:** an open held lead `L` (coords + `lead_date_time`/`lead_end_date_time`, in range), present in occupancy and UNION (pre-assert both).
- **Steps:** `await leadsService.convertLead(L.uuid, { … timeslot start/end = the hold window … }, COMPANY_A)`; then re-run `_buildScheduledJobs` and the UNION; read the created job.
- **Expected:**
  - the resulting **job** has `start_date`/`end_date` = the slot (existing convert carries `zb_job_payload.timeslot.start/end` → job start/end).
  - `L` is **absent** from `_buildScheduledJobs` occupancy and from the leads UNION (left via the terminal-status filter) — **subject to the case-mismatch finding** (`convertLead` writes `'Converted'`): if the filter is case-sensitive lowercase, `L` would wrongly persist; this case then fails and flags it. The **job** now occupies the time via the jobs loop (assert the job appears in occupancy if it has coords).

### VSE-INT-08: **S7 (P0)** — markLost the held lead → drops from occupancy + UNION (slot freed); case-mismatch cross-check
- **Priority:** P0 · **Type:** Integration · **Scenario:** S7 (spec scenario 6, AC-6), Decision F + the lowercase-filter cross-check
- **Seed:** open held lead `L` (coords + window), pre-asserted present in occupancy + UNION.
- **Steps:** `await leadsService.markLost(L.uuid, COMPANY_A)` (sets `status='Lost'`); re-run `_buildScheduledJobs` and the UNION.
- **Expected:** `L` **absent** from both (slot freed) — no teardown code ran.
- **Cross-check (the load-bearing one):** because `markLost` writes **`'Lost'` capitalized** but the filter is `NOT IN ('converted','lost','spam')` lowercase without `LOWER()`, a naive implementation leaves `L` in the hold. Assert the **actual** behavior of the shipped query: the case **must** show `L` gone. If it does not, the harness FAILs and the report flags that the case (write-case vs filter-case) is unreconciled — AC-5/AC-6 "slot frees" cannot hold otherwise. (Also add a control lead pre-seeded directly with lowercase `status='lost'` to demonstrate the filter itself works on lowercase, isolating the mismatch to the write path.)

### VSE-INT-09: **S8 (P0)** — two callers: A's hold blocks; a second occupancy build still contains A
- **Priority:** P0 · **Type:** Integration · **Scenario:** S8 (spec scenario 7, AC-5)
- **Steps:**
  1. Caller A: `handleCreateLead` with a `chosenSlot` (coords) → hold `A`.
  2. `occ1 = _buildScheduledJobs(COMPANY_A, …)` → assert `A` present.
  3. Simulate Caller B's later lookup: `occ2 = _buildScheduledJobs(COMPANY_A, …)` again → assert `A` **still** present (the open held lead remains an occupancy that the engine sees, so B's overlapping window is de-prioritized/not re-offered).
- **Expected:** `A` in both `occ1` and `occ2`; A's window is a live occupancy for the next caller (prevents a double-hold). (Engine-level "not re-offered to B" is asserted end-to-end in `VSE-INT-10` when the engine is available; the occupancy-presence invariant here is the DB-only guarantee.)

### VSE-INT-10: S3 end-to-end deeper — recommendSlots returns ≤3 keyed slots; a deeper call excludes prior keys — **P1 (engine-gated)**
- **Priority:** P1 · **Type:** Integration (requires real engine + connected app; else `SKIP`) · **Scenario:** S1/S3 (AC-1/AC-3), verify-plan step 3
- **Steps:** call the real `recommendSlots` for a valid location → capture keys `Ka,Kb,Kc` (≤3); re-call with `excludeSlots:[Ka,Kb,Kc]` and/or `daysAhead` bumped.
- **Expected:** first call `available:true`, `slots.length ≤ 3`, each with a stable `key`; the deeper call returns a fresh set whose keys **exclude** `Ka/Kb/Kc` (AC-3), or `{available:false,fallback:true}` if the horizon is exhausted.

### VSE-INT-11: sabotage control — a deliberately-wrong expectation FAILs and exits 1, then restore — **P0**
- **Priority:** P0 · **Type:** Integration (negative control) · **Scenario:** harness integrity (mirrors `verify-tasks-count-001.js::TC-SABOTAGE`)
- **Steps:** seed the `VSE-INT-01` state, then assert the **wrong** thing — that the held open lead is **ABSENT** from occupancy — inside a try/catch expecting a `CheckError`; confirm the harness would report FAIL and `process.exit(1)` if that assertion were run as a real case; then restore the correct assertion (held lead PRESENT).
- **Expected:** the negative assertion trips the detector (proving a green run actually certifies the check works), and the true invariant (`L_open` present) still holds. Confirms the harness is not silently passing.

---

## C. Assistant JSON build/validate — `voice-agent/assistants/lead-qualifier-v2.json`

Node `JSON.parse` checks (a small script or a jest case, e.g. `backend/tests/config/leadQualifierV2Json.test.js`). Pre-feature the file has 5 tools (`identifyCaller, checkServiceArea, validateAddress, checkAvailability, createLead`) and a system prompt referencing `checkAvailability`, not `recommendSlots`.

### VSE-JSON-01: the assistant file parses as valid JSON — **P1**
- **Priority:** P1 · **Type:** Assistant-JSON · **Scenario:** AC-7
- **Expected:** `JSON.parse(fs.readFileSync('voice-agent/assistants/lead-qualifier-v2.json'))` succeeds; `model.tools` is an array; `model.messages[0].role==='system'` with non-empty `content`.

### VSE-JSON-02: model.tools[] contains a recommendSlots tool in the correct function/server shape — **P0**
- **Priority:** P0 · **Type:** Assistant-JSON · **Scenario:** AC-7, FR-6, Decision E
- **Expected:** a tool `t` with `t.type==='function'` and `t.function.name==='recommendSlots'`; `t.server.url` ends `/api/vapi-tools` and `t.server.secret==='REPLACE_WITH_VAPI_TOOLS_SECRET'` (repo placeholder — real secret injected at push, not in the repo JSON); `t.function.parameters.properties` includes the Decision-C args `zip, lat, lng, address, unitType, durationMinutes, excludeSlots, daysAhead`. Same shape as the existing `createLead` tool (compare `type`/`server` keys). Tool count is now 6.

### VSE-JSON-03: the scheduling prompt references recommendSlots + deeper + fallback + structured chosenSlot — **P1**
- **Priority:** P1 · **Type:** Assistant-JSON · **Scenario:** AC-7, FR-6, Decision E (steps 6 + 9)
- **Expected:** `model.messages[0].content` now **includes** `recommendSlots`; mentions offering the **top 2–3** windows, the **deeper**/"none suit" re-call with `excludeSlots`/`daysAhead`, the **fallback** to `checkAvailability`/callback on `available:false`, and passing the **structured `chosenSlot`** into `createLead`. Negative guard: it no longer instructs using `checkAvailability` as the *primary* scheduling call (checkAvailability may remain only as the named fallback). **The live assistant `30e85a87` is NOT asserted/pushed here** — repo JSON only (AC-7; live PATCH is a separate owner-gated step).

---

## Traceability (AC / scenario → cases)

| Spec | Cases |
|---|---|
| **AC-1** (≤3 engine-ranked, speakable+reconstructable) | VSE-U-08, VSE-U-12, VSE-INT-10 |
| **AC-2 / S2** (persist hold + renders; NULL when no pick) | **VSE-INT-05**, VSE-U-13, VSE-U-14, VSE-INT-06, VSE-U-01..03 |
| **AC-3 / S3** (deeper excludes prior / later window) | VSE-U-10, VSE-U-11, VSE-INT-10 |
| **AC-4 / S4** (fallback, never throws, lead still made) | VSE-U-04..07, VSE-U-16 |
| **AC-5 / S5,S8** (held lead blocks re-offer; freed after terminal) | **VSE-INT-01**, VSE-INT-02, VSE-INT-03, VSE-INT-09, VSE-INT-07, VSE-INT-08 |
| **AC-6 / S6,S7** (convert carries slot; lose frees; no teardown) | VSE-INT-07, VSE-INT-08 |
| **AC-7** (repo JSON tool-def + prompt; live not pushed) | VSE-JSON-01..03 |
| **AC-8** (DEFAULT_COMPANY_ID + x-vapi-secret; not via proxy) | VSE-U-04, VSE-U-13, VSE-U-17, VSE-INT-02 |
| Non-functional (cheap occupancy read; harness integrity) | VSE-INT-04, VSE-INT-11 |

**Lowest-value edge:** `VSE-U-09` (same-window-two-techs collapse, P2) guards the dedupe key, but the engine already de-duplicates windows — it's the first to cut under time pressure. All 31 cases are P0–P2 (no P3): every scenario in this feature is either happy-path, a documented safe-fail branch, or the load-bearing hold lifecycle, so nothing lands at true edge-case rarity.
