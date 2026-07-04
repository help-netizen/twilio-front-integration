# VAPI-SLOT-ENGINE-001 — Sara offers engine-ranked windows on the call; the caller's pick becomes a schedule-blocking hold on the lead

**Status:** spec · **Date:** 2026-07-04 · **Owner:** Voice / Schedule / Leads
**Type:** feature — backend (new VAPI tool → `slotEngineService` directly, gated + safe-fail; `createLead` persists the chosen structured slot to `lead_date_time`/`lead_end_date_time`; the engine occupancy snapshot gains open held leads) + repo config (`voice-agent/assistants/lead-qualifier-v2.json`: new slot tool-def + scheduling-prompt rewrite).
**Scope guard:** **No frontend change, no migration, no new hold entity, no schedule-render change.** Sources: `Docs/requirements.md` §VAPI-SLOT-ENGINE-001 (FR-1…FR-6, AC-1…AC-8), `Docs/architecture.md` §VAPI-SLOT-ENGINE-001 (Decisions A–F).

## General description

Today Sara (Lead-Qualifier-v2, live assistant `30e85a87`) answers scheduling with the **generic** `checkAvailability` tool (`scheduleService.getAvailableSlots`, `vapi-tools.js:126`) and then **discards** the caller's pick — `preferredSlot` is only rendered into a `Comments` line (`Slot: ${preferredSlot || 'pending callback'}`, `buildCallSummary`, `vapi-tools.js:146`); `lead_date_time`/`lead_end_date_time` are never set, so the pick never becomes a hold. This feature (1) adds a **new VAPI tool `recommendSlots`** that calls the location-aware SLOT-ENGINE-001 ranker **directly** (not the auth'd proxy), (2) makes `handleCreateLead` **persist** the chosen structured slot to `lead_date_time`/`lead_end_date_time` (the hold, plus `latitude`/`longitude`), and (3) adds **open held leads to the engine's occupancy** (`buildScheduledJobs`) so the same window isn't re-offered. A hold is freed with **no teardown code** when a dispatcher **converts** (lead→job, carries the slot) or **loses/cancels** the lead — both drop out of the Schedule render and the engine occupancy via the existing terminal-status filter.

Binding owner decisions (D1–D3, interview closed): **D1** — offer 2–3 ranked slots; the pick is saved on the **LEAD** as a schedule-blocking hold, **not** an auto ZB job; a dispatcher CONFIRMS (convert) or CANCELS/LOSES. **D2** — "none suit" → the tool goes **deeper** (exclude offered slots and/or extend the date window). **D3** — location = validated address (lat/lng) else zip centroid; engine unavailable **or** `smart-slot-engine` not connected → graceful fallback, **never crash the call**.

## Component interaction

```
VAPI (assistant 30e85a87)
  └─ POST /api/vapi-tools  [x-vapi-secret vs VAPI_TOOLS_SECRET, fail-closed]  (vapi-tools.js:32/204)
       ├─ recommendSlots → handleRecommendSlots(args)                          [NEW]
       │     ├─ marketplaceService.isAppConnected(DEFAULT_COMPANY_ID, SMART_SLOT_ENGINE_APP_KEY)   (gate; marketplaceService.js:93, key 'smart-slot-engine')
       │     └─ slotEngineService.getRecommendations(DEFAULT_COMPANY_ID, { new_job:{…} })  DIRECT   (slotEngineService.js:152)
       │            └─ buildScheduledJobs(...) = jobs (existing) + OPEN HELD LEADS (NEW occupancy sub-read)   (slotEngineService.js:112)
       │                   └─ standalone slot engine  POST /api/v1/slot-recommendations  (4s timeout, safe-fail)
       └─ createLead → handleCreateLead(args + chosenSlot + lat/lng)           [EXTENDED]
             └─ leadsService.createLead(body, DEFAULT_COMPANY_ID)  → FIELD_MAP LeadDateTime/LeadEndDateTime/Latitude/Longitude → columns  (leadsService.js:132/149; UNCHANGED)

Schedule render (UNCHANGED): leadsQueries UNION already renders leads WHERE status NOT IN ('converted','lost','spam')  (scheduleQueries.js:136)
Confirm/cancel (UNCHANGED): convertLead status='Converted' + carries slot→job start/end (leadsService.js:655/757); markLost status='Lost' (leadsService.js:459)
```

The endpoint is **not** exposed via the auth'd proxy `POST /api/schedule/slot-recommendations` (that needs `authenticate` + `requireCompanyAccess` + `requirePermission('schedule.dispatch')`, `schedule.js:203`). VAPI is server-to-server with no session; the tool re-implements the **same** `isAppConnected` gate the proxy applies. The VAPI envelope (in `{ message.toolCallList[].function{name, arguments-JSON} }` → out `{ results:[{toolCallId, result: JSON.stringify(...)}] }`, `vapi-tools.js:214/244`) is **unchanged**.

## API / tool contracts

### `recommendSlots` (NEW tool → `handleRecommendSlots(args)`)

Dispatched in the `vapi-tools.js:214` switch alongside the existing handlers (`identifyCaller`/`checkServiceArea`/`validateAddress`/`checkAvailability`/`createLead`). Company hardwired to `DEFAULT_COMPANY_ID` (`'00000000-0000-0000-0000-000000000001'`, `vapi-tools.js:25`).

**Arguments** (all optional; the engine needs at least one location source):

| arg | type | meaning |
|---|---|---|
| `zip` | `string` | zip → geocoded to a centroid (passed as `new_job.address`); engine forces low confidence for a centroid. |
| `lat` | `number` | preferred: validated-address latitude (from `validateAddress`, `vapi-tools.js:113`). |
| `lng` | `number` | preferred: validated-address longitude. |
| `address` | `string` | full address string; geocoded by the engine when no `lat`/`lng`. |
| `unitType` | `string` | → `new_job.job_type = unitType ? unitType+' Repair' : 'Appliance Repair'` (mirrors `createLead`, `vapi-tools.js:177`). |
| `durationMinutes` | `number` | → `new_job.duration_minutes`; default `APPOINTMENT_DURATION_MIN` (`120`, `vapi-tools.js:27`). |
| `excludeSlots` | `string[]` | **deeper mode:** stable slot keys the agent echoes back from a prior offer; returned recs whose key ∈ `excludeSlots` are filtered out. |
| `daysAhead` | `number` | **deeper mode:** extends the horizon → `new_job.latest_allowed_date = today + daysAhead` (company-local). |

**Location resolution (FR-2, Decision C):** prefer `lat`+`lng` (both finite) → else `address` → else `zip` (as `address`). Built into `new_job.{lat,lng,address}` and handed to `getRecommendations`, which resolves the point via `resolveNewJobPoint` (`slotEngineService.js:66`) and throws `NEW_JOB_LOCATION_REQUIRED` (422) on none — caught by the handler → fallback (below). `exclude_job_id` is N/A (prospective caller, no existing job).

**`getRecommendations` call:** `slotEngineService.getRecommendations(DEFAULT_COMPANY_ID, { new_job: { lat, lng, address, job_type, duration_minutes, earliest_allowed_date?, latest_allowed_date? } })`. Horizon defaults inside the service: `earliest = today`, `latest = today + settings.horizon_days` (company-local, `slotEngineService.js:163-165`); `daysAhead` overrides `latest_allowed_date` on the deeper call. The service returns the pinned wrapper `{ recommendations, summary, engine_status:'ok'|'unavailable', coverage }` (`slotEngineService.js:225/207`).

**Result shape** (the `result` string the tool returns to VAPI):

```
{
  available: boolean,               // true only when engine_status:'ok' AND ≥1 slot survives filtering
  slots: [                          // capped to 3 via .slice(0,3)
    { key, date, start, end, label, techName?, confidence }
  ],
  fallback?: boolean                // true on any not-available path
}
```

- **Stable slot key** = `` `${date}|${time_frame.start}|${time_frame.end}` `` — deterministic, **tech-agnostic** (same window from a different tech collapses to one offer; makes `excludeSlots` round-trip correctly). This is the exact string the agent echoes into `excludeSlots` and — decomposed to `{date,start,end}` — into `chosenSlot`.
- Per-slot mapping from the pinned wrapper rec (Decision B): `date ← rec.date`, `start ← rec.time_frame.start`, `end ← rec.time_frame.end`, `confidence ← rec.confidence`, `techName ← rec.technicians?.[0]?.name` (optional, human-context only), `label` = a spoken window string, e.g. `"Tue Jul 8, 10:00–13:00"`.

### `createLead` (EXTENDED → `handleCreateLead(args)`)

`handleCreateLead` gains **optional** `chosenSlot` = `{ date:'YYYY-MM-DD', start:'HH:MM', end:'HH:MM' }` plus optional `lat`/`lng` args. When `chosenSlot` is present **and** valid (Decision D):
1. resolve company tz (below);
2. `lead_date_time = tzCombine(chosenSlot.date, chosenSlot.start, tz)`, `lead_end_date_time = tzCombine(chosenSlot.date, chosenSlot.end, tz)`;
3. add to the `createLead` body: `LeadDateTime`, `LeadEndDateTime`, and — when `lat`/`lng` are finite — `Latitude`, `Longitude`.

`FIELD_MAP` (`leadsService.js:132/133/149/150`) maps `LeadDateTime→lead_date_time`, `LeadEndDateTime→lead_end_date_time`, `Latitude→latitude`, `Longitude→longitude` — **no `leadsService` change**. The `Comments` summary line (`buildCallSummary`, including its `Slot: …` label) is **kept for human context** but is no longer the source of the hold — the structured columns are. Existing behaviour preserved verbatim: the phone-required guard (`!disqualified && (!phone || phone.length<5)`, `vapi-tools.js:166`), the 1-retry loop (`vapi-tools.js:190`), `JobSource`/`Status:'Review'`/disqualified handling, and "never block the call."

**Back-compat (AC-2/AC-4):** a `createLead` **without** `chosenSlot` (callback / fallback / caller didn't pick) behaves **exactly as today** — `lead_date_time`/`lead_end_date_time`/`latitude`/`longitude` stay NULL, no hold.

### tz-combine helper (NEW backend, mirrors frontend `dateInTZ`)

There is **no** backend wall-clock→ISO combine today (`slotEngineService`'s `localDate`/`localHHMM` are the inverse). Add a small local helper in `vapi-tools.js` that mirrors `frontend/src/lib/companyTime.ts:dateInTZ` (`companyTime.ts:17`) exactly:

```
tzCombine(dateStr 'YYYY-MM-DD', hhmm 'HH:MM', tz) → ISO string
  [y, mo, d]  = dateStr.split('-')        // mo is the real 1-based month
  [hh, mm]    = hhmm.split(':')
  utcGuess    = new Date(Date.UTC(y, mo-1, d, hh, mm, 0))
  offsetMin   = tzOffsetMinutes(utcGuess, tz)     // parse Intl.DateTimeFormat('en-US',{timeZone:tz,timeZoneName:'longOffset'}) → "GMT±HH:MM" → sign*(HH*60+MM); 'GMT' or no-match → 0
  return new Date(utcGuess.getTime() - offsetMin*60000).toISOString()
```

`tzOffsetMinutes` is copied verbatim from `companyTime.ts:112` (sign: `'+'→1, '-'→-1`; the offset is **subtracted** from the UTC guess). **Company tz** resolves the same way the engine does: `scheduleService.getDispatchSettings(companyId).timezone`, fallback `'America/New_York'` (mirror `slotEngineService.resolveTimezone`, `slotEngineService.js:55`). Correctness check: `tzCombine('2026-07-08','10:00','America/New_York') === '2026-07-08T14:00:00.000Z'` (EDT = UTC−4); a January date → UTC−5 (EST).

### Held-lead occupancy (FR-5, Decision A — the ONLY occupancy change)

Extend `slotEngineService.buildScheduledJobs(companyId, startDate, endDate, tz, excludeJobId)` (`slotEngineService.js:112`): after the existing jobs loop, append **open held leads** via a new small company-scoped sub-read (no reusable lead-occupancy getter exists). The filter mirrors the leads-in-Schedule UNION **verbatim** (`scheduleQueries.js:136`, lowercase — **NOT** the capitalized `('Lost','Converted')` set used by the lead-by-phone/contact lookups at `leadsService.js:191/1055/1112/1162`):

```sql
SELECT id, lead_date_time, lead_end_date_time, latitude, longitude, job_type
FROM leads
WHERE company_id = $1
  AND status NOT IN ('converted','lost','spam')          -- verbatim, lowercase (scheduleQueries.js:136)
  AND lead_date_time IS NOT NULL
  AND latitude IS NOT NULL AND longitude IS NOT NULL
  AND lead_date_time >= ($2::date::timestamp AT TIME ZONE $4)                        -- dayLower style (scheduleQueries.js:66)
  AND lead_date_time <  (($3::date + INTERVAL '1 day')::timestamp AT TIME ZONE $4)   -- dayUpper style
```

Each row → the **same** occupancy shape a job produces (reusing the module's `localDate`/`localHHMM`/`minutesBetween`):

```
{
  id: 'lead:' + id,
  date: localDate(lead_date_time, tz),
  status: 'scheduled',
  job_type: job_type || 'unknown',
  window_start: localHHMM(lead_date_time, tz),
  window_end: localHHMM(lead_end_date_time || lead_date_time, tz),
  lat: latitude, lng: longitude,
  duration_minutes: minutesBetween(lead_date_time, lead_end_date_time) || DEFAULT_DURATION_MINUTES,   // 75, slotEngineService.js:19
  assigned_technicians: []          // UNASSIGNED hold → route-blocking time+place for ANY tech in the area
}
```

`assigned_technicians: []` means the engine treats the hold as an area occupancy (it doesn't pin one tech's route) — exactly "don't re-offer this window near here" (AC-5, scenario 7). Because `buildScheduledJobs` is shared by the VAPI path **and** the dispatcher proxy path, holds block re-offering **everywhere**. A lead **without** finite lat/lng is silently skipped by the engine's own occupancy guard (`slotEngineService.js:121`) — it still renders on the Schedule but can't block routing; accepted for v1 (FR-5 note), minimized because Decision D writes lat/lng whenever the agent has them.

### Gating + safe-failure (FR-1, AC-4, Decision C)

`handleRecommendSlots` steps, all inside one try/catch:
1. `await marketplaceService.isAppConnected(DEFAULT_COMPANY_ID, marketplaceService.SMART_SLOT_ENGINE_APP_KEY)` → if **not connected**, return `{ available:false, slots:[], fallback:true }` **without** calling the engine.
2. Else `await getRecommendations(...)`. If `engine_status:'unavailable'` (the service's own safe-failure: engine down / non-2xx / timeout / no `SLOT_ENGINE_URL`, `slotEngineService.js:207/221/233`) **or** `recommendations:[]` after filtering → `{ available:false, slots:[], fallback:true }`.
3. Any thrown error (incl. `NEW_JOB_LOCATION_REQUIRED` from a bad location) → same fallback (never a 500).

The engine's 4 s timeout (`ENGINE_TIMEOUT_MS`, `slotEngineService.js:20`) keeps the tool p95 < 2000 ms on the happy path; a slow engine falls back. **The call never breaks; lead creation is never blocked** (LQV2 rule).

### Repo assistant JSON (FR-6, Decision E — `lead-qualifier-v2.json` ONLY)

Confirmed against the file: `model.tools[]` currently holds **5** tools, each shaped `{ type:'function', server:{ url:'https://api.albusto.com/api/vapi-tools', secret:'REPLACE_WITH_VAPI_TOOLS_SECRET' }, function:{ name, description, parameters:{ type:'object', properties } } }`.

- **New tool-def** appended to `model.tools[]` in that same shape: `function.name = 'recommendSlots'`, `parameters.properties = { zip, lat, lng, address, unitType, durationMinutes, excludeSlots, daysAhead }` (`excludeSlots` an array of strings), `server.secret = 'REPLACE_WITH_VAPI_TOOLS_SECRET'` (repo convention; the real secret is injected at push time).
- **Scheduling-prompt rewrite** in the system prompt (`model.messages[0].content`):
  - **Step 6 "OFFER A CONCRETE WINDOW"** (currently "Call checkAvailability and offer the soonest 2-3…"): → call **`recommendSlots`** with the validated lat/lng (else zip); offer the **top 2–3** returned windows verbatim ("Tuesday between 10 and 1, or Wednesday 1 to 4 — which works?"); on **"none suit"** → re-call `recommendSlots` in **deeper** mode (echo the already-offered slot **keys** in `excludeSlots` and/or bump `daysAhead`) and offer a fresh 2–3; on **`available:false`/`fallback:true`** (engine down or app not connected) → degrade to the existing **`checkAvailability`** generic path or offer a callback — never crash, never invent a window.
  - **Step 9 "CREATE LEAD"** (currently passes `preferredSlot`): → also pass the **structured `chosenSlot`** (`{date,start,end}` of the accepted window) into `createLead`; `preferredSlot` text may remain for the human summary.

This edits **only** the repo JSON. Pushing the **live** assistant (`30e85a87`) is a **separate owner-consent-gated `PATCH api.vapi.ai` prod step** (get-first — it drifts; REST PATCH — the CLI `update` panics; re-inject `VAPI_TOOLS_SECRET` into every `model.tools[].server`; keep `answerOnBridge="true"`) — explicitly **NOT** in this pipeline (AC-7).

## Behavior scenarios

### S1 — Caller gives zip/address → agent offers 2–3 concrete ranked windows
- **Preconditions:** `smart-slot-engine` connected; engine reachable; caller in-area (already checked by `checkServiceArea`); `validateAddress` ran (lat/lng available) or a zip is known.
- **Steps:** agent calls `recommendSlots` with lat/lng (else zip) + unitType/durationMinutes → gate passes → `getRecommendations` → engine returns ranked recs → tool maps to `{available:true, slots:[≤3 keyed windows]}`.
- **Result:** agent reads back the **top 2–3** concrete windows (never "morning"). (AC-1.)
- **Side effects:** none (read-only).

### S2 — Caller picks a window → lead created as a schedule-blocking hold
- **Preconditions:** S1 returned slots; caller accepts one; phone collected (step 7).
- **Steps:** agent calls `createLead` with the usual fields **plus** `chosenSlot={date,start,end}` (decomposed from the picked slot key) + `lat`/`lng` → `handleCreateLead` composes `lead_date_time`/`lead_end_date_time` via `tzCombine`, adds `Latitude`/`Longitude` → `leadsService.createLead`.
- **Result:** the lead row has `lead_date_time`/`lead_end_date_time` set to the chosen window **and** `latitude`/`longitude` populated; the lead renders on the **Schedule** at that time (status `Review`, non-terminal) via the existing UNION, occupying the slot. (AC-2.)
- **Side effects:** DB insert; `emitLeadChange('lead.created', …)` (`leadsService.js`, existing).

### S3 — Caller rejects all offered windows → agent goes deeper
- **Preconditions:** S1 offered a set; caller says "nothing that week."
- **Steps:** agent re-calls `recommendSlots` in **deeper** mode — `excludeSlots` = the previously-offered keys and/or `daysAhead` = a larger horizon → tool filters recs whose key ∈ `excludeSlots` and extends `latest_allowed_date`.
- **Result:** a fresh `{available:true, slots:[…]}` that **excludes** the prior keys and/or covers a **later** window; no already-offered slot returns twice. Repeatable within the call until a pick or a callback. (AC-3.)
- **Side effects:** none.

### S4 — Engine not connected OR down → graceful fallback, call continues
- **Preconditions:** `smart-slot-engine` **not** connected, **or** the engine returns `engine_status:'unavailable'`/empty, **or** any throw.
- **Steps:** `handleRecommendSlots` returns `{available:false, slots:[], fallback:true}` (gate short-circuits, or safe-failure, or catch).
- **Result:** the agent degrades to the generic `checkAvailability` path (or offers a callback) and completes the call; a lead is still created (slot columns NULL). No unhandled error reaches the call. (AC-4.)
- **Side effects:** none from the slot tool; a normal lead may still be created.

### S5 — A held lead is in the engine occupancy → the same window is NOT re-offered
- **Preconditions:** an open held lead (S2) with `lead_date_time` + coords exists in-window.
- **Steps:** a **second** `recommendSlots` call for an overlapping location/time → `buildScheduledJobs` includes the held lead (mapped `assigned_technicians:[]`) → engine treats it as an area occupancy.
- **Result:** that window is **not** re-offered to the second caller (double-hold prevented). (AC-5, scenario 7.)
- **Side effects:** none.

### S6 — Dispatcher converts the hold → job takes the slot, hold clears
- **Preconditions:** an open held lead exists.
- **Steps:** dispatcher **converts** it → `convertLead` sets `status='Converted'` and carries `zb_job_payload.timeslot.start/end` → the job's `start_date`/`end_date` (`leadsService.js:655/757`).
- **Result:** the now-`Converted` lead drops out of the occupancy sub-read **and** the Schedule UNION via the terminal-status filter; the **job** occupies the time via `buildScheduledJobs`' existing jobs loop. Seamless replacement, **no teardown**. (AC-6, Decision F.)
- **Side effects:** existing convert side effects (job create/ZB, `lead.updated`).

### S7 — Dispatcher loses/cancels → status Lost → slot frees
- **Preconditions:** an open held lead exists.
- **Steps:** dispatcher marks it **lost** → `markLost` sets `status='Lost'` (`leadsService.js:459`).
- **Result:** the lead drops out of both the occupancy sub-read and the Schedule via the same filter, freeing the slot. No teardown. (AC-6, Decision F.)
- **Side effects:** existing markLost side effects.

### S8 — Two callers, same window (concurrency)
- **Preconditions:** Caller A holds Tue 10–1 (S2).
- **Steps:** Caller B calls shortly after → `recommendSlots` (S5 mechanics) sees A's hold in occupancy.
- **Result:** Tue 10–1 is **not** re-offered to B (or de-prioritized), preventing a double-hold on the same slot. (Scenario 7.)
- **Side effects:** none.

## Edge cases

1. **No location at all** (no lat/lng, no address, no zip) → `resolveNewJobPoint` throws `NEW_JOB_LOCATION_REQUIRED` → caught → `{available:false, fallback:true}` (never a 500). Agent degrades.
2. **Zip-only caller** → geocoded to a centroid; the engine forces low confidence. If the created lead ends up with **no** lat/lng (agent had zip only, never `validateAddress`), the hold **renders** on the Schedule but does **not** block the engine (skipped at `slotEngineService.js:121`) — accepted for v1.
3. **Engine returns > 3 recs** → `.slice(0,3)` caps the offer to 3.
4. **All engine recs are in `excludeSlots`** (deeper mode exhausted the near horizon) → `slots:[]` after filtering → `available:false, fallback:true` → agent offers a callback / generic path.
5. **Duplicate window from two techs** → collapses to one key (`date|start|end`), one offer.
6. **`chosenSlot` present but malformed** (missing field / bad `HH:MM`) → treat as absent: skip the slot write, create the lead with NULL columns (never block). Comments summary still records `preferredSlot` text.
7. **`chosenSlot` present, `lat`/`lng` absent** → write `LeadDateTime`/`LeadEndDateTime` only; the hold renders but is coordinate-less (edge case 2).
8. **Status-case fidelity (verify-critical).** `markLost`/`convertLead` write **capitalized** `'Lost'`/`'Converted'`; `createLead` stores `status` verbatim (VAPI sets `'Review'`); `leads.status` has no normalization trigger (`004_create_leads.sql:11`, `VARCHAR(80) DEFAULT 'Submitted'`). The occupancy filter and the Schedule UNION both use **lowercase** `NOT IN ('converted','lost','spam')`, which in a case-sensitive Postgres `NOT IN` would **not** exclude a capital-`C` `'Converted'` row. The spec **mirrors the pinned lowercase filter verbatim** (architecture directive — the occupancy add must match the render exactly, so a converted lead leaves both or neither). The Tester **must** prove S6/S7 end-to-end on a real DB: after convert/lose, confirm the lead actually drops from **both** the occupancy sub-read and the Schedule UNION. If it does not, the render itself has the same latent quirk and a case-normalization fix (out of this feature's scope) is a separate finding — do **not** silently switch the occupancy filter to the capitalized set, or the two would diverge.
9. **Slow engine** (< 4 s timeout but adds latency) → within tool p95 budget; > 4 s → engine aborts → safe-failure → fallback.

## Error handling

1. `isAppConnected` false → `{available:false, slots:[], fallback:true}` (no engine call). Agent → generic/callback.
2. `getRecommendations` `engine_status:'unavailable'` or empty → same fallback.
3. Any throw in `handleRecommendSlots` → caught → same fallback (never propagates to the envelope as an error).
4. A failure of the slot tool never blocks lead creation; the existing 1-retry loop + phone guard are untouched. On repeated `createLead` failure the existing `{success:false, error:…}` is returned (unchanged) — the agent doesn't mention it (prompt rule).
5. The top-level router try/catch (`vapi-tools.js:251`) remains the last-resort 500 guard; the new tool should never reach it (it self-handles).

## Security & data isolation

- **Single-tenant, hardwired:** `recommendSlots` and the `createLead` slot-write use `DEFAULT_COMPANY_ID` (seed …0001), like the other VAPI tools; the occupancy sub-read is `WHERE company_id = $1` bound to that constant. No cross-tenant read/write; no per-request company inference at the vapi-tools layer (tenant context = the assistant assignment). (AC-8.)
- **Auth unchanged / fail-closed:** the endpoint stays behind `x-vapi-secret` vs `VAPI_TOOLS_SECRET` (`vapi-tools.js:32`, 503 when unset, 401 on mismatch). The slot engine is **not** exposed via the auth'd proxy — the proxy's `authenticate`+`schedule.dispatch` is **not** weakened or shared.
- **Envelope invariant:** the `{ results:[{toolCallId, result: JSON.stringify(...)}] }` shape is preserved for the new tool.

## Involved modules & files to change

| File | Change |
|---|---|
| `backend/src/routes/vapi-tools.js` | Add `handleRecommendSlots(args)` (gated on `isAppConnected(DEFAULT_COMPANY_ID, SMART_SLOT_ENGINE_APP_KEY)`, calls `slotEngineService.getRecommendations` directly, maps wrapper recs → `{key,date,start,end,label,techName?,confidence}` capped to 3, `excludeSlots`+`daysAhead` deeper mode, safe-fail → `{available:false,slots:[],fallback:true}`) + dispatch `recommendSlots` in the switch. Extend `handleCreateLead` to accept `chosenSlot`+`lat`/`lng` → add `LeadDateTime`/`LeadEndDateTime`/`Latitude`/`Longitude` to the body when present (keep Comments summary; NULL when absent). Add `tzCombine` + `tzOffsetMinutes` (mirror `companyTime.ts`) + a company-tz resolve (mirror `resolveTimezone`). `require` `marketplaceService` + `slotEngineService`. |
| `backend/src/services/slotEngineService.js` | Extend `buildScheduledJobs` to append open non-terminal held leads (`status NOT IN ('converted','lost','spam')` verbatim, `lead_date_time NOT NULL`, coords NOT NULL, date-windowed, company-scoped) via a new small query, mapped to the existing occupancy shape (`localDate`/`localHHMM`/`minutesBetween`, `assigned_technicians:[]`). **Only** occupancy change; no scoring/contract change. |
| `voice-agent/assistants/lead-qualifier-v2.json` | Add the `recommendSlots` tool-def to `model.tools[]` (same `function`/`server` shape, `REPLACE_WITH_VAPI_TOOLS_SECRET`); rewrite scheduling-prompt steps 6 + 9. Repo JSON only — live PATCH is a separate owner-gated step. |

**Reused unchanged:** `marketplaceService.isAppConnected` + `SMART_SLOT_ENGINE_APP_KEY`; `leadsService.createLead`/`convertLead`/`markLost` + `FIELD_MAP`; the leads-in-Schedule UNION + its status filter; `scheduleService.getAvailableSlots` (stays the fallback path); the slot engine + the auth'd proxy + `CustomTimeModal`; `leads.lead_date_time`/`lead_end_date_time`/`latitude`/`longitude` (mig 004).

## Constraints / non-goals

- **No migration.** `lead_date_time`/`lead_end_date_time` (`TIMESTAMPTZ`) + `latitude`/`longitude` (`NUMERIC(10,7)`) exist (`004_create_leads.sql`); `FIELD_MAP` maps all four; index `idx_leads_lead_date_time` exists. **Max migration on disk = 155** (`155_backfill_outbound_email_links.sql`); no `156`. No supporting index (the held-lead read is date-windowed + company-scoped + small — `EXPLAIN` on the prod copy per the verify plan to confirm no seq-scan regression).
- **Do NOT reuse the auth'd proxy.** The new tool calls `slotEngineService.getRecommendations` directly and re-implements the same gate; the proxy's auth is unweakened.
- **Company hardwired** to `DEFAULT_COMPANY_ID`, like the other VAPI tools; no per-request company inference here.
- **Safe-failure never crashes the call**; lead creation is never blocked by the slot tool; tool p95 < 2000 ms target intact on the happy path.
- **Persist a structured slot, not a text label** — real `TIMESTAMPTZ`s from `date`+window (company-local), not a "Slot: …" string.
- **The hold is a lead in a non-terminal status carrying `lead_date_time`; confirm/cancel free it via existing status filters** — no hold lifecycle/teardown. Mirror the leads-in-Schedule set **verbatim** (`status NOT IN ('converted','lost','spam')`, lowercase); do **not** use the capitalized `('Lost','Converted')` set from the lead-by-phone/contact lookups (edge case 8).
- **Live VAPI push** (`30e85a87` via `PATCH api.vapi.ai`) is a **separate owner-consent-gated prod step** (per-deploy consent); this pipeline changes only the repo JSON. Deploy to prod (and the live push) only with explicit owner consent.
- **Out of scope:** auto-creating a ZB job from the call (D1: only a held lead; convert makes the job); any Schedule-render / new hold-entity / holds-migration change; changing the engine's scoring/ranking/config or its output contract (only its occupancy **input** gains held leads); reworking the generic `getAvailableSlots`/`checkAvailability` fallback and the dispatcher `CustomTimeModal`/proxy path; multi-technician team holds; any frontend change.

## Verify plan (real DB + real engine; assistant JSON validated, not pushed)

Jest mocks the DB (LIST-PAGINATION-001 / created_by-FK lessons — a slot-persist or occupancy-read bug hides in a string-only mock), so against a **prod-DB copy** + the **real** slot engine:

1. **Real `createLead` slot write** — call `handleCreateLead` with a `chosenSlot` + phone → assert the row has `lead_date_time`/`lead_end_date_time` set to the composed timestamps **and** `latitude`/`longitude` populated (verify `tzCombine` against a known EDT/EST instant, e.g. `2026-07-08 10:00 America/New_York` → `…T14:00:00.000Z`); a `createLead` **without** `chosenSlot` → all four columns NULL (back-compat).
2. **Real occupancy-with-held-leads** — insert a non-terminal lead with `lead_date_time` + coords, run `getRecommendations` for an overlapping location → that window is **not** offered (AC-5, S5); flip the lead to `Converted`/`Lost` → the window **is** offered again (proves edge case 8 in practice); `EXPLAIN` the held-lead sub-read → date-windowed/small, no seq-scan.
3. **End-to-end tool** against the real engine — `recommendSlots` returns ≤3 keyed slots; a **deeper** call with `excludeSlots` returns a fresh set that excludes the prior keys (AC-3).
4. **Engine-down fallback** — stop the engine (or unset `SLOT_ENGINE_URL`, or disconnect the marketplace app) → `recommendSlots` returns `{available:false, fallback:true}` (never throws), and a `createLead` still succeeds with NULL slot columns (AC-4).
5. **Assistant JSON validated** — `JSON.parse` clean, `model.tools[]` has `recommendSlots` in the correct `function`/`server` shape with the 8 parameters, scheduling prompt steps 6+9 updated — but **NOT** pushed to `30e85a87` (owner-gated).

Jest still covers the gated / safe-fail / deeper branches, the `createLead` slot-persist mapping, `tzCombine` unit correctness, and company scope.
