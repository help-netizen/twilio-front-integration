# SCHED-MOBILE-002 — Mobile Schedule week strip

**Status:** in progress · **Type:** UI improvement / behavior-change · **Surface:** frontend-only, **mobile Schedule only** · **Continues:** SCHED-MOBILE-001 (8b6cbeb)

Desktop Schedule is **byte-for-byte untouched**. Everything here is gated behind `useIsMobile` (bp 768).

## Problem

After SCHED-MOBILE-001 the mobile top bar shows the date as a hero plus a `‹ / Today / ›` row. Owner feedback:
the standalone **Today button is confusing** — it's always on screen, so on any date you still read "Today" and
think you're looking at today's jobs. The tech wants to see the week at a glance and jump between days directly.

## Decisions (from Step 0.5 interview — binding)

1. **Week starts Sunday** (`weekStartsOn: 0`) — matches the app's existing week views.
2. **Swipe changes only the visible week.** The selected day + agenda do **not** move on swipe; only a **tap** selects.
3. **No "Today" toggle button.** Return-to-today = **tap the big date headline** → resets `currentDate` to today
   and snaps the strip to today's week. A subtle "return to today" affordance shows only when off-today.
4. **Keep the big date headline** above the strip. In the strip: **selected day = filled accent circle**
   (`--sched-job`), **today = thin ring** (`--sched-job` border) — distinguishable even when they're different days.
5. **Per-day counts = client-side**, reusing `fetchScheduleItems` over the visible week + the same provider/tag
   filter as the agenda. **No backend, no migration.**

## Behavior spec

### Week strip (new `WeekStrip` component)
- Renders one horizontal row of **7 day cells** (Sun→Sat), each: weekday label on top (`Mon`), a **circle with the
  day-of-month number**, and a **job-count caption** below. Compact, single row, fits a phone width (no h-scroll).
- **Selected day:** circle filled `--sched-job`, white number. **Today (if not selected):** circle has a
  `--sched-job` ring + accent number. **Today AND selected:** filled (selection wins). Other days: plain.
- **Count caption:** number of scheduled items on that day for the current technician/filters. `0` → de-emphasized
  (muted, or omitted) so the row stays visually calm; height stays stable regardless.
- **Tap a day** → `onSelectDate(day)` → `setCurrentDate(day)` → agenda reloads for that day. Selection ring/fill moves.
- **Swipe left/right** on the strip → next / previous 7 days (visible week only). Selection unchanged. Counts reload
  for the newly visible week. Lightweight touch handler (horizontal-dominant, ~45px threshold); vertical page scroll
  is preserved.
- When `currentDate` changes to a day **outside** the visible week (tap-to-today, external nav), the strip snaps its
  visible week to contain `currentDate`.

### Counts data (`useWeekJobCounts` hook)
- Input: visible `weekStart: Date`, `filters`, `timezone`. Fetches `fetchScheduleItems({ startDate, endDate, ...serverFilters })`
  for the 7-day range, then applies the **same client-side provider/tag filter as the agenda** (shared helper), then
  groups by **`dateKeyInTZ(start_at, timezone)`** counting only **scheduled** items (`start_at != null`).
- Returns `Map<'yyyy-MM-dd', number>` + `loading`. Best-effort: on error → empty map (strip still renders, no counts).
- Re-fetches when `weekStart` or the provider/tag/search filters change.

### Headline
- Large `EEE, MMM d` of `currentDate` (unchanged styling). Now a **button**: tap → `onNavigateDate('today')`.
- When `currentDate` is **not** today (company TZ), show a subtle inline affordance (small return icon / muted "Today"),
  so the tap target is discoverable. Hidden when already on today.
- The old `‹ / Today / ›` button row and the separate total-count pill are **removed** (replaced by strip + headline-tap).

## Architecture

- **New:** `frontend/src/components/schedule/WeekStrip.tsx` (presentational + swipe), `frontend/src/hooks/useWeekJobCounts.ts`.
- **Refactor (behavior-preserving):** extract the inline provider/tag filter from `useScheduleData` into a pure
  `frontend/src/services/scheduleFilters.ts#filterItemsByProviderTags(items, filters)`; `useScheduleData` and
  `useWeekJobCounts` both use it (DRY, no logic change → desktop unaffected).
- **Modify:** `MobileScheduleBar.tsx` (swap the nav row for `<WeekStrip>`, headline-as-button, new props
  `onSelectDate`, `timezone`; drop `itemCounts` pill + `ChevronLeft/Right` usage). `SchedulePage.tsx` passes
  `onSelectDate={schedule.setCurrentDate}` and `timezone={schedule.settings.timezone}` (mobile branch only).
- TZ correctness: strip day key = `format(day,'yyyy-MM-dd')`; today = `todayInTZ(tz)`; selected =
  `format(currentDate,'yyyy-MM-dd')`; counts bucket by `dateKeyInTZ(start_at, tz)` (matches the server's day assignment).

## Edge cases
- Empty week (no jobs) → all counts 0/blank, strip still navigable.
- Counts loading → circles render immediately, captions fade in (no layout shift).
- DST / browser-TZ ≠ company-TZ → day bucketing via company TZ (`dateKeyInTZ`) stays aligned with the agenda fetch.
- Selecting a day in a future/past swiped week works (tap sets `currentDate`, agenda loads, strip stays on that week).
- Provider default (mobile single-tech) + tag filters already applied → counts reflect exactly the agenda's scope.

## Test cases (frontend unit — Vitest/RTL if present, else pure-fn Jest on helpers)
- `filterItemsByProviderTags`: provider match by id and by name, `__unassigned__`, tag intersection, no-filter passthrough.
- `useWeekJobCounts` grouping: items bucketed by company-TZ day; only `start_at != null` counted; provider filter applied;
  error → empty map.
- WeekStrip render: 7 cells Sun→Sat; selected fill vs today ring vs both; tap fires `onSelectDate` with the right date;
  swipe left/right shifts the week without changing selection; snap-to-week when selected date is outside.
- Pure helpers (week days for an anchor, today/selected keys) are the P0 unit targets; component interaction is P1.

## Out of scope
- Desktop Schedule (untouched). Backend count endpoint (not needed). Live SSE count refresh (counts refresh on
  navigation/filter change; a later enhancement can wire SSE).
