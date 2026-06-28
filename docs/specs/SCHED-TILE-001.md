# SCHED-TILE-001 — Schedule job-tile recomposition (agenda layout)

**Type:** UI improvement · **Area:** frontend only · **No backend/migration.**
**Surfaces:** mobile agenda (DayView mobile branch) + desktop List view (ListView). All other
views (desktop day-grid, TimelineView, TimelineWeekView, WeekView, MonthView) **unchanged**.

## Problem
The job tile (`frontend/src/components/schedule/ScheduleItemCard.tsx`) shows too many rows in a
weak priority order: `job# → STATUS → title → time → subtitle → (tech + address) → geocoding hint`.
The most-scanned facts (when, what) are buried; the job number is noise; the customer name isn't
shown at all; the technician is only a left-border color.

## Decision (owner-confirmed in interview)
Recompose to a **timeframe-led** hierarchy. Status = **Variant A (small colored dot next to the
technician name, top-right)**. Apply to **mobile agenda + desktop List**; leave time-positioned
grids compact.

## Design — `layout="agenda"`
Container keeps today's identity: provider gradient background, **4px left border = technician
color**, 1px border, 18px radius, card shadow, `opacity:0.6` when canceled, hover shadow, the same
`role=button` / Enter-Space / `onClick(item)` tap → opens JobDetailPanel.

Content composition (top → bottom):
1. **Top row** (`flex justify-between items-start`, `min-width:0`, gap):
   - **Left — timeframe (hero):** `timeLabel` (`start_at`–`end_at` via `formatTimeInTZ`), ~17px,
     weight 700, `--sched-ink-1`, `nowrap`. **This is the largest element.**
   - **Right — tech + status cluster** (`nowrap`): `techSummary` (e.g. `Alice S.`, `Alice +2`, or
     `Unassigned`) ~13px `--sched-ink-2`, then an 8px round **status dot** colored via the existing
     `STATUS_COLORS[statusKey]` (omit dot if no status; `title={item.status}` for hover). If `onCopy`
     and it's a job, the **kebab** ("Copy job") sits at the end of this cluster (tech → dot → kebab),
     not overlapping.
2. **Title:** `item.title`, ~15px, Manrope, `--sched-ink-1`, single-line truncate.
   - Edge: if there is **no `timeLabel`**, the title becomes the hero (row 1 left, ~16px) and this
     separate title row is omitted (never show an empty time slot).
3. **Customer:** `item.customer_name` — 13px, `--sched-ink-2`, truncate. **Omit row if empty.**
4. **Address:** `item.address_summary` — **13px (same size as customer)**, `--sched-ink-2`, with a
   small map-pin icon. Keep the existing Maps-link behavior (`google_maps_url` → `<a target=_blank>`
   with `stopPropagation`, `title={normalized_address}`); plain span if no URL. **Omit row if empty.**
5. **Phone (desktop `detailed` only):** when `detailed` and `item.customer_phone` present — 13px,
   `--sched-ink-3`, phone icon, `tel:` link with `stopPropagation`. Omit otherwise.

**Dropped in agenda mode:** job number, the standalone uppercase status line, `subtitle`, geocoding
hint. (All remain available in the JobDetailPanel; status is conveyed by the dot + the left color.)

## API change
`ScheduleItemCard` props add:
- `layout?: 'classic' | 'agenda'` — **default `'classic'` = today's exact rendering (untouched).**
- `detailed?: boolean` — default `false`; only meaningful with `layout='agenda'` (adds phone row).

`layout='classic'` branch must be **byte-for-byte the current JSX** (no visual change anywhere it's
already used). Implement the agenda composition as a separate return branch.

## Call-site changes (only these two)
- `frontend/src/components/schedule/DayView.tsx` — the **mobile** branch's `<ScheduleItemCard>` →
  add `layout="agenda"`.
- `frontend/src/components/schedule/ListView.tsx` — its `<ScheduleItemCard>` → add `layout="agenda"`
  and `detailed`.
All other `<ScheduleItemCard>` usages stay as-is (default classic).

## Edge cases
- Unassigned tech → `Unassigned` (no dot if also no status). · No status → no dot.
- No customer / no address / no phone → omit that row (Blanc: never render empty placeholders).
- No time → title is the hero (see Title edge).
- `entity_type` lead/task (agenda may include them) → same rules; missing fields just omit.
- Long values → single-line ellipsis; top row uses `min-width:0` so time never gets pushed off.
- Canceled → keep `opacity:0.6`.

## Test cases (Jest + RTL, P0/P1)
Render `ScheduleItemCard` with `layout="agenda"`:
- P0: timeframe text appears and is the first text node; job number (`000NNN`) is **absent**.
- P0: `customer_name` and `address_summary` both render.
- P1: technician name renders top area; status dot present when `status` set, absent when not.
- P1: `layout` omitted (classic) → still renders the job number (back-compat / no regression).
- P1: no `customer_name` → customer row not in the DOM.
- P1: `detailed` + `customer_phone` → phone renders; without `detailed` → phone absent.

## Constraints
Use existing `--sched-*` tokens, `formatTimeInTZ`, `getProviderColor`, `STATUS_COLORS`. Frontend
only. `npm run build` (tsc -b, strict/noUnusedLocals) must pass. Desktop grid/timeline byte-identical.
