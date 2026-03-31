# F013 Sprint 7 — Design Refresh: Test Cases

> **Spec:** `docs/specs/F013-schedule-sprint7-spec.md`
> **Scope:** Visual verification + functional regression

---

## TC-7.01: Design Token Application

**Precondition:** Schedule page loaded at `/schedule`

| Step | Action | Expected |
|------|--------|----------|
| 1 | Open `/schedule` | Page background is warm beige gradient (#f7f3ec → #efe9df → #e3dacd), NOT white |
| 2 | Inspect any surface card (toolbar, calendar controls, sidebar) | Background is semi-transparent (`rgba(252,249,244,0.84)`), `backdrop-filter: blur(24px)` applied |
| 3 | Inspect border-radius of toolbar, calendar controls | Radius ≥ 24px (rounded-[28px] or rounded-[24px]) |
| 4 | Inspect text color of main labels | Primary text is `#202734`, secondary `#536070`, tertiary `#7d8796` |
| 5 | Verify two background glow circles are visible | Blue glow top-right, amber glow bottom-left (fixed position, pointer-events: none) |

---

## TC-7.02: ScheduleToolbar — Title + AI Button

| Step | Action | Expected |
|------|--------|----------|
| 1 | Load `/schedule` | Top card shows "Schedule" heading in Manrope font, large (34-44px), no view tabs visible |
| 2 | Verify AI Assistant button present | Purple gradient button with Sparkles icon and "AI Assistant" label in toolbar |
| 3 | Verify NO date navigation in toolbar | Date navigation (prev/next/today) is NOT in the toolbar card |
| 4 | Verify NO filter controls in toolbar | Search, entity type filter, status filter are NOT in the toolbar card |

---

## TC-7.03: CalendarControls Component

| Step | Action | Expected |
|------|--------|----------|
| 1 | Locate CalendarControls card | Appears below UnscheduledPanel, above calendar. Frosted glass card with rounded corners. |
| 2 | Click view mode dropdown | Options: Day, Week, Month, Timeline, TL Week |
| 3 | Select "Day" | Calendar switches to DayView. Dropdown shows "Day". |
| 4 | Click ◀ (prev) button | Date moves back by 1 day (in day mode) / 1 week (in week mode) |
| 5 | Click "Today" button | Date resets to today |
| 6 | Click ▶ (next) button | Date moves forward |
| 7 | Click "Filters" button | Expands filter row below controls. Button bg turns dark (#202734). |
| 8 | Type in search field | onFiltersChange called with search value |
| 9 | Click "Filters" button again | Filter row collapses. Button returns to light style. |
| 10 | Verify legend chips visible in filter row | Job (blue), Lead (amber), Task (green) chips on the right side |

---

## TC-7.04: AI Assistant Modal

| Step | Action | Expected |
|------|--------|----------|
| 1 | Click "AI Assistant" button in toolbar | Modal overlay appears with dark backdrop (blur effect) |
| 2 | Verify modal header | Wand2 icon in amber badge, "AI Schedule Assistant" title, description text |
| 3 | Verify textarea is auto-focused | Cursor is in the textarea |
| 4 | Type a description | Text appears in textarea |
| 5 | Press Escape | Modal closes |
| 6 | Reopen modal, type text, press Cmd+Enter (or Ctrl+Enter) | "Create with AI" action fires (console.log in Phase 1), modal closes |
| 7 | Reopen modal, click backdrop | Modal closes |
| 8 | Click "Cancel" button | Modal closes, input cleared |
| 9 | Verify disabled state | "Create with AI" button disabled when textarea is empty (opacity reduced) |
| 10 | Submit text | Processing state shows: Sparkles animation + "AI is analyzing..." banner |

---

## TC-7.05: ScheduleItemCard — Gradient Design

| Step | Action | Expected |
|------|--------|----------|
| 1 | View a Job card in any calendar view | Blue gradient background, 4px blue left accent border |
| 2 | View a Lead card | Amber gradient background, 4px amber left accent border |
| 3 | View a Task card | Green gradient background, 4px green left accent border |
| 4 | Inspect card header | Entity type badge (uppercase, pill shape) on left, status badge on right |
| 5 | Verify status color for "Scheduled" | Status badge text color is `#3654b7` |
| 6 | Verify status color for "Completed" | Status badge text color is `#21724f` |
| 7 | Inspect title font | Manrope font family, 15px, semibold |
| 8 | Inspect footer | Tech name on left, address on right, 11px, gray color |
| 9 | Hover over card | Shadow increases (hover:shadow-xl transition) |

---

## TC-7.06: ScheduleSidebar — Redesigned Detail Panel

| Step | Action | Expected |
|------|--------|----------|
| 1 | Click any scheduled item | Sidebar appears on the right (360px width) |
| 2 | Verify sidebar surface | Frosted glass (semi-transparent, blur), rounded-[28px] |
| 3 | Verify header | Entity badge with icon + status badge + X button + Title (Manrope 28px) + subtitle |
| 4 | Verify "Scheduled" section | Date/time display + 3-segment rail bar (gray-blue gradient-gray) |
| 5 | Verify "Contact" section | Info rows with dashed dividers (key left, value right) |
| 6 | Verify "Assigned crew" section | Blue pills for each tech |
| 7 | Verify "Tags" section (if item has tags) | White pills for each tag |
| 8 | Verify "Actions" section | "Open {entity} detail" (blue gradient button) + "Open in Pulse" (white button) |
| 9 | Click X button | Sidebar closes |
| 10 | Verify grid layout adjusts | Page grid switches from 2-column to 1-column when sidebar closes |

---

## TC-7.07: UnscheduledPanel — Horizontal Layout

| Step | Action | Expected |
|------|--------|----------|
| 1 | Verify panel position | UnscheduledPanel appears ABOVE CalendarControls, not below calendar |
| 2 | Verify horizontal layout | Cards arranged horizontally with `overflow-x: auto` |
| 3 | Verify card width | Each card is 280px fixed width, min-height 148px |
| 4 | Scroll horizontally | More cards become visible if > container width |
| 5 | Verify header | "UNSCHEDULED" eyebrow label + "{N} items" count |
| 6 | Click an unscheduled card | Sidebar opens with item details |
| 7 | Verify card styling | Same gradient + accent border style as ScheduleItemCard |
| 8 | Verify empty state | Panel hidden when 0 unscheduled items |

---

## TC-7.08: Calendar Grid — Week/Day Views

| Step | Action | Expected |
|------|--------|----------|
| 1 | Open Week view | Calendar wrapped in frosted glass card |
| 2 | Measure hour slot height | ~86px per hour (not 64px or 80px) |
| 3 | Verify time gutter width | ~92px (wider than before) |
| 4 | Verify today column | Warm yellow tint on today column header and lane |
| 5 | Verify day header | Day name (eyebrow uppercase), day number (Manrope 30px), item count pill |
| 6 | Verify past-time overlay | Brownish tint (`rgba(58,48,39,0.06)`) over past hours |
| 7 | Verify now-line | Red horizontal line + red pill with current time |
| 8 | Verify hour grid lines | Visible repeating lines at each hour boundary |
| 9 | Switch to Day view | Same styling, single column, min-width 800px |
| 10 | Horizontal scroll in Week | Frame scrollable when viewport < 1320px |

---

## TC-7.09: Typography & Fonts

| Step | Action | Expected |
|------|--------|----------|
| 1 | Inspect "Schedule" heading | Font-family includes "Manrope" |
| 2 | Inspect day numbers in week header | Font-family includes "Manrope" |
| 3 | Inspect card titles | Font-family includes "Manrope" |
| 4 | Inspect body text (descriptions, labels) | Font-family includes "IBM Plex Sans" |
| 5 | Inspect eyebrow labels | 10-11px, uppercase, letter-spacing ~0.14em |
| 6 | Verify minimum font size | No text element smaller than 10px |

---

## TC-7.10: Responsive Breakpoints

| Step | Action | Expected |
|------|--------|----------|
| 1 | Resize to 1400px width | Sidebar collapses to below calendar content, max-width 760px |
| 2 | Resize to 1000px width | Workspace padding reduces to 18px |
| 3 | Resize to 700px width | Filter fields stack to full width |
| 4 | Resize back to 1600px+ | Layout returns to 2-column grid with sidebar |

---

## Regression Tests (Functional — MUST PASS)

### RT-7.01: DnD Reschedule
| Step | Action | Expected |
|------|--------|----------|
| 1 | Drag a Job card to a different time slot (DayView) | Card snaps to new time, API PATCH /reschedule called |
| 2 | Drag a Job card across days (WeekView) | Card moves to new day/time |
| 3 | Verify leads are NOT draggable | Lead cards do not respond to drag |

### RT-7.02: DnD Reassign
| Step | Action | Expected |
|------|--------|----------|
| 1 | Drag Job between provider rows (TimelineView) | Job reassigned to target provider row |
| 2 | Drop on "Unassigned" row | Job unassigned |

### RT-7.03: Filter Persistence
| Step | Action | Expected |
|------|--------|----------|
| 1 | Set entity type filter to "job" | Only job items shown |
| 2 | Refresh page | Filter restored from localStorage — still "job" only |

### RT-7.04: SSE Realtime Refresh
| Step | Action | Expected |
|------|--------|----------|
| 1 | Schedule is open, another user creates a job | New job appears in schedule after SSE event (debounced) |

### RT-7.05: Create From Slot
| Step | Action | Expected |
|------|--------|----------|
| 1 | Click empty slot in DayView | Context menu appears → "Create Task" |
| 2 | Enter title and confirm | New task created at that time slot |

### RT-7.06: Dispatch Settings
| Step | Action | Expected |
|------|--------|----------|
| 1 | Open settings dialog | Timezone, work hours, work days, slot duration fields present |
| 2 | Change timezone and save | Calendar re-renders with new timezone |

### RT-7.07: View Mode Navigation
| Step | Action | Expected |
|------|--------|----------|
| 1 | Switch between Day/Week/Month/Timeline/Timeline-Week | Each view renders correctly with new styling |
| 2 | Navigate dates (prev/next/today) in each view | Dates update correctly |

### RT-7.08: Item Selection → Sidebar
| Step | Action | Expected |
|------|--------|----------|
| 1 | Click any item in any view | Sidebar opens with correct item details |
| 2 | Click X in sidebar | Sidebar closes, grid adjusts |

---

## Build Verification

| Check | Command | Expected |
|-------|---------|----------|
| TypeScript | `npx tsc --noEmit` | No errors |
| Vite build | `npx vite build` | Build succeeds, no warnings related to schedule components |
| Dev server | `npx vite --port 3001` | Dev server starts, `/schedule` loads without console errors |
