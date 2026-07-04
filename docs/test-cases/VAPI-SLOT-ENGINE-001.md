# Test Cases — VAPI-SLOT-ENGINE-001

Sara (VAPI voice agent) offers engine-ranked arrival windows on the call; the caller's
pick becomes a schedule-blocking **hold** on the lead until a dispatcher converts it
(→ job) or loses/cancels it (→ slot frees).

**Binding sources:** `docs/specs/VAPI-SLOT-ENGINE-001.md` (FR-1…FR-6, AC-1…AC-8, S1–S8,
edge cases 1–9) · `docs/architecture.md` §VAPI-SLOT-ENGINE-001.

**Scope:** backend + repo-config only. No migration, no frontend, no new hold-entity.
Company hardwired `DEFAULT_COMPANY_ID` in the VAPI path (as all VAPI tools).

## P0 release gates (red on any → blocks release)

| ID | Gate | Realized by |
|----|------|-------------|
| **VSE-INT-01** | Held-lead occupancy: **present** when open+geo+in-window; **absent** when terminal-status / geo-less / out-of-window | real-DB verify |
| **VSE-INT-05** | `createLead` persists real `TIMESTAMPTZ` + coords via `tzCombine`, renders on Schedule; no `chosenSlot` → four NULL cols | real-DB verify |
| **VSE-U-01** | `tzCombine` is DST-aware (EDT→UTC−4, EST→UTC−5, GMT/no-offset→0) | real-DB verify + unit |

The convert/lose free-the-slot chain (**VSE-INT-07 / VSE-INT-08**) is the load-bearing
proof that the case-insensitive terminal-status fix works: a capitalized `Converted`/`Lost`
lead must leave **both** the occupancy sub-read and the Schedule UNION. An independent
mutation test (revert `LOWER(status)` → bare `status NOT IN`) must flip VSE-INT-01/07/08 to
FAIL — proving the harness is non-vacuous.

---

## Integration — real local Postgres (`scripts/verify-vapi-slot-engine-001.js`, 8/8 PASS)

Row-targeted (tag `vse1%`), self-seeding/cleaning, coexists with real dev leads.

| ID | Pri | Scenario | Assertion |
|----|-----|----------|-----------|
| VSE-INT-01 | P0 | S5 — held lead in occupancy | Open+geo+in-window lead PRESENT as `{id:'lead:<id>', assigned_technicians:[]}` with correct date/window/lat/lng/duration; capitalized `Converted` + `Lost`, NULL-coords, and out-of-window leads all ABSENT |
| VSE-INT-05 | P0 | S2 — pick → hold persists + blocks | `createLead` body composed as `handleCreateLead` → `lead_date_time`/`lead_end_date_time` = `tzCombine` instants, lat/lng populated, status `Review`; renders on `scheduleQueries.getScheduleItems` leads-UNION and occupies the engine slot; no-`chosenSlot` create → all four columns NULL |
| VSE-INT-07 | P0 | S6 — dispatcher converts hold | `UPDATE status='Converted'` (exact value `convertLead` writes) DROPS the lead from occupancy AND Schedule UNION; window re-offerable |
| VSE-INT-08 | P0 | S7 — dispatcher loses/cancels | real `leadsService.markLost` (writes `Lost`) DROPS from both |
| VSE-U-01 | P0 | tz-combine correctness | real `tzCombine`: EDT→UTC−4, EST→UTC−5, MDT→UTC−6, UTC→offset 0 — exact instants |
| VSE-EXPLAIN | P1 | occupancy sub-read shape | held-lead sub-read is join-free / leads-only, date-windowed + company-scoped; `EXPLAIN` uses `idx_leads_lead_date_time` (no new index) |
| VSE-CFG | P1 | assistant JSON valid | `lead-qualifier-v2.json`: 6 tools, `recommendSlots` correct function/server shape + 8 params, prompt steps 6+9 reference `recommendSlots`/`chosenSlot`/`excludeSlots`; NOT pushed to live `30e85a87` |
| VSE-SABOTAGE | P0 | negative control | asserting a converted lead is still present must FAIL (independently verified: inverting VSE-INT-01's presence assertion yields FAIL + exit 1) |

---

## Unit — occupancy + case-fix + tz (`tests/slotEngineHeldLeads.test.js`, 11/11 PASS)

| ID | Pri | Case |
|----|-----|------|
| VSE-U-10 | P0 | `_buildScheduledJobs` appends an open geo held lead as `lead:<id>`, techs `[]` |
| VSE-U-11 | P1 | held lead with no end time → `window_end == start`, default duration (75) |
| VSE-U-12 | P0 | jobs AND held leads both emitted (holds appended after jobs; jobs loop unchanged) |
| VSE-U-13 | P1 | empty held-lead result → occupancy is jobs-only (no lead rows appended) |
| VSE-U-14 | P0 | sub-read SQL uses `LOWER(status) NOT IN (…)` + `company_id=$1` + coords + date-window guards |
| VSE-U-15 | P0 | `scheduleQueries` render half emits `LOWER(l.status) NOT IN (…)` in the leads UNION branch (case-fix) |
| VSE-U-01a | P0 | tzCombine EDT: Jul 8 10:00 America/New_York → 14:00Z (UTC−4) |
| VSE-U-01b | P0 | tzCombine EST: Jan 15 10:00 America/New_York → 15:00Z (UTC−5) |
| VSE-U-01c | P1 | tzCombine PDT: Jul 8 09:00 America/Los_Angeles → 16:00Z (UTC−7) |
| VSE-U-01d | P1 | tzCombine half-hour: Jul 8 10:00 Asia/Kolkata → 04:30Z (UTC+5:30) |
| VSE-U-01e | P1 | tzCombine UTC/'GMT' → offset 0 (no shift) |

> Note: `tzCombine` delegates to the canonical `backend/src/utils/companyTime.js:dateInTZ`
> (single source of the DST offset math, itself mirrored from frontend `companyTime.ts`).

---

## Unit — VAPI tool `recommendSlots` (`tests/routes/vapi-tools.test.js` Group 10, 14 PASS)

Gate = `isAppConnected(DEFAULT_COMPANY_ID, 'smart-slot-engine')`. Handler is entirely
safe-fail: gate-off / engine-not-ok / empty / any throw → `{available:false,slots:[],fallback:true}`,
HTTP 200 — **never a 500 that would crash the live call**.

| ID | Pri | Case |
|----|-----|------|
| VSE-T2-01 | P0 | app not connected → `{available:false,fallback:true}`, engine NEVER called |
| VSE-T2-02 | P0 | `engine_status:'unavailable'` → fallback |
| VSE-T2-03 | P1 | empty recommendations → fallback |
| VSE-T2-04 | P0 | `getRecommendations` throws → fallback, HTTP 200 (no 500) |
| VSE-T2-05 | P0 | happy path → maps recs to keyed slots with label + techName + confidence |
| VSE-T2-06 | P1 | more than 3 recs → capped to `MAX_SLOTS=3` |
| VSE-T2-07 | P1 | `excludeSlots` filters offered `date|start|end` keys |
| VSE-T2-08 | P1 | same window from two techs dedups to one slot |
| VSE-T2-09 | P1 | all recs excluded → fallback |
| VSE-T2-10 | P1 | `lat`+`lng` passed to engine as `new_job.lat/lng` (no address) |
| VSE-T2-11 | P1 | zip only → `new_job.address = zip`, default duration + job_type |
| VSE-T2-12 | P1 | `daysAhead` → `latest_allowed_date` set in engine input (company-local) |
| VSE-T2-13 | P0 | wrong `x-vapi-secret` → 401 (recommendSlots behind the shared secret) |
| VSE-T2-14 | P1 | envelope = `{results:[{toolCallId, result:JSON.stringify(...)}]}` |

---

## Unit — `handleCreateLead` slot-persist (`tests/routes/vapi-tools.test.js` Group 11, 5 PASS)

| ID | Pri | Case |
|----|-----|------|
| VSE-T2-20 | P0 | `chosenSlot` + lat/lng → `LeadDateTime`/`LeadEndDateTime`/`Latitude`/`Longitude` in body |
| VSE-T2-21 | P1 | `chosenSlot` without lat/lng → only `LeadDateTime`/`LeadEndDateTime` (no coords) |
| VSE-T2-22 | P0 | no `chosenSlot` → body has none of the four slot fields (byte-identical to pre-feature) |
| VSE-T2-23 | P0 | malformed `chosenSlot` (bad HH:MM) → treated as absent, lead created with NULL slot cols (never blocks creation) |
| VSE-T2-24 | P1 | `chosenSlot` missing `end` → treated as absent |

> Group 6 (existing `createLead` suite, 17 cases) re-run green → slot-persist is additive,
> the phone-origin/back-compat createLead path is unchanged.

---

## Coverage summary

**38 cases realized** (8 integration real-DB + 11 occupancy/tz unit + 14 recommendSlots unit
+ 5 slot-persist unit), all green. Full jest run across the three suites = **93 PASS**;
real-DB verify = **8/8 PASS** including all three P0 gates + a genuine sabotage control.
Reviewer (agent 08) reproduced every suite and the mutation test independently.

**Not covered by automated tests (accepted, per spec):** the engine-down end-to-end
*voice* flow (S4) and two-caller concurrency race (S8) are proven at the mechanism level
(fallback shape in Group 10; occupancy-sees-A's-hold in VSE-INT-01) but not as live VAPI
call transcripts — that is a live-push validation step, gated on the owner.
