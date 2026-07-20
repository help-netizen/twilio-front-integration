# SCHEDULE-DESKTOP-MAP-001 (OB-18) — Desktop Schedule routes map

**Status:** Implemented, pending owner/reviewer acceptance

**Surface:** Desktop Schedule `Day` and `Timeline` only

**Type:** Frontend view over existing company-scoped schedule data

**Approved mockup:** `docs/mockups/SCHEDULE-DESKTOP-MAP-001.html`

**Backend / migration / new API key:** None

## Approved decisions

1. At viewport widths `>=1280px`, Day and Timeline default to a split grid + map.
   Below 1280px, the same control becomes a List/Map replacement switch.
2. The map control lives inside `CalendarControls`' existing
   `schedule-controls-actions` composition. It is not a new header row or stray wrapper.
3. Routes are straight visit-order polylines. Google Routes/Directions is not called;
   there is no road-geometry storage, key, billing dependency, or migration.
4. The map consumes the same filtered `schedule.scheduledItems` as the grid and applies
   the same provider-chip vocabulary, including `__unassigned__`.
5. An unassigned item with coordinates is one neutral outlined `U` pin and has no route.
6. An item without both finite coordinates is never guessed onto the map. It appears in
   **Not on the map** with `Address not on the map yet` when address text exists and
   `No address` only when the address field is genuinely empty.
7. A joint job is one pin with a secondary technician-colour ring. Every assigned,
   currently visible technician route passes through that same point.
8. The pin count plus Not-on-map count always equals the filtered job total.

## Functional requirements

- **FR-DM-1 — Responsive composition.** Day and Timeline render split at `>=1280px`.
  At narrower non-mobile widths, `Show map` replaces the grid with the map and
  `Show list` restores it. Other Schedule modes do not expose the desktop map control.
- **FR-DM-2 — Filter parity.** The desktop map receives the same already-filtered
  scheduled items as the grid. Provider membership matches technician id or name and
  handles the `__unassigned__` sentinel identically to `filterItemsByProviderTags`.
- **FR-DM-3 — Coordinate gate.** A pin requires finite numeric `lat` and `lng`.
  `geocoding_status` is not a gate because imported jobs can carry valid coordinates
  before that status is promoted.
- **FR-DM-4 — Unique pins and routes.** There is exactly one pin per mapped item.
  Assigned routes sort by `start_at`, number from one, and draw only contiguous mapped
  runs of at least two stops. A coordinate-less visit breaks a run so the UI cannot draw
  a false shortcut across it.
- **FR-DM-5 — Unassigned.** Coordinate-bearing unassigned jobs use a neutral outlined
  `U` marker, appear only when current filter semantics include them, and never produce
  a route line.
- **FR-DM-6 — Joint jobs.** A joint job has one marker; the first visible assignment is
  the primary fill/order and the second visible assignment is a secondary ring. Each
  visible technician route independently includes the stop.
- **FR-DM-7 — Missing coordinates.** The Not-on-map panel renders only when non-empty.
  Each row shows title, company-timezone time, technician name with assigned colour dot,
  and the truthful reason. Selecting a row highlights the corresponding grid card and
  does not pan the map.
- **FR-DM-8 — Counts.** `pins.length + notOnMap.length === totalJobs` is asserted by the
  shared model, displayed in the desktop header arithmetic, and covered by unit tests.
- **FR-DM-9 — Linked interaction.** Hovering or selecting a grid card highlights/dims
  the matching map marker and routes; marker hover/click does the same to the grid.
  Marker click also opens its Google InfoWindow. Grid card click retains its existing job
  detail behavior.
- **FR-DM-10 — Honest edge states.** Empty filtered days show no routes; a single-stop
  technician shows a `no route line needed` notice; rosters over 16 show initials on pins.

## Shared colour registry

`scheduleProviderColors.ts` is the single assignment seam for schedule chips, cards,
lanes, sidebars, legends, pins, and lines.

- Input is the complete Schedule provider roster plus all assignments in the fetched
  company-scoped range (the latter covers scoped/non-dispatch and legacy-name cases).
- Entries normalize and de-duplicate by stable technician id/name key, then sort by
  Unicode codepoint before receiving their palette index.
- The palette is the exact 16 PALETTE-V2 `--blanc-map-area-1..16` values.
- Input shuffle and active filters cannot change a technician's colour.
- Roster size `<=16` is collision-free. The finite palette wraps beyond 16 and pins add
  technician initials so meaning no longer depends on colour alone.
- The previous hash helper remains only on the unrelated mobile Jobs-list card; no
  Schedule surface consumes it.

## Shared map primitive and mobile boundary

The extraction seam is deliberately smaller than the whole Schedule shell:

- `scheduleMapModel.ts`: pure filter/group/gate/order/reconciliation model.
- `ScheduleMapCanvas.tsx`: memoized Google marker/polyline/InfoWindow renderer.
- `ScheduleJobsMap.tsx`: existing mobile Day-map shell and sizing, now a thin wrapper
  over the same model/renderer.
- `ScheduleDesktopMapPanel.tsx`: desktop header/count arithmetic and conditional
  Not-on-map list around the shared canvas.

The mobile `MobileScheduleBar`, its existing List/Map state, and the mobile Schedule
page composition are unchanged. Approved shared semantics now guarantee one joint pin
and no Unassigned route on both map surfaces.

## Performance contract

- `ScheduleDesktopMapPanel` and `ScheduleMapCanvas` are `React.memo` components.
- Job projection and map model are `useMemo`-keyed only by scheduled item identity,
  provider filter value, and complete colour registry.
- Marker and polyline geometry is rebuilt only when the model or timezone changes.
- Selection/hover has a separate effect that mutates marker opacity/z-index and line
  opacity; it does not clear/recreate geometry.
- Timeline's ticking/drag state remains inside `TimelineView`; the map is its memoized
  sibling, so a dense grid tick cannot rebuild map geometry.

## Data, security, and cost

There is no new network or persistence path. The UI reads the existing
company-scoped `/api/schedule` response and existing Google Maps JS loader. It performs
no geocoding, coordinate write-back, Routes/Directions request, or billing-bearing
per-route call. Straight-line rendering has zero incremental API calls and zero
incremental route cost.

## File map

- `frontend/src/pages/SchedulePage.tsx` — responsive composition, shared registry,
  linked selection/hover.
- `frontend/src/components/schedule/CalendarControls.tsx` — composed-header map control.
- `frontend/src/components/schedule/ScheduleDesktopMapPanel.tsx` — desktop panel/list.
- `frontend/src/components/schedule/ScheduleMapCanvas.tsx` — shared Google renderer.
- `frontend/src/components/schedule/scheduleMapModel.ts` — pure contracts/invariants.
- `frontend/src/components/schedule/ScheduleJobsMap.tsx` — mobile wrapper.
- `frontend/src/utils/scheduleProviderColors.ts` — sorted complete-roster registry.
- `frontend/src/utils/mapPins.ts` — joint/unassigned/initials marker SVG.
- `frontend/src/components/schedule/{DayView,TimelineView,ScheduleItemCard}.tsx` —
  cross-surface highlight state.

## Named sabotage minimum

| Invariant | Named control | Minimum breaking edit | Expected red test |
|---|---|---|---|
| Reconciliation | `SAB-DM-RECONCILE` | duplicate every joint pin | `reconciles unique joint pins...` |
| Colour determinism/collision freedom | `SAB-DM-COLOR-ORDER` | assign indices before sorted roster order | `assigns the complete 16-person roster...` |
| Coordinate gate | `SAB-DM-COORD-GATE` | require `geocoding_status === 'success'` or use truthiness | `uses coordinate presence...` |
| Unassigned has no route | `SAB-DM-U-ROUTE` | add unassigned jobs to route buckets | `renders neutral Unassigned pins...` |
| Conditional panel | `SAB-DM-PANEL-CANON` | return `true` from `showNotOnMapPanel` | `hides the Not on the map panel...` |
| Chip/filter parity | `SAB-DM-FILTER-PARITY` | bypass provider visibility in the map model | `matches the provider-chip filter...` |

Each control must be broken on top of the uncommitted implementation, observed red for
the intended assertion, restored with the exact inverse patch, and rerun green. Never
restore sabotage with a git reset/checkout.

## Verification

- `env NODE_USE_SYSTEM_CA=0 npm run build` (from `frontend/`) — **PASS**;
  TypeScript production build and Vite build completed, 3540 modules transformed.
- `env NODE_USE_SYSTEM_CA=0 npm test` (from `frontend/`) — **PASS**;
  50 test files, 278 tests.
- `env NODE_USE_SYSTEM_CA=0 ./node_modules/.bin/vitest run src/utils/scheduleProviderColors.test.ts src/components/schedule/scheduleMapModel.test.ts src/pages/ScheduleDesktopMapContract.test.ts src/pages/ScheduleHeaderContract.test.ts --reporter=verbose`
  — **PASS**, 4 files / 16 tests.
- `SAB-DM-RECONCILE` — duplicated joint pins in the real model; the named
  reconciliation test failed with `Schedule map reconciliation invariant failed`;
  exact inverse patch restored, named test green.
- `SAB-DM-COLOR-ORDER`, `SAB-DM-COORD-GATE`, `SAB-DM-U-ROUTE`,
  `SAB-DM-PANEL-CANON`, and `SAB-DM-FILTER-PARITY` — broke the real sorted
  registry/model gates together; all five named tests failed at their intended
  assertions; exact inverse patch restored; the 4-file/16-test gate returned green.
- `git diff --check` — **PASS** at handoff.

The inherited `NODE_USE_SYSTEM_CA=1` environment triggers the documented Node 25
macOS keychain crash (lesson L-014), so every successful Node command above explicitly
uses the bundled/non-system CA mode. This changes no application behavior.
