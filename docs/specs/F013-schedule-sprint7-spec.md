# F013 Sprint 7 — Design Refresh: Detailed Specification

> **Status:** PLANNED
> **Architecture:** `docs/specs/F013-schedule-sprint7-design-refresh.md`
> **Scope:** Frontend-only. No backend/API changes.

---

## 1. Design Token System (`schedule-redesign.css`)

### 1.1 New File: `frontend/src/styles/schedule-redesign.css`

Import via `index.css` or `main.tsx`. All tokens as CSS custom properties under `:root`.

```css
:root {
  /* Backgrounds */
  --bg: #efe9df;
  --bg-deep: #e3dacd;

  /* Surfaces (frosted glass) */
  --surface: rgba(252, 249, 244, 0.84);
  --surface-strong: #fffdf9;
  --surface-muted: #f4ede2;
  --surface-contrast: #ece5d8;

  /* Borders */
  --line: rgba(117, 106, 89, 0.18);
  --line-strong: rgba(97, 86, 71, 0.28);

  /* Text */
  --ink-1: #202734;     /* primary */
  --ink-2: #536070;     /* secondary */
  --ink-3: #7d8796;     /* tertiary */

  /* Entity colors */
  --job: #2f63d8;
  --job-soft: rgba(228, 238, 255, 0.92);
  --lead: #b26a1d;
  --lead-soft: rgba(255, 242, 225, 0.96);
  --task: #1b8b63;
  --task-soft: rgba(228, 247, 239, 0.98);

  /* Semantic */
  --today-soft: rgba(255, 247, 231, 0.9);
  --danger: #d44d3c;

  /* Shadows */
  --shadow-main: 0 24px 60px rgba(47, 39, 28, 0.11);
  --shadow-card: 0 14px 30px rgba(36, 31, 25, 0.11);

  /* Radii */
  --radius-xl: 28px;
  --radius-lg: 22px;
  --radius-md: 16px;

  /* Layout */
  --hour-height: 86px;
}
```

### 1.2 Font Import

Add to `schedule-redesign.css` or `index.css`:
```css
@import url('https://fonts.googleapis.com/css2?family=Manrope:wght@400;500;600;700;800&family=IBM+Plex+Sans:wght@400;500;600;700&display=swap');
```

### 1.3 Global Schedule Page Background

The SchedulePage root div applies:
```css
background: radial-gradient(circle at top left, rgba(255,255,255,0.9), transparent 28%),
            linear-gradient(180deg, #f7f3ec 0%, var(--bg) 44%, var(--bg-deep) 100%);
color: var(--ink-1);
font-family: "IBM Plex Sans", "Segoe UI", sans-serif;
```

Two decorative glow circles (fixed, pointer-events: none):
- Top-right: 420×420px, `rgba(47,99,216,0.14)`, blur(30px), opacity 0.5
- Bottom-left: 360×360px, `rgba(178,106,29,0.12)`, blur(30px), opacity 0.5

---

## 2. SchedulePage Layout

### 2.1 Current Layout (Sprint 6)
```
<div flex h-full bg-white>
  <div flex-col flex-1>
    <ScheduleToolbar />          <!-- view tabs + date nav + search + filters + settings -->
    <div flex-1 overflow-auto>
      <CalendarView />
    </div>
    <UnscheduledPanel />         <!-- collapsible, below calendar -->
  </div>
  <ScheduleSidebar />            <!-- conditional, right side -->
  <DispatchSettingsDialog />
</div>
```

### 2.2 Target Layout (Sprint 7)
```
<div min-h-screen relative>
  <!-- Background glows (2 fixed circles) -->

  <div max-w-[1780px] mx-auto p-7.5>
    <ScheduleToolbar />            <!-- simplified: title + AI Assistant button -->

    <div grid gap-5 mt-5           <!-- grid: 1fr [360px] -->
         style={selectedItem ? 'minmax(0,1fr) 360px' : '1fr'}>

      <div grid gap-4.5>           <!-- left stack -->
        <UnscheduledPanel />       <!-- MOVED UP: horizontal scroll -->
        <CalendarControls />       <!-- NEW: view mode + date nav + filters -->
        <CalendarView />           <!-- same views, restyled -->
      </div>

      <ScheduleSidebar />          <!-- conditional 360px -->
    </div>
  </div>

  <AIAssistantModal />             <!-- overlay modal -->
  <DispatchSettingsDialog />
</div>
```

### 2.3 Key Changes
- Root element: `min-h-screen` instead of `h-full`, warm gradient background
- Grid layout replaces flex for main content area
- UnscheduledPanel moves above CalendarControls
- New CalendarControls component
- AIAssistantModal added (toggled via ScheduleToolbar button)
- `max-width: 1780px`, `padding: 30px` workspace shell

---

## 3. Component Specifications

### 3.1 ScheduleToolbar (refactored)

**Props change:**
```typescript
// Before (Sprint 6)
interface ScheduleToolbarProps {
  viewMode: ViewMode;
  currentDate: Date;
  filters: ScheduleFilters;
  itemCounts: { total: number; filtered: number };
  loading: boolean;
  onViewModeChange: (mode: ViewMode) => void;
  onNavigateDate: (direction: 'prev' | 'next' | 'today') => void;
  onFiltersChange: (filters: ScheduleFilters) => void;
  onOpenSettings: () => void;
}

// After (Sprint 7)
interface ScheduleToolbarProps {
  onToggleAIAssistant?: () => void;
}
```

**Rendering:**
- Frosted glass card: `background: var(--surface)`, `border: 1px solid rgba(255,255,255,0.55)`, `border-radius: var(--radius-xl)`, `box-shadow: var(--shadow-main)`, `backdrop-filter: blur(24px)`
- Left: `<h1>` "Schedule" — Manrope, `clamp(34px, 4vw, 44px)`, bold, `-0.05em` tracking
- Right: "AI Assistant" button — purple gradient (`rgba(139,92,246,0.95)` → `rgba(99,102,241,0.95)`), white text, Sparkles icon, `min-h-[48px]`, `rounded-[16px]`

### 3.2 CalendarControls (NEW)

**File:** `frontend/src/components/schedule/CalendarControls.tsx`

**Props:**
```typescript
interface CalendarControlsProps {
  viewMode: ViewMode;
  currentDate: Date;
  filters: ScheduleFilters;
  onViewModeChange: (mode: ViewMode) => void;
  onNavigateDate: (direction: 'prev' | 'next' | 'today') => void;
  onFiltersChange: (filters: ScheduleFilters) => void;
}
```

**Structure:**
- Frosted glass card: gradient background, `rounded-[24px]`, backdrop-filter
- **Row 1 (always visible):**
  - Left: View mode `<select>` dropdown — Day/Week/Month/Timeline/TL Week. `min-h-[42px]`, `rounded-[14px]`, surface-strong background, ChevronDown icon
  - Center: Date navigation — `◀` / "Today" / `▶` buttons, each `42px` square/pill, `rounded-[14px]`
  - Right: "Filters" toggle button — SlidersHorizontal icon, toggles dark bg when active
- **Row 2 (expandable, shown when filters toggled):**
  - Search field: label "SEARCH", placeholder "Customer, address, phone, tag", `flex: 1 1 320px`, `min-w-[240px]`
  - Entity type button: label "ENTITY TYPE", shows current filter or "All types"
  - Assignment button: label "ASSIGNMENT", shows "Mixed crews" or "Unassigned only"
  - Legend chips: Job (blue), Lead (amber), Task (green) — aligned right

**Label style (eyebrow):** `text-[10px]`, `font-semibold`, `tracking-widest`, `uppercase`, `color: #7d8796`

### 3.3 AIAssistantModal (NEW)

**File:** `frontend/src/components/schedule/AIAssistantModal.tsx`

**Props:**
```typescript
interface AIAssistantModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSubmit?: (input: string) => void;
}
```

**Behavior:**
- Backdrop: `rgba(32,39,52,0.65)` + `backdrop-filter: blur(8px)`, click → close
- Modal: `max-w-[680px]`, `rounded-[28px]`, warm gradient background, amber border accent
- Header: Wand2 icon in amber badge + "AI Schedule Assistant" title (Manrope 20px) + description + X close button
- Processing state: Sparkles icon (animate-pulse) + "AI is analyzing your request..." amber banner
- Textarea: `min-h-[140px]`, `rounded-[16px]`, placeholder with example address
- Info banner: "What AI will do" — auto-parse, find time, assign tech
- Buttons: Cancel (secondary) + "Create with AI" (amber gradient primary, Send icon)
- Keyboard: `Cmd/Ctrl + Enter` → submit. `Escape` → close
- Phase 1: `onSubmit` → `console.log` (no backend)

### 3.4 AIScheduleInput (NEW, optional Phase 2)

**File:** `frontend/src/components/schedule/AIScheduleInput.tsx`

Inline card version of AI input. Can be placed in the left-stack grid. Same `onSubmit` callback, compact layout with side-by-side textarea + submit button.

### 3.5 ScheduleItemCard (restyled)

**Props:** Unchanged from Sprint 6.

**Visual changes:**
- Container: `rounded-[18px]`, border from entity style, `box-shadow: var(--shadow-card)`, `border-left: 4px solid {accent}`
- Background: entity-specific gradient:
  - Job: `linear-gradient(180deg, rgba(244,248,255,0.98), rgba(232,240,255,0.92))`
  - Lead: `linear-gradient(180deg, rgba(255,248,238,0.98), rgba(255,241,222,0.94))`
  - Task: `linear-gradient(180deg, rgba(240,250,246,0.98), rgba(228,247,239,0.96))`
- Header row: entity badge (uppercase, `min-h-[24px]`, `rounded-full`, translucent white bg) + status badge (colored text per status)
- Title: Manrope, `15px`, `font-semibold`, `-0.03em` tracking
- Time: `12px`, `font-semibold`, `color: var(--ink-2)`
- Subtitle: `13px`, `color: var(--ink-2)`
- Footer: tech summary (left) + address (right), `11px`, `font-semibold`, `color: var(--ink-3)`

**Status color map:**
| Status | Color |
|--------|-------|
| submitted / contacted | `#2c63d2` |
| scheduled | `#3654b7` |
| qualified | `#9a5a14` |
| in_progress / en_route | `#a65312` |
| completed | `#21724f` |
| new | `#616d7e` |
| rescheduled | `#7c5360` |

### 3.6 ScheduleSidebar (restyled)

**Props:** Unchanged from Sprint 6.

**Visual changes:**
- Container: `w-[360px]`, `rounded-[28px]`, frosted glass surface, `box-shadow: var(--shadow-main)`
- Header: gradient background, entity badge with icon (Briefcase/UserPlus/CheckSquare), status badge, X close button, title Manrope 28px, subtitle
- Content sections: each in `rounded-[20px]` bordered card:
  - **Scheduled:** date/time display + schedule rail (3-segment bar: gray | blue gradient | gray)
  - **Contact:** customer name/phone/email in info-row layout (key left, value right, dashed divider)
  - **Location:** address display
  - **Assigned crew:** pills with blue background (`rgba(47,99,216,0.08)`)
  - **Tags:** pills with white background
  - **Actions:** "Open {entity} detail" (primary blue gradient button) + "Open in Pulse" (secondary white button)

### 3.7 UnscheduledPanel (restyled + repositioned)

**Props:** Unchanged from Sprint 6.

**Visual changes:**
- Container: frosted glass card, `rounded-[28px]`
- Header: "UNSCHEDULED" eyebrow label + "{N} items" count
- Item list: `flex gap-3 overflow-x-auto` (horizontal scroll), `scrollbar-width: thin`
- Cards: `flex-none w-[280px]`, `min-h-[148px]`, `rounded-[18px]`, gradient bg + accent left border
- Card content mirrors ScheduleItemCard layout

**Position change:** In SchedulePage, rendered ABOVE CalendarControls (before calendar views).

### 3.8 DayView (restyled)

**Key style changes:**
- `--hour-height: 86px` (was 80px)
- Time gutter: `92px` width (was ~72px)
- Time axis background: gradient + repeating-linear-gradient for hour lines
- Day lane background: gradient + repeating hour lines
- Today lane: warm yellow tint `rgba(255,249,237,0.88)`
- Past-time wash: `rgba(58,48,39,0.06)` (was blue-gray tint)
- Now-line: `border-top: 2px solid var(--danger)` (red)
- Now-stamp: red pill with white text, `rounded-full`
- Schedule items use CSS custom properties for positioning: `--start`, `--span`, `--left`, `--width`
- Container: frosted glass card wrapper, min-width: 800px

**Functional changes:** None. DnD, click-to-create, collision lanes — unchanged.

### 3.9 WeekView (restyled)

**Key style changes:**
- Same as DayView + 7-column grid
- Calendar frame: `min-width: 1320px`
- Grid: `grid-template-columns: 92px repeat(7, minmax(150px, 1fr))`
- Day headers: `min-height: 104px`, day name (eyebrow), day number (Manrope 30px), item count summary pill
- Today column: warm gradient header + lane tint
- Corner cell: shows month/year

**Functional changes:** None.

### 3.10 TimelineView + TimelineWeekView (restyled)

**Key style changes:**
- Warm palette for provider rows
- Frosted glass card wrapper
- Provider name: `text-sm font-medium`, `color: var(--ink-2)`
- Unassigned row: italic, `color: var(--ink-3)`
- DnD highlight: warm green tint instead of `bg-green-50`

**Functional changes:** None. DnD reassign/reschedule preserved.

### 3.11 MonthView (restyled)

- Frosted glass card wrapper
- Day cells with warm backgrounds
- Item count badges in entity colors

---

## 4. Responsive Breakpoints

| Breakpoint | Changes |
|-----------|---------|
| **≤ 1500px** | Page grid collapses to single column. Sidebar renders below calendar, max-width 760px. |
| **≤ 1100px** | Workspace padding: 18px. Unscheduled grid (if fallback to grid): 2 columns. |
| **≤ 760px** | Toolbar padding: 20px. Filter fields: `min-width: 100%`. Unscheduled: single column. |

---

## 5. Integration Checklist

- [ ] `schedule-redesign.css` imported in entry point
- [ ] Google Fonts loaded (Manrope + IBM Plex Sans)
- [ ] SchedulePage layout refactored to CSS Grid
- [ ] ScheduleToolbar stripped to title + AI button
- [ ] CalendarControls created with view/date/filter props from useScheduleData
- [ ] AIAssistantModal wired with stub onSubmit
- [ ] ScheduleItemCard gradient backgrounds + accent borders
- [ ] ScheduleSidebar frosted glass + rail + sections
- [ ] UnscheduledPanel horizontal scroll + repositioned
- [ ] DayView/WeekView HOUR_HEIGHT updated to 86px
- [ ] All views wrapped in frosted glass card surfaces
- [ ] Background glow effects on SchedulePage
- [ ] Responsive breakpoints tested
- [ ] DnD reschedule/reassign verified working with new HOUR_HEIGHT
- [ ] Filter persistence verified
- [ ] SSE refresh verified
- [ ] TypeScript build passes (`tsc --noEmit`)
- [ ] Vite build passes (`vite build`)
