# SCHED-LIST-001: Schedule List View — Behavior Spec

## Overview

New "List" view mode for the Schedule page. Vertical list of jobs per technician column, grouped by day with date headings (Pulse DateSeparator pattern). No hourly grid — items simply stack vertically sorted by start time.

---

## Behavior Scenarios

### B-01: View initialization
- When user selects "List" from view dropdown, the view renders:
  - Sticky header row with provider column headers (color dot + name)
  - Below: one vertical column per provider, items grouped by day
- Data fetched for 7-day week range (same as timeline-week)
- Columns sorted alphabetically by provider name, "Unassigned" always last

### B-02: Day grouping within columns
- Within each provider column, items are grouped by `dateKeyInTZ(item.start_at, tz)`
- Each group starts with a date heading: `DateSeparator` from Pulse
  - Format: "Mon, Apr 15" (compact) or "Today" / "Yesterday"
  - Styling: heading-style, no lines, spacing only (pt-6 pb-2)
- Days with zero items for this provider are **not rendered** (no empty headings)
- Days appear in chronological order (Monday → Sunday)

### B-03: Item rendering
- Each item rendered via `ScheduleItemCard` with `compact={false}`
- Time slot visible in card (start – end, e.g. "9:00 AM – 11:30 AM")
- Items within a day sorted by `start_at` ascending
- Click → `onSelectItem(item)` (jobs → FloatingDetailPanel, others → SidebarStack)

### B-04: Date navigation
- Prev/Next buttons navigate by **week** (±7 days)
- "Today" button jumps to current week
- Date label in CalendarControls shows week range (e.g. "Apr 13 – Apr 19, 2026")

### B-05: Provider grouping
- Same grouping logic as TimelineWeekView:
  - Items with `assigned_techs` → placed in matching provider columns
  - Items with multiple techs → appear in each tech's column
  - Items with no techs → "Unassigned" column
- If no providers exist, a single "Unassigned" column shows

### B-06: DnD reassign
- Items are draggable between columns (same drag-drop as TimelineWeekView)
- On drop → `onReassign(entityType, entityId, newProviderId, providerName)`
- Drop highlight: subtle background change on target column
- Leads are not draggable (`entity_type !== 'lead'`)

### B-07: Empty states
- If a provider has zero items in the entire week: column renders with header, empty body
- If no items at all: columns render with headers, no content

### B-08: Filters
- All existing schedule filters apply (status, source, tags, provider)
- Provider filter hides/shows columns

### B-09: Horizontal scroll
- When columns exceed viewport width, horizontal scroll enabled
- Column min-width: 200px

---

## Edge Cases

1. **Items without start_at**: Not shown in List view (only scheduled items rendered)
2. **Items spanning midnight**: Grouped by start_at date
3. **Timezone**: All date grouping and time display uses company timezone from settings
4. **Very long lists**: No virtualization needed for MVP (max ~20 providers × 7 days × 10 items)

---

## Visual Reference

The day separator follows the exact pattern from `frontend/src/components/pulse/DateSeparator.tsx`:
- `<h3>` with Manrope font, bold, `--blanc-ink-1` color
- Padding: `px-5 pt-6 pb-2` (adapted for narrower columns: `px-3 pt-4 pb-1`)
- No horizontal lines, no borders between days
