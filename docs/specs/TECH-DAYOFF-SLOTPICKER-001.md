# TECH-DAYOFF-SLOTPICKER-001 — show technician time-off inline in the "Pick a time" slot picker

**Area:** frontend only. **Backend:** no change (`/api/schedule/time-off` + provider scoping already exist).

## Problem
Job creation → **Pick time & provider** → **Pick a time** opens `CustomTimeModal`
(`frontend/src/components/conversations/CustomTimeModal.tsx`). Its per-technician lanes
(`TechTimeline`) render existing job blocks, recommendation bands and the picked slot — but
a technician's **time-off is NOT shown**. The dispatcher only learns about it as a WARNING
*after* confirming a slot. It must be visible up front, as a filled block, exactly like the
main schedule (DayView) shows it.

## Requirement (owner)
In each tech lane, render time-off **immediately** as a block that clearly reads as
"occupied but unavailable":
- Job-like block, filled **gray with diagonal hatching**, muted/dashed border.
- Label **"Time off"** inside the block + the period (start date-time → end date-time).
- **Non-interactive** (can't pick a slot there — visual overlay).
- **Multi-day** time-off fills the **working hours** of every day it covers; on an interior
  day the whole working-hour column is filled.

## What already exists (reuse — do NOT reinvent)
- `fetchTimeOff({ from, to, technician_id? }): Promise<TimeOffBlock[]>` (`services/scheduleApi.ts`)
  returns blocks overlapping `[from,to)`, provider-scoped server-side. `TimeOffBlock` =
  `{ id, technician_id, technician_name, starts_at (UTC ISO), ends_at (UTC ISO), note, source }`.
- `formatTimeOffPeriod(block, tz)` (`components/jobs/timeOffWarning.ts`) → "Mar 30, 2026 1:00 PM – Mar 31, 2026 9:00 AM".
- DayView's exact hatch (`components/schedule/DayView.tsx`):
  `TIME_OFF_BG = 'repeating-linear-gradient(135deg, rgba(25, 25, 25, 0.04) 0 10px, rgba(25, 25, 25, 0.08) 10px 20px)'`.
- TechTimeline constants (in CustomTimeModal.tsx): `HOUR_START=7`, `HOUR_END=19`, `HOUR_HEIGHT=48`,
  `TOTAL_HOURS=12`, `minutesSinceMidnight(date, tz)`, `companyTz`, `fmtTime`. Job blocks are
  positioned by `top = (startMin/60)*HOUR_HEIGHT`, `height = ((endMin-startMin)/60)*HOUR_HEIGHT`
  where `startMin = minutesSinceMidnight(start, companyTz) - HOUR_START*60`.

## Change
1. **CustomTimeModal (data).** Alongside the existing `fetchJobs`, fetch time-off for the
   **selected date**: `fetchTimeOff({ from, to })` where `from`/`to` are the start/end of
   `selectedDate` in `companyTz` as UTC ISO. Best-effort — wrap in try/catch, on failure use
   `[]` and never block (same canon as `fetchJobs`). Re-fetch when `selectedDate` changes.
   Group the returned blocks by `technician_id` and pass each tech's array into its
   `TechTimeline` via a new `timeOff?: TimeOffBlock[]` prop (thread it through the tech group
   the same way `jobs` are).
2. **TechTimeline (render).** For each time-off block overlapping the selected day, render a
   non-interactive block:
   - `startMin = minutesSinceMidnight(new Date(block.starts_at), companyTz) - HOUR_START*60`,
     `endMin = minutesSinceMidnight(new Date(block.ends_at), companyTz) - HOUR_START*60`, BUT
     because a block can start on a previous day / end on a later day, **clamp to the visible
     working window**: `top = clamp((startMin/60)*HOUR_HEIGHT, 0, TOTAL_HOURS*HOUR_HEIGHT)`,
     `bottom = clamp((endMin/60)*HOUR_HEIGHT, 0, TOTAL_HOURS*HOUR_HEIGHT)`; if the block starts
     before this day, treat its start as HOUR_START; if it ends after this day, treat its end
     as HOUR_END. Skip if the visible height ≤ 0. → a multi-day block fills 7am–7pm on interior days.
   - Style: `.tech-timeline__timeoff` — the `TIME_OFF_BG` hatch, muted/dashed border, gray ink,
     `pointer-events: none`, rendered ABOVE job blocks so it's clearly visible.
   - Content: **"Time off"** + a compact period (e.g. `fmtTime(start)–fmtTime(end)` for the
     visible portion, or "All day" when it fills the whole working window). Put the full
     `formatTimeOffPeriod(block, companyTz)` in the `title` attribute (tooltip).
3. **CSS (`CustomTimeModal.css`).** Add `.tech-timeline__timeoff` (+ its label) — same absolute
   geometry as `.tech-timeline__job`, background = the hatch, `pointer-events: none`, gray text.

## Acceptance criteria
1. Opening "Pick a time" on a date where a tech has time-off shows a gray hatched **"Time off"**
   block in THAT tech's lane, with the period, without confirming any selection first.
2. A multi-day time-off fills the working hours (7am–7pm) on each interior day; a partial day
   shows only the actual interval.
3. Other techs' lanes, job blocks, recommendation bands and slot selection are unchanged.
4. Best-effort: a `fetchTimeOff` failure just omits the blocks — the picker still works.
5. The block is non-interactive; the existing post-confirm overlap warning is unchanged.

## Out of scope
- Blocking/validating the selection against time-off (the existing warning stays as-is).
- Any backend / DayView / desktop schedule change.

## Verify
- `cd frontend && npm run build` (tsc -b strict + vite → exit 0).
- If `frontend/src/harness/slotPickerHarness.tsx` (`/harness.html`) can seed a time-off block,
  add a case so the block is visually verifiable; else state none.
- Add/extend a jest/RTL test for the block geometry+label if a CustomTimeModal test exists;
  otherwise state none. Report what you did.
