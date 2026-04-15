# SCHED-LIST-001: Schedule List View — Test Cases

## Unit Tests (Frontend)

### TC-LIST-001: ViewMode type includes 'list' (P0)
- **Type:** Unit
- **Verify:** `ViewMode` union type accepts `'list'`
- **File:** `useScheduleData.ts`

### TC-LIST-002: Date range for 'list' mode (P0)
- **Type:** Unit
- **Verify:** `dateRange` returns week range (startOfWeek → endOfWeek) when viewMode is `'list'`
- **File:** `useScheduleData.ts`

### TC-LIST-003: Navigation for 'list' mode (P0)
- **Type:** Unit
- **Verify:** `navigateDate('next')` adds 1 week, `navigateDate('prev')` subtracts 1 week when viewMode is `'list'`
- **File:** `useScheduleData.ts`

### TC-LIST-004: VIEW_OPTIONS includes List (P0)
- **Type:** Unit
- **Verify:** `VIEW_OPTIONS` array contains `{ value: 'list', label: 'List' }`
- **File:** `CalendarControls.tsx`

### TC-LIST-005: ListView renders provider columns (P0)
- **Type:** Unit / Component
- **Verify:** Given 3 providers, ListView renders 3 column headers + "Unassigned" if applicable
- **File:** `ListView.tsx`

### TC-LIST-006: ListView groups items by day (P0)
- **Type:** Unit / Component
- **Verify:** Items from different days appear under separate date headings
- **File:** `ListView.tsx`

### TC-LIST-007: Empty days are not rendered (P1)
- **Type:** Unit / Component
- **Verify:** Days with zero items for a provider produce no date heading in that column
- **File:** `ListView.tsx`

### TC-LIST-008: Items sorted by start_at within day (P1)
- **Type:** Unit / Component
- **Verify:** Items within a day group are in ascending `start_at` order
- **File:** `ListView.tsx`

### TC-LIST-009: ScheduleItemCard shows time slot (P0)
- **Type:** Visual
- **Verify:** Cards render with time label (e.g. "9:00 AM – 11:30 AM") — compact={false}
- **File:** `ListView.tsx` + `ScheduleItemCard.tsx`

### TC-LIST-010: Click item triggers onSelectItem (P0)
- **Type:** Unit / Component
- **Verify:** Clicking a card calls `onSelectItem(item)`
- **File:** `ListView.tsx`

### TC-LIST-011: SchedulePage renders ListView for 'list' mode (P0)
- **Type:** Unit / Component
- **Verify:** When `viewMode === 'list'`, SchedulePage renders `<ListView />`
- **File:** `SchedulePage.tsx`

### TC-LIST-012: Unassigned column always last (P1)
- **Type:** Unit
- **Verify:** Provider groups sorted alphabetically, `__unassigned` always at end
- **File:** `ListView.tsx`

### TC-LIST-013: DnD between columns (P2)
- **Type:** Component
- **Verify:** Dragging a job card to another provider column triggers `onReassign`
- **File:** `ListView.tsx`

### TC-LIST-014: Date separator styling matches Pulse (P2)
- **Type:** Visual
- **Verify:** Date headings use Manrope font, heading style, no border lines
- **File:** `ListView.tsx`
