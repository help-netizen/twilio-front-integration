# F013 Sprint 7 — Design Refresh: Architecture & Decisions

> **Status:** PLANNED (artifacts only, no implementation)
> **Source:** Figma Make "Dispatch Scheduling UI Design" — [GitHub export](https://github.com/help-netizen/Dispatchschedulinguidesign)
> **Scope:** Frontend-only visual overhaul. No backend/API changes.

---

## 1. Design Delta Summary

| Aspect | Current (Sprint 6) | Figma Design Target |
|--------|-------------------|---------------------|
| **Background** | `bg-white` | Warm beige gradient `#f7f3ec → #efe9df → #e3dacd` + radial glow |
| **Surfaces** | `bg-white` with standard borders | Frosted glass: `rgba(252,249,244,0.84)` + `backdrop-filter: blur(24px)` + white border |
| **Border radius** | `rounded-lg` (8px) | `rounded-[28px]` (XL), `rounded-[22px]` (lg), `rounded-[16px]` (md) |
| **Shadows** | Tailwind defaults | `0 24px 60px rgba(47,39,28,0.11)` main, `0 14px 30px rgba(36,31,25,0.11)` card |
| **Typography** | System fonts | Manrope (headings) + IBM Plex Sans (body) |
| **Title size** | Standard h1 | `clamp(34px, 4vw, 44px)` with `-0.05em` tracking |
| **Card style** | Solid bg + colored left border | Gradient bg + 4px left accent + entity/status badges |
| **Hour height** | 64px (week) / 80px (day) | 86px uniform `--hour-height` |
| **Calendar gutter** | 64px / 72px | 92px |
| **Calendar min-width** | Not enforced | 1320px (week), 800px (day) |
| **Toolbar** | Combined: view tabs + date nav + search + filters + settings | Split: ScheduleToolbar (title + AI button) + CalendarControls (view/date/filters) |
| **Sidebar width** | Flex-based | Fixed 360px, frosted glass surface |
| **Unscheduled panel** | Collapsible vertical grid below calendar | Horizontal scroll (280px cards) ABOVE CalendarControls |
| **AI features** | None | AIAssistantModal + AIScheduleInput (stub) |
| **Color tokens** | Tailwind classes | CSS custom properties (--bg, --ink-1, --job, etc.) |

---

## 2. Architecture Decisions

### AD-1: CSS Custom Properties for Design Tokens

**Decision:** Introduce `frontend/src/styles/schedule-redesign.css` with all design tokens as CSS custom properties.

**Rationale:**
- Single source of truth for the warm palette, shadows, radii, hour-height
- Easy to adjust/theme without touching component code
- Matches the Figma export structure

**Tokens:**
```css
:root {
  --bg, --bg-deep, --surface, --surface-strong, --surface-muted, --surface-contrast,
  --line, --line-strong, --ink-1, --ink-2, --ink-3,
  --job, --job-soft, --lead, --lead-soft, --task, --task-soft,
  --today-soft, --danger,
  --shadow-main, --shadow-card,
  --radius-xl, --radius-lg, --radius-md,
  --hour-height
}
```

### AD-2: Toolbar Split — ScheduleToolbar + CalendarControls

**Decision:** Split current ScheduleToolbar into two components:
1. **ScheduleToolbar** — page header: "Schedule" title + AI Assistant button
2. **CalendarControls** — view mode selector, date navigation, expandable filters

**Rationale:**
- Design separates these visually as distinct cards
- CalendarControls sits between UnscheduledPanel and calendar view
- ScheduleToolbar remains at the very top

**Migration path:**
- Current ScheduleToolbar props split between new ScheduleToolbar and CalendarControls
- `viewMode`, `currentDate`, `filters`, `onViewModeChange`, `onNavigateDate`, `onFiltersChange` → CalendarControls
- `onOpenSettings` removed from toolbar (Settings remains accessible via CalendarControls or separate button)
- New prop: `onToggleAIAssistant` → ScheduleToolbar

### AD-3: AI Features — Phase 1 Stub

**Decision:** Implement AIAssistantModal and AIScheduleInput as UI-only components. `onSubmit` callback logs to console. No backend integration in Sprint 7.

**Rationale:**
- Design includes AI features prominently
- Backend AI integration requires separate planning (prompt engineering, Gemini/Claude API, scheduling algorithm)
- UI presence communicates product direction to stakeholders
- Easy to wire up later via `onSubmit` callback

### AD-4: Page Layout — CSS Grid

**Decision:** Replace current `flex` layout in SchedulePage with CSS Grid:
```
grid-template-columns: minmax(0, 1fr) 360px  // with sidebar
grid-template-columns: 1fr                    // without sidebar
```

**Rationale:**
- Design uses fixed 360px sidebar
- Grid provides cleaner layout with gap management
- Responsive breakpoint at 1500px collapses to single column

### AD-5: Card Rendering — Gradient + Accent Border

**Decision:** ScheduleItemCard switches from solid background to:
- Entity-specific gradient background (linear-gradient top-to-bottom)
- 4px left accent border (entity color)
- Entity type badge + status badge in header row
- Manrope font for title

**Rationale:** Direct implementation of Figma design. Same data contract, different visual rendering.

### AD-6: UnscheduledPanel — Position & Layout Change

**Decision:**
- Move UnscheduledPanel from below calendar to ABOVE CalendarControls
- Switch from vertical grid to horizontal scrollable flex container
- Fixed card width: 280px, min-height: 148px

**Rationale:** Design positions unscheduled items as high-priority "ASAP scheduling" queue. Horizontal scroll is more space-efficient for a dispatch workflow.

### AD-7: Fonts — Google Fonts Import

**Decision:** Import Manrope and IBM Plex Sans via CSS `@import` from Google Fonts.

**Rationale:**
- Both fonts are free on Google Fonts
- CSS import is simplest integration path
- No bundle size impact (loaded from CDN)

### AD-8: Preserve All Functional Behavior

**Decision:** Sprint 7 is visual-only. All existing functionality MUST be preserved:
- DnD reschedule/reassign (HTML5 API)
- Click-to-create from slot
- Filter persistence (localStorage)
- SSE realtime refresh
- Sidebar selection/deselection
- DispatchSettingsDialog
- All view modes (day/week/month/timeline/timeline-week)

**Rationale:** Design refresh should not regress any Sprint 1-6 capabilities.

---

## 3. Component Change Map

| Component | Change Type | Description |
|-----------|------------|-------------|
| `SchedulePage.tsx` | **Major refactor** | CSS Grid layout, background glow effects, reorder children (toolbar → unscheduled → controls → calendar → sidebar), AI modal state |
| `ScheduleToolbar.tsx` | **Major refactor** | Strip to title + AI button only. Move view/date/filter logic out. |
| `CalendarControls.tsx` | **New component** | View mode dropdown, date nav, expandable filter bar |
| `AIAssistantModal.tsx` | **New component** | Modal with textarea, Cmd+Enter, processing state |
| `AIScheduleInput.tsx` | **New component** | Inline AI input card (optional, can be Phase 2) |
| `ScheduleItemCard.tsx` | **Major restyle** | Gradient backgrounds, accent borders, badge layout, Manrope font |
| `ScheduleSidebar.tsx` | **Major restyle** | 360px frosted glass, rail visualization, detail sections in cards, action buttons |
| `UnscheduledPanel.tsx` | **Major restyle** | Horizontal scroll, 280px cards, repositioned above calendar |
| `DayView.tsx` | **Restyle** | HOUR_HEIGHT 86px, gradient lanes, 92px gutter, min-width 800px |
| `WeekView.tsx` | **Restyle** | HOUR_HEIGHT 86px, gradient lanes, 92px gutter, min-width 1320px, enhanced today highlight |
| `MonthView.tsx` | **Restyle** | Warm palette, card surfaces |
| `TimelineView.tsx` | **Restyle** | Warm palette, provider row styling |
| `TimelineWeekView.tsx` | **Restyle** | Warm palette, provider row styling |
| `schedule-redesign.css` | **New file** | All CSS custom properties, component classes |

---

## 4. File Dependency Graph

```
schedule-redesign.css  (design tokens — imported globally)
  ↓
SchedulePage.tsx  (layout shell, AI state)
  ├── ScheduleToolbar.tsx  (title + AI button)
  ├── UnscheduledPanel.tsx  (horizontal scroll cards)
  ├── CalendarControls.tsx  (view/date/filters)  ← NEW
  ├── DayView / WeekView / MonthView / TimelineView / TimelineWeekView
  │     └── ScheduleItemCard.tsx  (gradient cards)
  ├── ScheduleSidebar.tsx  (360px detail panel)
  ├── AIAssistantModal.tsx  ← NEW
  ├── AIScheduleInput.tsx   ← NEW (optional Phase 2)
  └── DispatchSettingsDialog.tsx  (unchanged)
```

---

## 5. Risk Assessment

| Risk | Severity | Mitigation |
|------|----------|------------|
| Backdrop-filter performance on low-end devices | Low | CSS will gracefully degrade (surfaces become semi-transparent without blur) |
| Google Fonts network dependency | Low | System font fallback stack: `"Manrope", "Segoe UI", sans-serif` |
| HOUR_HEIGHT change breaks DnD snap-to-grid calculations | Medium | DnD uses `HOUR_HEIGHT` constant — update in one place, retest |
| ScheduleToolbar prop split breaks callers | Medium | SchedulePage is the only consumer — single-file migration |
| Inline styles from Figma export hard to maintain | Medium | Convert to CSS custom properties + Tailwind classes on implementation |
| CalendarControls filter state sync | Low | Same filter state from useScheduleData — just different UI wrapper |

---

## 6. Non-Goals (Sprint 7)

- Backend AI integration (prompt → schedule action)
- New API endpoints
- Schema changes
- Mobile-first responsive redesign (design is desktop-first)
- Dark mode (design provides light theme only)
- Performance optimization (lazy loading, virtualization)
- Testing AI flows end-to-end
