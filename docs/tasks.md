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

## F013 Schedule Sprint 3: UX Hardening + Interactive Dispatch

| ID | Статус | Приоритет | Задача | Область | Acceptance criteria | Depends on |
|---|---|---|---|---|---|---|
| SC301 | pending | P0 | Shared timezone utils: вынести `minutesSinceMidnight` + `formatTimeInTZ` в `companyTime.ts` | `frontend/src/utils/companyTime.ts`, `frontend/src/components/conversations/CustomTimeModal.tsx` | `minutesSinceMidnight` и `formatTimeInTZ` экспортируются из `companyTime.ts`; CustomTimeModal импортирует оттуда вместо локальной копии; существующие тесты проходят | - |
| SC302 | pending | P0 | Timezone-aware DayView + WeekView | `frontend/src/components/schedule/DayView.tsx`, `frontend/src/components/schedule/WeekView.tsx` | Часовые label и item positioning используют `settings.timezone` (не browser TZ); "Today" highlight через `todayInTZ(tz)` | SC301 |
| SC303 | pending | P0 | Timezone-aware TimelineView + sidebar + card | `frontend/src/components/schedule/TimelineView.tsx`, `frontend/src/components/schedule/ScheduleSidebar.tsx`, `frontend/src/components/schedule/ScheduleItemCard.tsx` | Time labels в TZ компании; sidebar показывает время в company TZ; card time label в company TZ | SC301 |
| SC304 | pending | P0 | Past-time overlay + now-line (DayView + WeekView) | `frontend/src/components/schedule/DayView.tsx`, `frontend/src/components/schedule/WeekView.tsx` | Серый overlay + красная now-line на today; no overlay на других днях; clamp to work hours | SC302 |
| SC305 | pending | P1 | Past-time overlay (TimelineView + TimelineWeekView) | `frontend/src/components/schedule/TimelineView.tsx`, `frontend/src/components/schedule/TimelineWeekView.tsx` | Past overlay на today-колонке TimelineView (горизонтальный); today highlight на TimelineWeekView | SC303 |
| SC306 | pending | P1 | Realtime SSE подписка для schedule | `frontend/src/hooks/useScheduleData.ts` | Hook подписан на onJobUpdate/onLeadUpdate/onTaskUpdate → debounced refresh (500ms); items обновляются при изменениях | - |
| SC307 | pending | P1 | Drag-and-drop reschedule (DayView + WeekView) | `frontend/src/components/schedule/DayView.tsx`, `frontend/src/components/schedule/WeekView.tsx`, `frontend/src/hooks/useScheduleData.ts` | Job/task draggable → drop на новый слот → snap-to-grid → API PATCH /reschedule → toast; leads не draggable; error → revert | SC302 |
| SC308 | pending | P1 | Drag-and-drop reschedule (TimelineView) | `frontend/src/components/schedule/TimelineView.tsx` | Горизонтальный drag по time axis → reschedule; snap-to-grid | SC303 |
| SC309 | pending | P1 | Drag-and-drop reassign (TimelineView + TimelineWeekView) | `frontend/src/components/schedule/TimelineView.tsx`, `frontend/src/components/schedule/TimelineWeekView.tsx`, `frontend/src/hooks/useScheduleData.ts` | Drag между provider rows → PATCH /reassign → toast; drag to Unassigned → assignee_id=null; leads → error toast | SC305 |
| SC310 | pending | P1 | Расширенные фильтры в ScheduleToolbar | `frontend/src/components/schedule/ScheduleToolbar.tsx`, `frontend/src/hooks/useScheduleData.ts`, `frontend/src/services/scheduleApi.ts` | Status multi-select, job_type, source, tags фильтры; localStorage persistence; reset button | - |
| SC311 | pending | P2 | DispatchSettingsDialog | `frontend/src/components/schedule/DispatchSettingsDialog.tsx` (новый), `frontend/src/components/schedule/ScheduleToolbar.tsx` | Gear button → modal: timezone dropdown, work hours pickers, work days toggles, slot duration select; save → PATCH /settings → toast + views re-render | - |
| SC312 | pending | P2 | Create-from-slot (DayView + WeekView) | `frontend/src/components/schedule/DayView.tsx`, `frontend/src/components/schedule/WeekView.tsx` | Click empty slot → context menu → "Create Task" → inline form → POST /from-slot; lead/job → открывает CreateLeadJobWizard | SC302 |
