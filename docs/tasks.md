# Активные задачи — Blanc Contact Center

> Этот файл содержит backlog для инициативы `F011: Refactor-readiness audit`.

## Refactor Backlog

| ID | Статус | Приоритет | Задача | Область | Acceptance criteria | Depends on |
|---|---|---|---|---|---|---|
| RF001 | planned | P0 | Синхронизировать `requirements.md`, `architecture.md`, `project-spec.md` и `README.md` с фактической структурой кода | `docs/`, `README.md` | Документы описывают `src/`, `backend/src/`, `frontend/src/`, protected zones и актуальные интеграции | - |
| RF002 | done | P0 | Зафиксировать и классифицировать quality baseline | `tests/`, `frontend` scripts | Список красных Jest suites, build warnings и lint categories зафиксирован и воспроизводим | RF001 |
| RF003 | done | P1 | Выбрать canonical frontend transport layer и убрать новые ad-hoc клиенты | `frontend/src/services/*`, `frontend/src/pages/SuperAdminPage.tsx` | Все новые запросы идут через один transport path, raw `fetch` не размножается | RF002 |
| RF004 | done | P1 | Вынести shared source для `lead-form` settings | `frontend/src/components/*`, `frontend/src/hooks/*` | Повторные вызовы `/api/settings/lead-form` сведены к shared hook/query source без изменения UI | RF003 |
| RF005 | done | P1 | Подготовить backend communication slices | `backend/src/routes/{pulse,calls,messaging,conversations}.js`, `backend/src/services/*` | Определены application/service/query boundaries для Pulse, calls, messaging и action-required | RF002 |
| RF006 | done | P1 | Разделить `backend/src/db/queries.js` на feature-specific query modules | `backend/src/db/*` | Query layer разложен по slices без изменения runtime контрактов | RF005 |
| RF007 | done | P2 | Консолидировать audio/transcription UI и phone helper contracts | `frontend/src/components/*`, `frontend/src/utils/*`, `frontend/src/lib/*`, `backend/src/utils/*` | Один shared audio/transcription contract и один canonical phone helper surface | RF003 |
| RF008 | done | P2 | Изолировать telephony admin flows от ad-hoc patterns | `frontend/src/pages/telephony/*`, `backend/src/routes/{callFlows,userGroups,phoneNumbers,vapi}.js` | Telephony admin использует те же transport/state conventions, что и остальной frontend/backend | RF003 |
| RF010 | planned | P2 | Добавить smoke/regression harness для критичных frontend flows | `frontend` test harness, `docs/test-cases/` | Есть минимальный automated coverage для Pulse, realtime и shared settings flows | RF002 |

## Tenant Team Management MVP (PF102 Sprint 3)

| ID | Статус | Приоритет | Задача | Область | Acceptance criteria | Depends on |
|---|---|---|---|---|---|---|
| TM001 | planned | P0 | Backend: расширение User Management API | `backend/src/routes/users.js`, `backend/src/services/userService.js` | PATCH поддерживает `role_key`, `status` и обновляет `company_user_profiles`. | PF103 Contracts |
| TM002 | planned | P0 | Frontend: расширение Company Users Table | `frontend/src/pages/CompanyUsersPage.tsx` | Таблица отображает локальные поля профиля, статус и системную `role_key`. | TM001 |
| TM003 | planned | P1 | Frontend: диалоги создания и редактирования | `frontend/src/pages/CompanyUserDialogs.tsx` | Диалоги позволяют настроить schedule color, phone calls и новые системные роли. | TM002 |

## F013 Schedule Sprint 3: UX Hardening (✅ DONE)

| ID | Статус | Приоритет | Задача | Область | Acceptance criteria | Depends on |
|---|---|---|---|---|---|---|
| SC301 | done | P0 | Shared timezone utils | `frontend/src/utils/companyTime.ts` | ✅ | - |
| SC302 | done | P0 | Timezone-aware DayView + WeekView | `frontend/src/components/schedule/DayView.tsx`, `WeekView.tsx` | ✅ | SC301 |
| SC303 | done | P0 | Timezone-aware TimelineView + sidebar + card | `frontend/src/components/schedule/TimelineView.tsx`, `ScheduleSidebar.tsx`, `ScheduleItemCard.tsx` | ✅ | SC301 |
| SC304 | done | P0 | Past-time overlay + now-line (DayView + WeekView) | `frontend/src/components/schedule/DayView.tsx`, `WeekView.tsx` | ✅ | SC302 |
| SC305 | done | P1 | Past-time overlay (TimelineView + TimelineWeekView) | `frontend/src/components/schedule/TimelineView.tsx`, `TimelineWeekView.tsx` | ✅ | SC303 |
| SC306 | done | P1 | Realtime SSE подписка для schedule | `frontend/src/hooks/useScheduleData.ts` | ✅ | - |

## F013 Schedule Sprint 6: Interactive Dispatch (✅ DONE)

| ID | Статус | Приоритет | Задача | Область | Acceptance criteria | Depends on |
|---|---|---|---|---|---|---|
| SC601 | done | P0 | Расширенные фильтры в ScheduleToolbar | `ScheduleToolbar.tsx`, `useScheduleData.ts`, `scheduleApi.ts` | ✅ Status multi-select, job_type, source filters; localStorage persistence; reset button; collapsible "More Filters" row | - |
| SC602 | done | P1 | DispatchSettingsDialog | `DispatchSettingsDialog.tsx`, `ScheduleToolbar.tsx`, `useScheduleData.ts` | ✅ Gear button → modal: timezone, work hours, work days, slot duration; save → PATCH /settings → toast | - |
| SC603 | done | P1 | createFromSlot API + Create-from-slot UI | `scheduleApi.ts`, `SlotContextMenu.tsx`, `DayView.tsx`, `WeekView.tsx` | ✅ Click empty slot → context menu → "Create Task" → inline form → POST /from-slot | - |
| SC604 | done | P1 | Shared DnD utilities + hook | `useScheduleDnD.ts` | ✅ DnD data helpers, snap-to-grid, hasDragData/getDragData/setDragData | - |
| SC605 | done | P1 | DnD reschedule (DayView + WeekView) | `DayView.tsx`, `WeekView.tsx` | ✅ Job/task draggable → drop → snap-to-grid → optimistic update + API; cross-day in WeekView; leads not draggable | SC604 |
| SC606 | done | P1 | DnD reschedule (TimelineView) | `TimelineView.tsx` | ✅ Horizontal drag → reschedule; combined reschedule+reassign | SC604 |
| SC607 | done | P1 | DnD reassign (TimelineView + TimelineWeekView) | `TimelineView.tsx`, `TimelineWeekView.tsx` | ✅ Drag between provider rows → PATCH /reassign; unassign → null; leads not draggable | SC604 |
| SC608 | done | P2 | Wire features into SchedulePage + build | `SchedulePage.tsx`, `useScheduleData.ts` | ✅ All features wired; tsc + vite build pass | SC601-SC607 |

## F013 Schedule Sprint 7: Design Refresh — Figma Make UI Overhaul (PLANNED)

> **Спецификация:** `docs/specs/F013-schedule-sprint7-design-refresh.md` (архитектура), `docs/specs/F013-schedule-sprint7-spec.md` (детали)
> **Тест-кейсы:** `docs/test-cases/F013-schedule-sprint7.md`
> **Scope:** Frontend-only. Без изменения backend/API.

| ID | Статус | Приоритет | Задача | Область | Acceptance criteria | Depends on |
|---|---|---|---|---|---|---|
| SC701 | planned | P0 | CSS design tokens + font imports | `frontend/src/styles/schedule-redesign.css`, `index.css` | `schedule-redesign.css` создан со всеми CSS custom properties (--bg, --ink-*, --job/lead/task, --shadow-*, --radius-*, --hour-height: 86px). Google Fonts (Manrope + IBM Plex Sans) подключены. Файл импортирован в entry point. | - |
| SC702 | planned | P0 | SchedulePage layout refactor | `SchedulePage.tsx` | CSS Grid layout (`minmax(0,1fr) 360px` / `1fr`). Warm gradient background + 2 glow circles. max-width 1780px workspace. Children reordered: toolbar → grid(unscheduled → controls → calendar ‖ sidebar). AI modal state wired. | SC701 |
| SC703 | planned | P0 | ScheduleToolbar — simplify to title + AI button | `ScheduleToolbar.tsx` | Toolbar renders only: frosted glass card с "Schedule" heading (Manrope clamp 34-44px) + AI Assistant button (purple gradient). Все view/date/filter props удалены. | SC702 |
| SC704 | planned | P0 | CalendarControls — new component | `CalendarControls.tsx` | Frosted glass card: view mode dropdown (Day/Week/Month/Timeline/TL Week) + date nav buttons (prev/today/next) + expandable "Filters" toggle (search, entity type, assignment, legend chips). Props: viewMode, currentDate, filters, onViewModeChange, onNavigateDate, onFiltersChange. | SC702 |
| SC705 | planned | P1 | AIAssistantModal — new component | `AIAssistantModal.tsx` | Modal overlay: dark backdrop + blur, 680px max-width card, Wand2 icon header, textarea (autofocus, min-h-[140px]), processing state (Sparkles animate-pulse), Cancel + "Create with AI" buttons, Cmd+Enter/Escape shortcuts. Phase 1: onSubmit → console.log. | SC703 |
| SC706 | planned | P1 | ScheduleItemCard — gradient redesign | `ScheduleItemCard.tsx` | Entity gradient backgrounds (job=blue, lead=amber, task=green) + 4px left accent border. Header: entity badge + status badge (colored per status map). Title: Manrope 15px. Footer: tech summary + address. Shadow: var(--shadow-card). Hover: shadow-xl. | SC701 |
| SC707 | planned | P1 | ScheduleSidebar — frosted glass redesign | `ScheduleSidebar.tsx` | 360px width, frosted glass surface. Header: entity badge with icon + status + X + Manrope 28px title. Sections in rounded-[20px] cards: Scheduled (+ rail visualization), Contact (info-row with dashed dividers), Location, Assigned crew (blue pills), Tags (white pills), Actions (primary gradient + secondary buttons). | SC701 |
| SC708 | planned | P1 | UnscheduledPanel — horizontal scroll + reposition | `UnscheduledPanel.tsx`, `SchedulePage.tsx` | Frosted glass card. Header: "UNSCHEDULED" eyebrow + count. Horizontal flex scroll (overflow-x-auto), cards 280px × 148px min-height. Gradient + accent border per entity. Positioned ABOVE CalendarControls in SchedulePage. | SC701, SC702 |
| SC709 | planned | P1 | DayView + WeekView — calendar grid restyle | `DayView.tsx`, `WeekView.tsx` | HOUR_HEIGHT → 86px (via CSS var). Time gutter: 92px. Gradient lane backgrounds + repeating hour lines. Today: warm yellow tint. Past-wash: brownish `rgba(58,48,39,0.06)`. Now-line: red + pill. WeekView: min-width 1320px, grid 92px + 7×minmax(150px,1fr). Day headers: eyebrow name + Manrope 30px number + count pill. Frosted glass wrapper. | SC701 |
| SC710 | planned | P2 | TimelineView + TimelineWeekView restyle | `TimelineView.tsx`, `TimelineWeekView.tsx` | Warm palette provider rows. Frosted glass card wrapper. DnD highlight: warm green tint. Provider labels: ink-2 / ink-3 for unassigned. Functional DnD unchanged. | SC701 |
| SC711 | planned | P2 | MonthView restyle | `MonthView.tsx` | Frosted glass card wrapper, warm palette cells, entity-colored count badges. | SC701 |
| SC712 | planned | P2 | Responsive breakpoints | All schedule components | ≤1500px: sidebar collapses, max-width 760px. ≤1100px: padding 18px. ≤760px: filters full-width. Media queries in schedule-redesign.css or component styles. | SC702 |
| SC713 | planned | P2 | Build verification + regression | All | `tsc --noEmit` + `vite build` pass. DnD reschedule/reassign works with HOUR_HEIGHT 86px. Filter persistence intact. SSE refresh works. All 5 views render. Sidebar open/close transitions grid correctly. | SC701-SC712 |
