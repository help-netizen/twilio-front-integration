# SCHED-DAYOFF-DISPLAY-001 — remove partial schedule-gap noise, retain full-day signals

**Status:** implemented, pending screenshot sign-off · **Date:** 2026-07-20 · **Type:** display-only frontend change  
**Continues:** `TECH-SCHEDULE-001`, `TECH-DAYOFF-001` · **Owner frame:** `OB-16`

## Goal

Remove recurring before/after-work `Outside work schedule` blocks from the main
Schedule while preserving explicit Time off and showing a concise signal when a
technician has no working interval for the entire company-local date.

This is display-only. The combined unavailability collection must remain unchanged
for smart-slot suppression, auto-booking, manual conflict warnings, and the slot
picker.

## Scope

- Mobile Schedule agenda (`DayView` mobile branch).
- Desktop `Timeline` technician lanes.
- Desktop `Team Week` technician cells.
- Real-component day-off harness fixtures for screenshot QA.

Out of scope: desktop generic Day/Week/Month/List, `CustomTimeModal`, persistence,
schedule derivation, API contracts, warning behavior, slot-engine behavior, and all
backend writes.

## Owner decisions (verbatim authority)

1. **Company-closed day → ONE aggregated row, not N identical tiles.** Owner picked this precisely because N identical cards would re-introduce the noise he is removing. On the MOBILE agenda a company-closed date renders a single row (`Company closed`), NOT one card per technician. On the DESKTOP lane views each technician column is still shaded — lanes are per-tech by nature, that is expected and was part of the accepted option.
2. **Clean all three main-Schedule surfaces:** mobile agenda (DayView), desktop Timeline, desktop Team Week. Owner did not want to bet on which view his screenshot came from. Desktop Day currently has no unavailability renderer — leave it alone, do NOT add one.

Team-lead decisions:

- Per-technician derived full-day copy is `Day off`.
- Company-wide closure copy is `Company closed`.
- `Time off` remains reserved for explicit persisted exceptions.
- Derived Day off and explicit Time off on the same date both render.

## Stable data contract

`UnavailabilityBlock.kind` remains the record-type discriminator:
`time_off | schedule_gap`. Derived gaps also have the documented stable source
`company | work_schedule`: the effective-schedule resolver assigns `company` when
the company weekday is closed before it considers custom technician data, and a
technician-specific custom day off resolves to `work_schedule`.

Company-closure classification therefore requires all of:

1. `kind === 'schedule_gap'`;
2. the block covers `[company-local midnight, next company-local midnight)`;
3. `source === 'company'`.

No display behavior is inferred from an English label, synthetic id suffix, visible
grid coverage, or “every technician appears off.” Mobile aggregation consumes only
the already server-scoped and provider-filtered blocks; it never iterates a roster.

## UX contract

### Mobile agenda

- Partial derived schedule gaps render nothing.
- A technician-specific full day renders `Day off · <technician> · All day`.
- Any number of scoped company-closed full-day gaps collapse to one anonymous
  `Company closed` row.
- Explicit Time off retains its existing label, technician name, interval, note
  behavior, hatch, order, and non-interactivity.
- A Day off or Company closed signal suppresses the empty “No jobs scheduled” row.

### Desktop Timeline

- Partial derived gaps render nothing.
- A technician full day fills that technician's visible work-hours lane and reads
  `Day off`; a company-closed full day reads `Company closed`.
- Explicit Time off is unchanged. Jobs and DnD remain above the non-interactive hatch.

### Desktop Team Week

- Partial derived strips render nothing.
- A full-day derived block becomes one `Day off` or `Company closed` strip in its
  technician/date cell.
- Explicit Time off is unchanged.

All three surfaces reuse the exact existing neutral diagonal hatch. No new color,
interaction, empty-state chrome, or product terminology is introduced.

## Tenancy & Roles

| surface (route/worker/webhook/SSE/aggregate) | scoped by | key used | permission | roles ✓/✗ | blast-radius risk |
|---|---|---|---|---|---|
| Existing `GET /api/schedule/unavailability` (unchanged) | `req.companyFilter?.company_id`; assigned-only provider scope forces the caller's bridged ZB id | ZB technician TEXT id paired with company; client `technician_id` cannot override provider-own scope | `schedule.view` | default tenant_admin ✓; manager ✓; dispatcher ✓; provider ✓ own only; caller without permission ✗ | Aggregate contains technician names and recurring/explicit availability; an unscoped ZB id could disclose another tenant, so the existing server guard and provider-own test remain release gates |

No route, query, worker, webhook, SSE channel, permission, or role behavior is added
or modified by this feature. The frontend projection receives only the route's
scoped payload; mobile company-closure aggregation never loads or iterates a roster.

## Task breakdown

### T1 — Pure display projection

Acceptance: explicit Time off passes through by reference; partial schedule gaps are
omitted; full local-day gaps classify as Day off or Company closed; 23/25-hour DST
days work; mobile company closure aggregates anonymously; operational input is not
mutated.

### T2 — Three main-Schedule surfaces

Acceptance: mobile agenda, Timeline, and Team Week use the projection and approved
copy; provider filtering happens before mobile aggregation; desktop Day and all
other views remain untouched; `CustomTimeModal` remains untouched.

### T3 — Real-component screenshot harness

Acceptance: fixtures include before/after partial gaps, technician full day, company
closure, explicit Time off, and a mixed day where one technician is off and another
has jobs.

### T4 — Regression and sabotage gates

Acceptance: focused and full frontend tests, production build, existing provider
scope/backend availability tests, and slot-engine byte pins pass. All four named
sabotage controls fail for the intended reason and are restored from `cp` backups.

## Named sabotage controls

1. `SAFETY-PARTIAL-GAPS-HIDDEN`: allow partial `schedule_gap` through projection →
   focused frontend test must fail.
2. `SAFETY-FULL-DAY-SIGNAL`: discard all derived full-day blocks → focused frontend
   test must fail.
3. `SAFETY-TIME-OFF-PASSTHROUGH`: discard explicit `time_off` → focused frontend
   test must fail.
4. `SAFETY-SLOT-SEAM-BYTE-IDENTICAL`: ignore derived schedule gaps in the slot seam →
   existing slot-engine derived-gap suppression test must fail.

## Verification

Live commands, suite/test counts, exit statuses, and sabotage red→restore evidence
are recorded here after implementation. A command absent from this section was not
part of the acceptance record.

All commands below were run from the repository root unless a different working
directory is stated. `NODE_USE_SYSTEM_CA` is removed because this worktree's Node
bootstrap otherwise overrides the requested bundled-CA test runtime.

### Automated acceptance runs

| Gate | Working directory | Exact command | Live result |
|---|---|---|---|
| Display projection + three surface guards | `frontend/` | `env -u NODE_USE_SYSTEM_CA npm test -- src/services/scheduleDisplayUnavailability.test.ts src/components/schedule/UnavailabilitySurfaces.test.tsx` | exit 0; 2 files passed; 10 tests passed |
| Full frontend regression | `frontend/` | `env -u NODE_USE_SYSTEM_CA npm test` | exit 0; 42 files passed; 240 tests passed |
| Frontend production build | `frontend/` | `env -u NODE_USE_SYSTEM_CA npm run build` | exit 0; TypeScript passed; Vite transformed 3,530 modules and built in 14.70s; existing chunk/dynamic-import warnings only |
| Stable `source` contract | repository root | `env -u NODE_USE_SYSTEM_CA node --use-bundled-ca --experimental-vm-modules ../../../node_modules/jest/bin/jest.js --runInBand --runTestsByPath tests/technicianUnavailability.test.js --testPathIgnorePatterns "/node_modules/"` | exit 0; 1 suite passed; 8 tests passed |
| Assigned-only provider disclosure guard | repository root | `env -u NODE_USE_SYSTEM_CA node --use-bundled-ca --experimental-vm-modules ../../../node_modules/jest/bin/jest.js --runInBand --runTestsByPath tests/timeOffRoutes.test.js --testNamePattern "retains schedule.view RBAC and provider-own scoping" --testPathIgnorePatterns "/node_modules/"` | exit 0; 1 suite passed; named test passed; 34 skipped. The response contains own technician `John Smith` and excludes foreign `Jane Doe`. |
| Backend/slot regression | repository root | `env -u NODE_USE_SYSTEM_CA node --use-bundled-ca --experimental-vm-modules ../../../node_modules/jest/bin/jest.js --runInBand --runTestsByPath tests/slotEngineDayOffFilter.test.js tests/slotEngineProxy.test.js tests/technicianUnavailability.test.js tests/timeOffRoutes.test.js --testPathIgnorePatterns "/node_modules/"` | exit 0; 4 suites passed; 91 tests passed |

### Named sabotage controls

Before sabotage, the display helper and slot seam were backed up with:

```text
cp frontend/src/services/scheduleDisplayUnavailability.ts /tmp/SCHED-DAYOFF-DISPLAY-001.scheduleDisplayUnavailability.ts.backup
cp backend/src/services/slotEngineService.js /tmp/SCHED-DAYOFF-DISPLAY-001.slotEngineService.js.backup
```

1. `SAFETY-PARTIAL-GAPS-HIDDEN`
   - Broke: changed the partial `schedule_gap` branch from omission to returning a
     `day_off` display item.
   - Exact command: `env -u NODE_USE_SYSTEM_CA npm test -- src/services/scheduleDisplayUnavailability.test.ts -t "SAFETY-PARTIAL-GAPS-HIDDEN"` from `frontend/`.
   - Expected red: exit 1; 1 test failed, 6 skipped; expected no display items but
     received 2.
   - Restored: `cp /tmp/SCHED-DAYOFF-DISPLAY-001.scheduleDisplayUnavailability.ts.backup frontend/src/services/scheduleDisplayUnavailability.ts`; `cmp -s frontend/src/services/scheduleDisplayUnavailability.ts /tmp/SCHED-DAYOFF-DISPLAY-001.scheduleDisplayUnavailability.ts.backup` exited 0.

2. `SAFETY-FULL-DAY-SIGNAL`
   - Broke: changed the full-day derived branch to return no display items.
   - Exact command: `env -u NODE_USE_SYSTEM_CA npm test -- src/services/scheduleDisplayUnavailability.test.ts -t "SAFETY-FULL-DAY-SIGNAL"` from `frontend/`.
   - Expected red: exit 1; 1 test failed, 6 skipped; expected the `Day off` and
     `Company closed` classifications but received none.
   - Restored with the same helper backup `cp` and `cmp -s` command; comparison
     exited 0.

3. `SAFETY-TIME-OFF-PASSTHROUGH`
   - Broke: changed the explicit `time_off` branch to discard the record.
   - Exact command: `env -u NODE_USE_SYSTEM_CA npm test -- src/services/scheduleDisplayUnavailability.test.ts -t "SAFETY-TIME-OFF-PASSTHROUGH"` from `frontend/`.
   - Expected red: exit 1; 1 test failed, 6 skipped; expected the same explicit
     record by reference but received none.
   - Restored with the same helper backup `cp` and `cmp -s` command; comparison
     exited 0.

4. `SAFETY-SLOT-SEAM-BYTE-IDENTICAL`
   - Broke: added an early skip for `kind === 'schedule_gap'` in
     `groupUnavailabilityByTech`, the slot-engine input seam.
   - Exact command: `env -u NODE_USE_SYSTEM_CA node --use-bundled-ca --experimental-vm-modules ../../../node_modules/jest/bin/jest.js --runInBand --runTestsByPath tests/slotEngineDayOffFilter.test.js --testNamePattern "a derived schedule gap suppresses an overlapping suggestion" --testPathIgnorePatterns "/node_modules/"` from the repository root.
   - Expected red: exit 1; 1 test failed, 16 skipped; the forbidden 08:00–10:00
     recommendation leaked through.
   - Restored: `cp /tmp/SCHED-DAYOFF-DISPLAY-001.slotEngineService.js.backup backend/src/services/slotEngineService.js`; `cmp -s backend/src/services/slotEngineService.js /tmp/SCHED-DAYOFF-DISPLAY-001.slotEngineService.js.backup` exited 0.

Post-restore green controls:

- `env -u NODE_USE_SYSTEM_CA npm test -- src/services/scheduleDisplayUnavailability.test.ts`
  from `frontend/` → exit 0; 1 file passed; 7 tests passed.
- `env -u NODE_USE_SYSTEM_CA node --use-bundled-ca --experimental-vm-modules ../../../node_modules/jest/bin/jest.js --runInBand --runTestsByPath tests/slotEngineDayOffFilter.test.js --testNamePattern "a derived schedule gap suppresses an overlapping suggestion" --testPathIgnorePatterns "/node_modules/"`
  from the repository root → exit 0; 1 suite passed; named test passed; 16 skipped.

### Screenshot harness

The real-component harness was started from `frontend/` with
`env -u NODE_USE_SYSTEM_CA npm run dev -- --host 127.0.0.1 --port 3001`; Vite
started successfully and the process was stopped with `Ctrl-C`. The available
in-app browser runtime reported zero browser backends, so screenshots could not be
captured in this environment. Fixture and renderer coverage is automated, but final
pixel-level screenshot sign-off remains manual.

## Architecture decision

No `docs/architecture.md` block is required. This feature introduces no new seam,
contract, persistence, or cross-layer dependency; it is a pure projection at three
existing frontend render sites.
