# TECH-SCHEDULE-001 — Technician schedules and service areas

Status: refined implementation spec; owner decisions locked 2026-07-18. This document does not authorize production changes by itself.

Mockup: `/private/tmp/claude-501/-Users-rgareev91-contact-center-twilio-front-integration--claude-worktrees-distracted-ptolemy-8a1394/3c6d786a-dab4-4b98-ae9c-7f69cb25f8fe/scratchpad/mockup-tech-schedule.html`

## Goal

Make `/settings/technicians` the canonical settings surface for the active Zenbooker service-provider roster. Show every technician's effective recurring schedule in the list; open a right-side settings panel for weekly hours and Albusto service-area assignments. Derived non-working hours must reuse the existing time-off availability seam and grey hatch. Smart slot suggestions exclude unavailable technicians; manual booking remains possible with a warning.

## Locked product decisions

1. A missing technician schedule inherits `dispatch_settings`; the inherited seven-day schedule remains visible and read-only while **Duplicate company schedule** is checked.
2. A custom schedule has one interval or **Day off** per company-local weekday. A technician may start earlier or end later than company hours on a company-working day; the panel shows a notice. A company-closed day is absolute: the effective technician day is closed and cannot be overridden.
3. Recurring non-working hours are derived for each requested date. They are never inserted into `technician_time_off`; that table remains explicit exceptions only.
4. Derived gaps and explicit time off become one effective-unavailability collection. Every existing technician-aware time-off renderer and warning consumer uses that collection and the existing hatch styling.
5. Hatch scope is Timeline, Team Week, mobile Day, and `CustomTimeModal`. Generic Day/Week, Month, and List do not gain schedule-gap rendering because they are not technician-aware in the required way.
6. Smart recommendations suppress any arrival window that overlaps an explicit time-off interval or a derived schedule gap. Manual create, drag/drop, reschedule, and slot selection remain warning-only.
7. A technician-schedule read failure falls back to the resolved company schedule, never to all-day availability. If the company schedule itself cannot be resolved, smart recommendations fail closed with no recommendations and the settings UI shows an error; it must not fabricate hours.
8. Service areas use Albusto data, never `TeamMember.assigned_territories` from Zenbooker:
   - **Districts** are the existing ZIP groups stored in `service_territories.area`. The existing database/API value `active_mode='list'` remains for compatibility; the UI label is **Districts**.
   - **Radii** are the existing `territory_radii` rows.
   - Both relationships are many-to-many: each technician can have several targets and each target can have several technicians.
   - District and radius assignments are stored independently. Changing `company_territory_settings.active_mode` changes no assignment row, so switching back restores the previous mode's setup.
   - Zero valid assignments in the active mode means **wildcard**, not “serves nowhere”: the technician receives requests from every active-mode target. There is no stored `all` row or boolean.
   - `/settings/service-territories` renders one persistent, non-dismissible notice per active technician who is wildcard in the active mode. Two wildcard technicians produce two notices. A notice disappears only after that technician has at least one valid assignment in that mode.
   - The same assignment service supports replacement from the technician panel and reverse replacement from a district/radius panel.
9. `/settings/providers` is untouched in this feature.

## UX contract

### Technician list and panel

- The list is the active Zenbooker roster, not technicians inferred from historical jobs (`technicianProfilesService.js:19-37`). Each row shows name, schedule state (company/custom), a compact seven-day effective-schedule summary, active-mode area summary, and an exceeds-company-hours badge when relevant.
- Clicking a row opens `<Dialog><DialogContent variant="panel">` with `DialogPanelHeader`, `DialogBody`, and `DialogPanelFooter`. The existing photo/base controls may remain in the panel; they must not prevent the schedule half from shipping.
- With **Duplicate company schedule** on, all seven rows mirror company hours and are disabled. Turning it off shows the saved custom week. Saving inheritance does not delete the saved custom week, so turning inheritance off later restores it.
- Company-closed rows always show **Day off · Company closed**, with the working control disabled in both inheritance states.
- Custom hours wider than company hours on an open day are saved and produce a visible, non-blocking notice naming the affected day and company interval.
- The service-area section has Districts/Radii tabs and multi-select tiles. Both tabs remain editable; the inactive one is labelled **Saved for later**. Empty selection explains wildcard behavior rather than reporting a validation error.

### Service Territories

- Keep the existing mode switch and “both setups are saved” explanation (`ServiceTerritoriesPage.tsx:645-660`). Relabel list mode as Districts.
- Put the per-technician wildcard notices immediately after the mode control. They have no close action and are recomputed from the active roster plus valid assignments.
- Each district and radius tile shows assigned technicians and opens a right-side assignment panel with an active-technician multi-select. Empty direct assignment is valid because wildcard technicians can still receive that target.
- If the active roster cannot load, show a persistent roster-load error and disable assignment writes. Never render an empty warning stack as though every technician were assigned.
- An empty territory dataset is still valid. Every active technician is wildcard and therefore gets an individual warning; requests are not silently starved.

### Availability surfaces

- Keep the existing diagonal grey hatch exactly: `repeating-linear-gradient(135deg, rgba(25, 25, 25, 0.04) 0 10px, rgba(25, 25, 25, 0.08) 10px 20px)` (`TimelineView.tsx:435-468`, `TimelineWeekView.tsx:321-342`, `DayView.tsx:208-240`, `CustomTimeModal.css:301-325`). `CustomTimeModal` keeps its existing dashed outline.
- A block label comes from `kind`: **Time off** for persisted exceptions and **Outside work schedule** for derived gaps. Both are non-interactive and render below jobs.
- The same overlap helper drives manual warnings. A warning never disables Save/Confirm.

## UX states

| State | Technician panel/list | Schedule and picker | Smart recommendations | Territory page |
|---|---|---|---|---|
| No schedule row | Show inherited company week | Hatch company-schedule gaps | Suppress outside company week | Unrelated |
| Inheritance on | Visible, read-only company week | Same as company week | Same as company week | Unrelated |
| Custom day off | Day off | Full-day hatch for that technician | No overlapping suggestions | Unrelated |
| Custom wider than company, company open | Save; show exceeds-hours notice | Hatch only outside custom interval | Existing candidates inside custom interval survive | Unrelated |
| Company closed, custom data says working | Show closed disabled; server effective day remains closed | Full-day hatch | No suggestions for that day | Unrelated |
| Technician schedule query fails | Show error/degraded badge and company week | Company-week gaps, never empty/all-day-open | Use company week | Unrelated |
| Company schedule cannot resolve | Error; no fabricated hours | Availability error state | Empty, `engine_status='unavailable'` | Unrelated |
| No active-mode area assignments | Explain wildcard | Manual lane remains selectable | Technician is eligible for every resolved target | One persistent notice for that technician |
| Assignments exist only in inactive mode | Show them as **Saved for later** | Unchanged | Active mode still treats technician as wildcard | Active-mode notice remains |
| Company has no targets in active mode | Empty state | Manual remains allowed | All technicians are wildcard; area filtering is a no-op | One notice per active technician |
| Roster load fails | Disable area writes | Existing schedule behavior remains | Do not fabricate assignment matches | Persistent load error; do not hide warnings as “none” |
| Request target cannot be resolved | Manual warning, no block | Selectable | Return no smart suggestions rather than invent a match; wildcard semantics resume once a target resolves | Unrelated |

## Data model

### Migration allocation

Rechecked after the parallel migration landed at `2026-07-18T17:35:30Z`:

- Local `origin/master` is `3c9be185f04ba7db793457ce04f929ac73074c8a`, maximum `182_zb_payment_methods.sql`.
- Schedule pair: `183_technician_work_schedules.sql` / `rollback_183_technician_work_schedules.sql`.
- Territory pair: `184_technician_service_area_assignments.sql` / `rollback_184_technician_service_area_assignments.sql`.

Migrations 183 and 184 are uncommitted allocations. Re-run the same check before integration if `origin/master` advances again.

### Migration 183 — recurring schedules

`technician_work_schedules`

| Column | Type / rule |
|---|---|
| `company_id` | UUID, FK `companies(id)` cascade, composite PK |
| `technician_id` | TEXT Zenbooker team-member id, composite PK |
| `inherits_company_schedule` | BOOLEAN not null default true |
| `created_by`, `updated_by` | nullable UUID FK `crm_users(id)`; use `req.user.crmUser.id`, never Keycloak `sub` |
| `created_at`, `updated_at` | timestamptz not null default now |

`technician_work_schedule_days`

| Column | Type / rule |
|---|---|
| `company_id`, `technician_id` | composite FK to parent, cascade; part of PK |
| `day_of_week` | smallint 0–6 in the same convention as `dispatch_settings.work_days`; part of PK |
| `is_working` | boolean not null |
| `work_start_time`, `work_end_time` | time; both required with `start < end` when working, both null when off |

The parent may exist with inheritance on and retained child rows. Missing parent is equivalent to inheritance on. No technician-name snapshot and no timezone are stored.

### Migration 184 — mode-preserving assignments

`technician_district_assignments`

| Column | Type / rule |
|---|---|
| `company_id` | UUID FK companies, part of PK |
| `technician_id` | TEXT Zenbooker id, part of PK |
| `district_name` | TEXT equal to the current `service_territories.area` value, including `''` for the UI's **Uncategorized ZIPs** group; part of PK |
| `created_by`, `created_at` | nullable crm-user FK and timestamptz |

`technician_radius_assignments`

| Column | Type / rule |
|---|---|
| `company_id`, `technician_id`, `radius_id` | composite PK |
| `radius_id` | UUID; composite `(company_id, radius_id)` FK to `territory_radii(company_id, id)` cascade |
| `created_by`, `created_at` | nullable crm-user FK and timestamptz |

Migration 184 adds a non-partial unique key on `territory_radii(company_id, id)` for the tenant-safe composite FK. There is deliberately no wildcard row. Active district reads join current `SELECT DISTINCT area` values; stale names do not count as assignments. ZIP bulk replacement prunes district-assignment names that no longer exist in the same transaction, so stale rows cannot turn “zero valid assignments” into “serves nowhere.” Radius deletion cascades only its radius-assignment rows; the other mode is untouched.

## Effective schedule and unavailability seam

1. Resolve `dispatch_settings` in company timezone (`scheduleService.js:14-23, 667-673`).
2. Read technician settings for the requested roster. Missing row, inheritance on, or a technician-override query failure means the company week. Return `degraded_to_company_schedule=true` on query failure so the UI can disclose it.
3. For each company-local date:
   - If its weekday is absent from company `work_days`, effective result is day off regardless of stored technician data.
   - Otherwise inheritance uses company start/end; custom uses its one interval or day off. Custom start/end may exceed company start/end.
4. Convert local day boundaries and effective interval boundaries with the canonical company-timezone helper. Derive the half-open complement `[dayStart, workStart)` plus `[workEnd, nextDayStart)`, or the full day when off. This remains correct across DST.
5. Union those derived blocks with explicit `technician_time_off` rows into `UnavailabilityBlock[]`:

```ts
type UnavailabilityBlock = {
  id: string; // persisted UUID or stable `schedule:<tech>:<date>:<edge>`
  kind: 'time_off' | 'schedule_gap';
  technician_id: string;
  technician_name: string;
  starts_at: string;
  ends_at: string;
  note?: string | null;
  source: 'individual' | 'company' | 'work_schedule';
  mutable: boolean; // true only for persisted time off
};
```

The composite read is `GET /api/schedule/unavailability?from&to[&technician_id]` with `schedule.view` and existing provider scoping. Existing `/api/schedule/time-off` GET/POST/DELETE remains explicit-exception management and never returns a synthetic deletable row. This is intentional: overloading the CRUD endpoint would blur persisted and derived records. Reuse happens through one `technicianAvailabilityService.listUnavailability` seam consumed by every renderer/warning and by `slotEngineService`, not through a parallel schedule-gap path.

The slot engine keeps today's pre-shape/headroom/post-filter structure (`slotEngineService.js:212-267, 296-338, 372-385, 429-436`) but renames it from day-off-specific to unavailability-general. A recommendation whose half-open arrival window overlaps any combined block is removed and ranks are compacted. Schedule gaps do not create new candidate frames: the standalone engine still owns its configured candidates.

## Territory matching seam

- `technicianServiceAreaService` is the only assignment read/write/match seam. Both edit directions call atomic “replace one owner side” methods; no UI writes tables directly.
- Existing `company_territory_settings.active_mode` changes only the mode value (`territoryRadiusQueries.js:19-29`). It never deletes from either assignment table.
- District resolution returns the matched `service_territories.area`. Radius resolution must return **all** containing radius IDs, not only the nearest radius currently returned by `territoryService.js:52-59`; matching any assigned containing radius is sufficient.
- Smart recommendation roster eligibility is: `wildcard in active mode OR assigned to one resolved active target`. If target resolution fails operationally, fail the recommendation request rather than treating every assigned technician as a match. If the company has zero active targets, assignment filtering is a no-op and all active technicians are wildcard.
- Manual lanes remain visible. Replace the Zenbooker `assigned_territories` priority/warning at `CustomTimeModal.tsx:164-203, 1060-1062` with Albusto match data. Mismatches display a warning but never disable Confirm.

## API read/write paths

- `GET /api/settings/technicians`: active Zenbooker service-provider roster merged with profile/base, compact effective schedule, and active-mode assignment summary. A Zenbooker failure is explicit; do not fall back to job-history as though it were active.
- `GET /api/settings/technicians/:techId/settings`: company week, inheritance state, saved/effective custom week, exceeds-hours notices, territory mode, both assignment sets, and degraded metadata.
- `PUT /api/settings/technicians/:techId/work-schedule`: atomic parent + seven-day replacement/retention; validates shape, active roster membership, company-closed hard rule, and `req.user.crmUser.id`.
- `PUT /api/settings/technicians/:techId/service-areas/:mode`: replace that technician's district or radius set only. Empty is valid wildcard; the other mode is unchanged.
- `GET /api/settings/service-territories/assignments`: active roster, both assignment maps, and active-mode wildcard technician list.
- `PUT /api/settings/service-territories/district-assignments`: body `{ district_name, technician_ids[] }`; replace one district's technicians only.
- `PUT /api/settings/service-territories/radii/:radiusId/technicians`: replace one radius's technicians only.

Every route retains the mounted authentication/access middleware, requires `tenant.company.manage` for settings writes, takes company id only from `req.companyFilter?.company_id`, validates every target inside that company, parameterizes SQL, and returns 404 for foreign ids. Replacement writes run in transactions.

## Exact touch list

### Schedule ship

- `backend/db/migrations/183_technician_work_schedules.sql` (NEW) and matching rollback (NEW).
- `backend/src/db/technicianWorkScheduleQueries.js` (NEW): company-scoped parent/day reads and transactional replacement.
- `backend/src/services/technicianRosterService.js` (NEW): one active Zenbooker roster contract shared by settings, availability, and assignments.
- `backend/src/services/technicianWorkScheduleService.js` (NEW): validation, inheritance, company-closed precedence, summaries/notices.
- `backend/src/services/technicianAvailabilityService.js` (NEW): derived gaps plus explicit time-off union.
- `backend/src/services/technicianProfilesService.js:19-37`: stop using job history as the settings roster; expose profile merge by active ids.
- `backend/src/routes/technicians.js:20-42`: enriched list plus technician schedule/settings routes.
- `backend/src/routes/schedule.js:221-243`: add composite unavailability read without changing time-off CRUD.
- `backend/src/services/slotEngineService.js:18, 212-267, 296-338, 372-385, 429-436`: consume combined unavailability at the existing day-off suppression seam.
- `frontend/src/services/techniciansApi.ts:3-25`: schedule/settings contracts and mutations.
- `frontend/src/pages/TechnicianPhotosPage.tsx:36-59, 141-269`: canonical active-roster list, visible schedule summaries, panel trigger; keep photo/base behavior.
- `frontend/src/components/settings/TechnicianSettingsPanel.tsx` (NEW) and `TechnicianWeekEditor.tsx` (NEW): canonical panel and schedule states.
- `frontend/src/services/scheduleApi.ts:56-69, 265-328`: `UnavailabilityBlock`, composite fetch, shared overlap helper; keep explicit CRUD types.
- `frontend/src/hooks/useScheduleData.ts:162-186` and `frontend/src/pages/SchedulePage.tsx:139-155`: load/pass the combined collection only to technician-aware views.
- `frontend/src/components/schedule/TimelineView.tsx:435-469`, `TimelineWeekView.tsx:321-342`, `DayView.tsx:203-240`: same geometry/hatch with kind-aware label.
- `frontend/src/components/conversations/CustomTimeModal.tsx:164-203, 321-358, 641-643, 725-743` and `CustomTimeModal.css:301-325`: combined read, same dashed hatch.
- `frontend/src/components/jobs/NewJobDialog.tsx:138-158, 375-382` and `frontend/src/components/jobs/timeOffWarning.ts:1-29`: warning for either unavailability kind, never a block.
- Tests: `tests/technicianWorkScheduleMigration.test.js`, `tests/technicianWorkScheduleService.test.js`, `tests/technicianSettingsRoutes.test.js`, `tests/technicianUnavailability.test.js`, existing `tests/slotEngineDayOffFilter.test.js`, plus focused frontend tests named below.

### Territory ship

- `backend/db/migrations/184_technician_service_area_assignments.sql` (NEW) and matching rollback (NEW).
- `backend/src/db/technicianServiceAreaQueries.js` (NEW) and `backend/src/services/technicianServiceAreaService.js` (NEW): both mode maps, atomic replacements, wildcard/match rules.
- `backend/src/db/serviceTerritoryQueries.js:19-27, 51-86, 93-100`: current district targets, bulk-replace cleanup, ZIP-to-district resolution.
- `backend/src/db/territoryRadiusQueries.js:9-82` and `backend/src/services/territoryService.js:29-79`: assignment-aware reads and all-containing-radii resolution.
- `backend/src/routes/technicians.js:20-42`: per-technician area routes.
- `backend/src/routes/service-territories.js:81-178, 181-280`: assignment aggregate/reverse routes; mode mutation remains data-preserving.
- `backend/src/services/slotEngineService.js:274-338`: active-target technician eligibility before engine ranking.
- `frontend/src/services/techniciansApi.ts:3-25`: both mode assignments and replacement call.
- `frontend/src/components/settings/TechnicianSettingsPanel.tsx` (NEW): both multi-select modes, active/saved-for-later/wildcard states.
- `frontend/src/pages/ServiceTerritoriesPage.tsx:20-125, 251-321, 415-555, 561-741`: persistent warnings, assignment counts, reverse panel, District label.
- `frontend/src/components/settings/TerritoryTechnicianPanel.tsx` (NEW): right-side reverse multi-select panel.
- `frontend/src/components/conversations/CustomTimeModal.tsx:42-52, 164-203, 657-671, 1060-1062` and `frontend/src/services/zenbookerApi.ts:146-152`: replace Zenbooker-area matching with Albusto active-mode matches.
- Tests: `tests/technicianServiceAreaMigration.test.js`, `tests/technicianServiceAreaService.test.js`, `tests/technicianServiceAreaRoutes.test.js`, existing `tests/serviceTerritoriesConfig.test.js`, `tests/slotEngineServiceAreas.test.js`, and focused frontend tests named below.

`frontend/src/pages/ProvidersPage.tsx` and generic schedule views are intentionally absent.

## Task plan and acceptance criteria

All commands run from the worktree root unless the command starts with `cd frontend`. Keep the schedule release boundary after T6.

### T1 — Schedule schema and query layer

Acceptance: migration 183/rollback are replay-safe; checks reject malformed days; every query is company-scoped; seven-day replacement is atomic and preserves saved custom rows when inheritance is enabled.

Verify:

```bash
env -u NODE_USE_SYSTEM_CA node --use-bundled-ca --experimental-vm-modules ../../../node_modules/jest/bin/jest.js --runInBand --runTestsByPath tests/technicianWorkScheduleMigration.test.js --testPathIgnorePatterns "/node_modules/"
```

### T2 — Effective schedule service and derivation

Acceptance: missing/inherited/custom/wider-hours/DST cases return correct effective weeks; a company-closed day always wins; override-query failure returns company fallback metadata; company-settings failure does not return all-day availability.

Verify:

```bash
env -u NODE_USE_SYSTEM_CA node --use-bundled-ca --experimental-vm-modules ../../../node_modules/jest/bin/jest.js --runInBand --runTestsByPath tests/technicianWorkScheduleService.test.js tests/technicianUnavailability.test.js --testPathIgnorePatterns "/node_modules/"
```

### T3 — Active roster and technician settings API

Acceptance: list uses active Zenbooker providers; settings GET/PUT are authenticated, permissioned, tenant-isolated, roster-validated, and use `crmUser.id`; foreign tech/tenant behaves as 404; schedule summaries are returned.

Verify:

```bash
env -u NODE_USE_SYSTEM_CA node --use-bundled-ca --experimental-vm-modules ../../../node_modules/jest/bin/jest.js --runInBand --runTestsByPath tests/technicianSettingsRoutes.test.js --testPathIgnorePatterns "/node_modules/"
```

### T4 — Technician list and schedule panel

Acceptance: every row shows the effective schedule; the canonical right panel has ON/OFF inheritance, visible disabled inherited hours, custom day-off, hard company-closed rows, wider-hours notice, loading/error states, and retains photo/base controls.

Verify:

```bash
cd frontend && env -u NODE_USE_SYSTEM_CA npm test -- src/pages/TechnicianPhotosPage.test.tsx src/components/settings/TechnicianSettingsPanel.test.tsx
cd frontend && env -u NODE_USE_SYSTEM_CA npm run build
```

### T5 — Unified unavailability API, hatch, and manual warnings

Acceptance: composite read returns explicit and derived kinds with half-open intervals/provider scope; Timeline, Team Week, mobile Day, and Custom Time render the existing hatch and kind label; generic Day/Week remain unchanged; all manual conflicts warn without disabling actions.

Verify:

```bash
env -u NODE_USE_SYSTEM_CA node --use-bundled-ca --experimental-vm-modules ../../../node_modules/jest/bin/jest.js --runInBand --runTestsByPath tests/timeOffRoutes.test.js tests/technicianUnavailability.test.js --testPathIgnorePatterns "/node_modules/"
cd frontend && env -u NODE_USE_SYSTEM_CA npm test -- src/services/unavailability.test.ts src/components/schedule/UnavailabilitySurfaces.test.tsx
cd frontend && env -u NODE_USE_SYSTEM_CA npm run build
```

### T6 — Smart-slot schedule suppression (schedule release gate)

Acceptance: existing day-off cases stay green; schedule-gap overlap is removed through the same pre-shape/headroom/post-filter flow; ranks compact; company-closed day yields no technician suggestion; no-unavailability path remains unchanged.

Verify:

```bash
env -u NODE_USE_SYSTEM_CA node --use-bundled-ca --experimental-vm-modules ../../../node_modules/jest/bin/jest.js --runInBand --runTestsByPath tests/slotEngineDayOffFilter.test.js tests/technicianUnavailability.test.js --testPathIgnorePatterns "/node_modules/"
```

### T7 — Territory assignment schema and domain service

Acceptance: migration 184/rollback are replay-safe; both many-to-many maps coexist; empty active-mode assignments return wildcard eligibility; stale district names do not suppress wildcard; radius FK is company-safe; replacements touch one mode/owner side only.

Verify:

```bash
env -u NODE_USE_SYSTEM_CA node --use-bundled-ca --experimental-vm-modules ../../../node_modules/jest/bin/jest.js --runInBand --runTestsByPath tests/technicianServiceAreaMigration.test.js tests/technicianServiceAreaService.test.js --testPathIgnorePatterns "/node_modules/"
```

### T8 — Assignment APIs and mode-preservation contract

Acceptance: both edit directions round-trip through one service; empty arrays are accepted; all routes enforce auth/permission/company scope/active roster; switching list→radius→list preserves both exact assignment sets; roster failure makes writes fail atomically.

Verify:

```bash
env -u NODE_USE_SYSTEM_CA node --use-bundled-ca --experimental-vm-modules ../../../node_modules/jest/bin/jest.js --runInBand --runTestsByPath tests/technicianServiceAreaRoutes.test.js tests/serviceTerritoriesConfig.test.js --testPathIgnorePatterns "/node_modules/"
```

### T9 — Technician-panel service areas

Acceptance: District/Radii multi-selects show both saved sets; active versus saved-for-later state is clear; zero active selection explains wildcard; save updates only the viewed mode and invalidates technician/territory queries.

Verify:

```bash
cd frontend && env -u NODE_USE_SYSTEM_CA npm test -- src/components/settings/TechnicianServiceAreas.test.tsx src/components/settings/TechnicianSettingsPanel.test.tsx
cd frontend && env -u NODE_USE_SYSTEM_CA npm run build
```

### T10 — Service Territories reverse assignment and warnings

Acceptance: active-mode page renders exactly one non-dismissible notice per wildcard technician; notices update only after successful assignment save; district/radius tiles open the canonical right panel; reverse edits appear in technician settings; roster failure cannot masquerade as zero warnings.

Verify:

```bash
cd frontend && env -u NODE_USE_SYSTEM_CA npm test -- src/pages/ServiceTerritoriesPage.test.tsx src/components/settings/TerritoryTechnicianPanel.test.tsx
cd frontend && env -u NODE_USE_SYSTEM_CA npm run build
```

### T11 — Albusto area matching in smart and manual selection

Acceptance: district ZIP and every containing radius resolve to Albusto targets; wildcard technicians always remain eligible; directly assigned technicians match only their active targets; smart roster is narrowed before ranking; Custom Time no longer uses Zenbooker territory assignments; manual mismatch is warning-only.

Verify:

```bash
env -u NODE_USE_SYSTEM_CA node --use-bundled-ca --experimental-vm-modules ../../../node_modules/jest/bin/jest.js --runInBand --runTestsByPath tests/technicianServiceAreaService.test.js tests/slotEngineServiceAreas.test.js --testPathIgnorePatterns "/node_modules/"
cd frontend && env -u NODE_USE_SYSTEM_CA npm test -- src/components/conversations/CustomTimeModal.serviceAreas.test.tsx
cd frontend && env -u NODE_USE_SYSTEM_CA npm run build
```

### T12 — Combined regression gate

Acceptance: all affected backend suites, full frontend Vitest, and production TypeScript/Vite build pass; no protected file, `/settings/providers`, generic schedule view, or `technician_time_off` persistence contract changed.

Verify:

```bash
env -u NODE_USE_SYSTEM_CA node --use-bundled-ca --experimental-vm-modules ../../../node_modules/jest/bin/jest.js --runInBand --runTestsByPath tests/technicianWorkScheduleMigration.test.js tests/technicianWorkScheduleService.test.js tests/technicianSettingsRoutes.test.js tests/technicianUnavailability.test.js tests/timeOffRoutes.test.js tests/slotEngineDayOffFilter.test.js tests/technicianServiceAreaMigration.test.js tests/technicianServiceAreaService.test.js tests/technicianServiceAreaRoutes.test.js tests/serviceTerritoriesConfig.test.js tests/slotEngineServiceAreas.test.js --testPathIgnorePatterns "/node_modules/"
cd frontend && env -u NODE_USE_SYSTEM_CA npm test
cd frontend && env -u NODE_USE_SYSTEM_CA npm run build
git diff --check
```

## Sabotage-minimum controls

1. **SAFETY-WILDCARD-ELIGIBLE**
   - Invariant: an active technician with zero **valid** assignments in the active mode matches every resolved target.
   - Break it: change the matcher’s empty-set branch from `eligible=true` to `false`, or count a stale district row as valid.
   - Must go red: `tests/technicianServiceAreaService.test.js` case `TC-SA-WILDCARD-01 — empty active set is wildcard for every target` (and its stale-row variant).

2. **SAFETY-MODE-NONDESTRUCTIVE**
   - Invariant: switching `company_territory_settings.active_mode` mutates only that column; district and radius assignments remain byte-equivalent.
   - Break it: add assignment deletion/reset to `setMode`, or make a replacement method clear both tables.
   - Must go red: `tests/serviceTerritoriesConfig.test.js` case `TC-SA-MODE-01 — list→radius→list preserves both assignment maps`.

3. **SAFETY-COMPANY-CLOSED-WINS**
   - Invariant: a weekday excluded by company `work_days` is a full-day effective gap even if stored technician custom data says working.
   - Break it: evaluate custom `is_working` before intersecting with the company-open weekday set, or omit the server-side save guard.
   - Must go red: `tests/technicianWorkScheduleService.test.js` case `TC-WS-CLOSED-01 — stored working interval cannot reopen company-closed day`, plus `tests/slotEngineDayOffFilter.test.js` case `TC-WS-CLOSED-ENGINE-01`.

Sabotage is performed only on top of the uncommitted implementation and reversed by the exact inverse edit; never use `git checkout` to restore it (`gpt-lessons.md` L-015).

## Non-goals

- Materializing recurring gaps into `technician_time_off`, changing explicit time-off CRUD, or blocking manual booking.
- Adding hatches to generic Day/Week, Month, or List.
- Changing `/settings/providers`, telephony `user_group_hours`, RELY zone settings, or Zenbooker territory assignments.
- Multiple shifts per weekday, overnight intervals, effective-date ranges, holidays, or schedule history/versioning.
- Expanding the standalone slot engine's candidate frames merely because a technician works wider than company hours. This feature suppresses existing candidates; candidate-frame expansion is a separate engine product decision.
- Redesigning territory containment, ZIP import/export, maps, or base-location/radius tuning beyond the assignment controls required here.

## Risks and mitigations

- **District identity is currently a mutable string, not a first-class row.** Validate against current company areas, join validity on every read, and prune removed names inside bulk replacement. A future district-ID migration may be warranted, but is not required to ship this feature safely.
- **Zenbooker is the active-roster authority.** Roster failure must be explicit and must disable writes/warning recomputation; historical-job fallback would generate false wildcard state.
- **DST and half-open intervals.** Derive per company-local date and convert with the canonical timezone helper; test spring/fall transitions and touching boundaries.
- **Overlapping radii.** Current containment keeps only the nearest radius. Assignment matching must return all containing radius IDs or valid technicians can be incorrectly excluded.
- **Migration race.** 183/184 were free at the recorded hash/time only. Recheck before integration, as required above.
- **Wider custom hours do not create new engine windows.** The panel/manual schedule can show and use them, but the current fixed engine candidates will not recommend newly exposed early/late windows in this scope.
