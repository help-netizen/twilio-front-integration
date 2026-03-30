# Требования — Blanc Contact Center

## Статус фич

| ID | Фича | Статус | Расположение |
|---|---|---|---|
| F001 | Pulse (Timeline + SMS + Call Log) | ✅ Реализована | `frontend/src/pages/PulsePage.tsx`, `frontend/src/components/pulse/`, `backend/src/routes/pulse.js`, `backend/src/routes/calls.js`, `backend/src/routes/messaging.js` |
| F002 | Softphone (Twilio Device SDK) | ✅ Реализована | `frontend/src/components/softphone/`, `frontend/src/contexts/SoftPhoneContext.tsx`, `backend/src/routes/voice.js` |
| F003 | Contacts (Master List + Detail) | ✅ Реализована | `frontend/src/pages/ContactsPage.tsx`, `frontend/src/components/contacts/`, `backend/src/routes/contacts.js` |
| F004 | Leads (Фильтры + Таблица + Detail) | ✅ Реализована | `frontend/src/pages/LeadsPage.tsx`, `frontend/src/components/leads/`, `backend/src/routes/leads.js` |
| F005 | Jobs (Zenbooker + Таблица + Detail) | ✅ Реализована | `frontend/src/pages/JobsPage.tsx`, `frontend/src/components/jobs/`, `backend/src/routes/jobs.js`, `backend/src/routes/zenbooker/jobs.js` |
| F006 | Real-time (SSE + WebSocket) | ✅ Реализована | `src/server.js`, `backend/src/routes/events.js`, `backend/src/services/realtimeService.js`, `frontend/src/hooks/useRealtimeEvents.ts` |
| F007 | Twilio-Front интеграция (Channel API) | ✅ Реализована | `src/services/frontAPI.js`, `src/services/jwtService.js`, `src/services/callFormatter.js` |
| F008 | Zenbooker интеграция | ✅ Реализована | `backend/src/routes/zenbooker.js`, `backend/src/routes/integrations-zenbooker.js`, `backend/src/services/zenbookerClient.js`, `backend/src/services/zenbookerSyncService.js` |
| F009 | Action Required / Snooze система | ✅ Реализована | `frontend/src/components/pulse/`, `backend/src/routes/pulse.js`, `backend/src/services/` |
| F010 | AI функции (Summary, Polish, Transcript) | ✅ Реализована | `backend/src/`, Gemini API |
| F011 | Refactor-readiness audit | ⏳ Запланирована | `docs/`, `src/server.js`, `backend/src/`, `frontend/src/`, `tests/` |
| F012 | Multi-tenant company model, Super Admin & RBAC | ⏳ Запланирована | `docs/specs/PF007-multitenant-company-model-rbac.md`, `docs/specs/PF007-technical-design.md`, `docs/specs/PF102-tenancy-rbac-sprint-plan.md`, `docs/specs/PF103-tenancy-rbac-db-api-contracts.md` |
| F013 | Schedule / Dispatcher MVP + UX hardening | 🔧 В разработке (Sprint 2 ✅, Sprint 3 ✅) | `frontend/src/pages/SchedulePage.tsx`, `frontend/src/components/schedule/`, `frontend/src/hooks/useScheduleData.ts`, `frontend/src/services/scheduleApi.ts`, `backend/src/routes/schedule.js`, `backend/src/services/scheduleService.js`, `backend/src/db/scheduleQueries.js`, `docs/specs/PF001-unified-schedule-dispatcher.md` |

---

## Подробные требования

> Подробное описание текущего функционала см. в `docs/current_functionality.md`

### F001: Pulse
- Трёхколоночный layout: список контактов → карточка → хронология
- Server-side поиск по номеру, infinite scroll
- Объединённая хронология звонков + SMS
- Если по thread нет готового `Lead` или `Contact`, в middle-column открывается `CreateLeadJobWizard` для создания лида/работы прямо из текущего conversation context
- Аудиоплеер с записями, транскрипция, AI-summary
- Voicemail уже отображается в текущем `Pulse` timeline как call-item (`voicemail_recording` / `voicemail_left`) и использует тот же recording/transcript pipeline
- SMS форма с Quick Messages, AI Polish, вложения
- Real-time через SSE: onCallUpdate, onMessageAdded, etc.
- `Pulse` является canonical client timeline и основным operator workspace по клиенту: все high-value client events должны быть доступны в его timeline, а не в отдельных activity feeds других модулей
- `Messaging`, `Phone Ops`, `Voicemail`, future `Email`, `Call Tracking` и `AI communication` должны рассматриваться как развитие `Pulse`, его timeline items, queue-state и middle-card controls, а не как отдельные конкурирующие рабочие пространства
- `Action Required / Snooze / Tasks` остаются отдельными operator controls и queue-signals вне timeline; при просмотре клиента они должны быть доступны в left queue и middle-card/navigation area, а их lifecycle может дополнительно отражаться в timeline как события
- SSE/event-delivery machine документируется вместе с Pulse, даже если часть событий обновляет не только сам Pulse, но и bubbles, leads, jobs, payments и другие экраны
- Любая новая клиентская фича, которая добавляет significant event или новый realtime update на фронт, обязана описывать Pulse/SSE integration и обновлять пакет `PF008`
- Следующий communication gap для `Pulse` — email внутри текущего timeline/thread model, а не новый отдельный message center
- Стратегическое развитие `Pulse` как communication/event core описано в `docs/specs/PF008-pulse-client-timeline-core.md`, `docs/specs/PF104-pulse-sprint-plan.md`, `docs/specs/PF105-pulse-db-api-contracts.md`, `docs/specs/PF008-technical-design.md`

### F002: Softphone
- VoIP на базе Twilio Device SDK
- Состояния: Idle → Incoming → Connecting → Ringing → Connected → Ended
- Caller ID picker, поиск контактов, pre-flight busy check
- Minimize в header, DTMF keypad, Mute/Unmute
- ClickToCallButton интеграция
- `Softphone` и будущие phone-ops улучшения должны оставаться связанными с `Pulse` thread/timeline model, а не становиться отдельным операторским history surface

### F003: Contacts
- Master list с поиском и pagination
- Детальная панель: контактная информация, адреса (geocoding), лиды, jobs
- Edit Contact dialog
- Zenbooker sync

### F004: Leads
- Фильтры: текст, дата, статус, источник, тип
- Таблица с настраиваемыми колонками
- Детальная панель: header, actions, metadata
- Create Lead dialog (многоступенчатая форма)
- Convert to Job (4-step wizard → Zenbooker)

### F005: Jobs
- Фильтры: текст, дата, статус, провайдер, источник, тип, теги
- Таблица с сортировкой, pagination, CSV export
- Двухколоночная детальная панель
- Action Bar: Mark Enroute/In Progress/Complete/Cancel
- Notes секция

### F011: Refactor-readiness audit
- Цель: подготовить проект к поэтапному рефакторингу без изменения пользовательского поведения
- Артефакты: audit report, обновлённые docs, спецификация и тест-кейсы для refactor slices
- Обязательные результаты: карта расхождений `docs vs code`, список архитектурного долга и дублей, baseline по тестам/сборке/lint и refactor backlog с независимыми slices
- Ограничения: не менять protected runtime paths без отдельной задачи; не делать big-bang rewrite; не создавать новые параллельные реализации существующих auth/realtime/phone helper paths
- Затронутые области: `src/server.js`, `backend/src/routes/*`, `backend/src/services/*`, `backend/src/db/*`, `frontend/src/pages/*`, `frontend/src/components/*`, `frontend/src/hooks/*`, `frontend/src/services/*`, `tests/*`, `docs/*`

### F012: Multi-tenant company model, Super Admin & RBAC
- `Keycloak` остаётся canonical identity provider и session/authentication слоем; tenant authorization, фиксированные системные роли, матрицы прав по ролям, user-level permission overrides и permission scopes становятся responsibility приложения и его БД.
- `super_admin` становится platform-only ролью и не должен иметь доступа к данным tenant-компаний, их `Jobs / Leads / Contacts / Pulse / Payments / Settings` и не должен обходить `company_id`-изоляцию через пустой `companyFilter`.
- Платформа должна поддерживать несколько tenant-компаний через существующий `companies` контур, но без franchise/sub-account модели и без impersonation/jump-into-tenant сценариев.
- Для каждой активной tenant-компании должен существовать минимум один активный tenant-admin; создание компании и первого пользователя должно быть атомарным, а первый пользователь компании всегда получает tenant-admin доступ.
- Текущий экран `Company Users` должен быть расширен до полноценного `Team Management`, а `Super Admin` — до platform admin workspace; greenfield-параллельные user-management экраны создавать нельзя.
- Система ролей должна опираться на Workiz-подобную модель без `Subcontractors` и `Franchises`, но механика настройки должна быть ближе к Zenbooker: фиксированные системные роли `Tenant Admin`, `Manager`, `Dispatcher`, `Provider`, для которых tenant-admin настраивает матрицу прав внутри компании без создания custom roles.
- Изменять матрицу прав ролей и дополнительные permission toggles в профиле конкретного сотрудника может только tenant-admin; `Manager` и другие роли не должны управлять role governance.
- Матрица прав должна покрывать текущие продуктовые модули: `Pulse`, `Messages`, `Contacts`, `Leads`, `Jobs`, `Payments`, `Providers`, `Quick Messages`, `Lead Form`, `Action Required`, `Telephony`, `Integrations`, `Super Admin`, а также будущие `Schedule / Estimates / Invoices / Client Portal / Automation Engine`.
- Должны поддерживаться advanced restrictions в духе Workiz, но встроенные в текущий продукт: `assigned jobs only`, `financial data hidden`, `dashboard/report visibility`, `close jobs`, `collect payments`, `client job history`, `phone access`, `provider status`, `schedule color`, `call masking`, `GPS/location tracking`, `service areas`, `job types/skills`.
- Ограничения на видимость и действия должны применяться не только в UI, но и на backend: списки, detail pages, search, exports, SMS/thread access, phone operations, audit, webhook side effects и realtime payloads.
- Текущие глобальные роли `company_admin` / `company_member` и `ProtectedRoute roles=[...]` должны рассматриваться как migration compatibility слой, а не как конечная authorization model.
- Потенциально вовлечённые модули/части системы:
  - `backend/src/middleware/keycloakAuth.js`, `backend/src/routes/users.js`, `backend/src/services/userService.js`, `backend/src/services/auditService.js`
  - `backend/db/migrations/*`, `backend/src/db/*`
  - `frontend/src/auth/*`, `frontend/src/App.tsx`, `frontend/src/pages/CompanyUsersPage.tsx`, `frontend/src/pages/SuperAdminPage.tsx`, `frontend/src/components/layout/*`
  - все tenant-scoped routes/services/pages, использующие `company_id`
- Защищённые части кода:
  - `src/server.js` runtime wiring
  - `frontend/src/services/apiClient.ts`
  - `frontend/src/hooks/useRealtimeEvents.ts`
  - `backend/db/` schema и migrations менять только по выделенному rollout-плану
  - legacy `src/routes/*` и `src/services/*` не превращать в новый RBAC/business layer

---

## Общие паттерны

- **Аутентификация:** authedFetch + auth headers
- **Real-time:** SSE через useRealtimeEvents hook
- **UI:** Shadcn/ui, Lucide React icons
- **Timezone:** America/New_York
- **Data fetching:** смешанный слой (`React Query`, `authedFetch`, `axios`) — требует унификации
- **Toasts:** sonner

---

### F012 Sprint 3: Tenant Team Management MVP
- **Цель:** Превратить текущий список `Company Users` в полноценный интерфейс управления командой (tenant admin).
- **Сценарии использования:**
  - Admin (Tenant) просматривает список всех сотрудников компании с фильтрацией (по статусу, роли).
  - Admin может пригласить нового пользователя (Email, Role, First Name). Если пользователь уже есть в Keycloak - он привязывается, если нет - создается профиль с Action Email.
  - Admin может деактивировать/активировать сотрудника с указанием причины (например `left_company`).
  - Admin может изменить роль сотруднику (только из фиксированных системных `tenant_admin`, `manager`, `dispatcher`, `provider`).
  - Admin управляет профилем сотрудника: включает/выключает Service Areas, Skills/Job Types, Phone Call Masking, Location Tracking.
  - Обязательно соблюдается ограничение: `check_last_admin` (нельзя удалить последнего `tenant_admin`).
- **Зависимости:** `req.authz` middleware из Sprint 1, контракты таблиц из `PF103`.

### F013: Schedule / Dispatcher MVP + UX hardening
<<<<<<< Updated upstream

**Краткое описание:** Единое диспетчерское расписание поверх существующих jobs/leads/tasks — без отдельной schedule entity table. Объединяет read-модель через UNION ALL, 5 видов календаря, sidebar quick-view, dispatch settings. UX hardening: timezone-awareness, past-time overlay, interactive reschedule/reassign, realtime refresh, расширенные фильтры.

**Принципы:**
- Schedule — это **planning/dispatch surface**, НЕ замена Pulse как canonical operator workspace
- Нет отдельной таблицы `schedule_items` — агрегационный слой поверх `jobs`, `leads`, `tasks`
- Client-significant dispatch events (reschedule, reassign) должны публиковаться в Pulse timeline по правилам PF008
- Timezone: все отображения времени и расчёты дат используют `company.timezone` из `dispatch_settings`, а не timezone браузера

#### Реализовано (Sprint 1 + Sprint 2):

**Backend:**
- `dispatch_settings` table — company-level конфигурация: timezone, work_start_time, work_end_time, work_days, slot_duration, buffer_minutes, settings_json
- `scheduleQueries.js` — unified UNION ALL query по jobs/leads/tasks с динамическими фильтрами (date range, entity types, statuses, assignee, search, pagination)
- `scheduleService.js` — service layer: getScheduleItems, rescheduleItem, reassignItem, createFromSlot (task), dispatch settings CRUD
- `schedule.js` — route handlers для всех endpoints (кроме /availability — 501)
- Data isolation: все запросы фильтруют по `company_id` через `req.companyFilter?.company_id`

**Frontend:**
- `SchedulePage.tsx` — layout: toolbar + calendar view + unscheduled panel + sidebar
- `useScheduleData.ts` — central state hook (items, settings, viewMode, filters, selectedItem)
- `scheduleApi.ts` — API client для всех schedule endpoints
- 5 видов календаря: DayView, WeekView, MonthView, TimelineView, TimelineWeekView
- `ScheduleToolbar.tsx` — вкладки видов, навигация по датам, поиск, фильтр по entity type
- `ScheduleItemCard.tsx` — цветовая кодировка (blue=job, amber=lead, green=task, gray-dashed=unassigned)
- `ScheduleSidebar.tsx` — quick-view panel: контакт, адрес, статус, techs, deeplinks
- `UnscheduledPanel.tsx` — collapsible panel для items без start_at
- Навигация: `/schedule` в main nav между Jobs и Contacts

**Баги зафиксированные (hotfix 2026-03-29):**
- `req.companyId` → `req.companyFilter?.company_id` (7 мест в schedule.js) — расписание было пустое из-за undefined company filter
- `start_date <= endDate` → `start_date < (endDate::date + INTERVAL '1 day')` — TIMESTAMPTZ vs date truncation терял весь день

#### Sprint 3: UX hardening + interactive dispatch (PENDING)

**Пользовательские сценарии:**

1. **Timezone-aware отображение**
   - Все времена в календаре отображаются в `company.timezone` из `dispatch_settings`, а не в timezone браузера
   - Метки часов, sidebar time display, date picker, "Today" highlight — всё в company timezone
   - Если dispatch_settings.timezone не настроен — дефолт `America/New_York`
   - При смене timezone в настройках — весь UI переключается мгновенно

2. **Past-time visual indicator**
   - В DayView и WeekView: серый overlay поверх прошедших часов текущего дня (аналогично CustomTimeModal)
   - Красная горизонтальная линия "сейчас" (now-line) на текущем времени
   - В TimelineView и TimelineWeekView: аналогичный past overlay на today-колонке
   - Прошлые items не блокируются для выбора, только визуально отмечены

3. **Drag-and-drop reschedule**
   - Пользователь перетаскивает карточку job/task на другой временной слот → API `PATCH /reschedule`
   - Snap-to-grid: привязка к slot_duration (по умолчанию 60 мин)
   - Visual preview во время перетаскивания (ghost card)
   - Toast confirmation: "Job #123 rescheduled to Mar 30, 2:00 PM"
   - Leads НЕ поддерживают reschedule (lead_date_time — read-only из формы)

4. **Drag-and-drop reassign (Timeline views)**
   - В TimelineView/TimelineWeekView: перетаскивание карточки между строками провайдеров → API `PATCH /reassign`
   - Toast: "Job #123 reassigned to John Smith"
   - Leads НЕ поддерживают reassign (нет assigned_provider_id в схеме)
   - Tasks поддерживают reassign через `assigned_provider_id`

5. **Расширенные фильтры**
   - Multi-select по статусам (job statuses: new, scheduled, en_route, in_progress, completed; lead statuses: new, contacted, qualified)
   - Фильтр по job_type (тип работы)
   - Фильтр по source (источник)
   - Фильтр по tags (теги)
   - Фильтр по action_required (только items с непросмотренными действиями)
   - Сохранение фильтров в localStorage

6. **Realtime updates**
   - SSE подписка на события: `onJobUpdate`, `onLeadUpdate`, `onTaskUpdate`
   - При изменении job/lead/task — auto-refresh списка items
   - При reschedule/reassign другим оператором — обновление позиции карточки без перезагрузки

7. **Settings UI**
   - Модальное окно или sidebar для редактирования dispatch_settings:
     - Timezone (dropdown из списка IANA timezones)
     - Business hours: work_start_time, work_end_time (time pickers)
     - Work days: чекбоксы Mon-Sun
     - Slot duration: 15 / 30 / 60 / 90 / 120 min
     - Buffer between jobs: 0 / 15 / 30 / 60 min
   - Только для пользователей с ролью admin/dispatcher

8. **Create-from-slot (расширение)**
   - Click на пустой слот в любом view → контекстное меню: "Create Task" / "Create Lead" / "Create Job"
   - Task: создаётся сразу с start_at/end_at из слота + assigned_provider (если timeline view)
   - Lead/Job: открывает существующий CreateLeadJobWizard с предзаполненным временем

**Ограничения и нефункциональные требования:**
- Schedule НЕ дублирует Pulse timeline — это planning surface, не event history
- Максимум 500 items на один запрос (pagination)
- Drag-and-drop работает только в Day/Week/Timeline/Timeline Week (не Month — month слишком компактный)
- Reschedule/reassign логируются в domain_events для audit trail
- Нет отдельного `schedule_items` — read model поверх jobs/leads/tasks
- При конфликте (два job на одного провайдера в одно время) — визуальное предупреждение (overlap indicator), но НЕ блокировка

**Потенциально вовлечённые модули/части системы:**
- `backend/src/routes/schedule.js` — route handlers
- `backend/src/services/scheduleService.js` — business logic
- `backend/src/db/scheduleQueries.js` — SQL queries
- `backend/src/services/realtimeService.js` — SSE broadcast для schedule events
- `frontend/src/pages/SchedulePage.tsx` — page composition
- `frontend/src/hooks/useScheduleData.ts` — state management
- `frontend/src/services/scheduleApi.ts` — API client
- `frontend/src/components/schedule/*` — все view-компоненты
- `frontend/src/utils/companyTime.ts` — timezone utilities (shared с CustomTimeModal)

**Затронутые интеграции:**
- Zenbooker — reschedule job может потребовать sync с ZB (если job синхронизирован)
- SSE/Realtime — новые event types для schedule mutations

**Защищённые части кода (НЕЛЬЗЯ ломать):**
- `src/server.js` core middleware и SSE infrastructure
- `frontend/src/lib/authedFetch.ts`
- `frontend/src/hooks/useRealtimeEvents.ts`
- `backend/db/` schema — не менять без отдельной миграции
- Pulse timeline и его event model — schedule публикует события в Pulse, но не модифицирует его
- CustomTimeModal.tsx — уже реализованный timezone-aware timeslot picker; его паттерны (dateInTZ, todayInTZ, past-time overlay) переиспользуются, но сам компонент не меняется

**Зависимости:**
- `dispatch_settings` table (миграция 051, уже в production)
- `company.timezone` — доступен через `useAuth().company.timezone` на фронтенде
- `frontend/src/utils/companyTime.ts` — утилиты dateInTZ, todayInTZ (уже реализованы)
- `req.companyFilter?.company_id` middleware — уже настроен для `/api/schedule`
=======
- **Текущее состояние:** `/schedule` уже запущен как MVP dispatch/planning surface с представлениями `Day / Week / Month / Timeline / TL Week`, quick-view sidebar, unified read model и фильтрами по типу сущности/назначению/поиску.
- **Подтверждённые UX-проблемы из аудита 2026-03-29 (`https://abc-metrics.fly.dev/schedule`):**
  - В `Week` и `Day` item container учитывает `end_at`, но сама визуальная карточка события не растягивается на всю длительность; 120-минутные работы выглядят как однострочные бейджи.
  - Коллизии не раскладываются по lanes: три работы `2026-03-30 9:00–11:00 ET` и пересекающаяся работа `10:00–12:00 ET` рендерятся поверх друг друга в одной колонке.
  - При первом заходе рабочий экран перекрывается нецелевыми overlay: модалкой `SoftPhone Ready` и нижним баннером про заблокированные notifications.
  - В weekly navigation заголовок показывает только `Mar 2026`, без явного диапазона текущей недели; при перелистывании это ухудшает ориентацию во времени.
  - На карточках в grid почти не читаются operational states: `Canceled`, `Submitted`, `Rescheduled`, assigned/unassigned и multi-assignee не различаются достаточно явно до открытия sidebar.
  - Dispatch timezone пока не зафиксирован на уровне UI-state и рендера как `America/New_York`; schedule logic не должна зависеть от locale/timezone браузера пользователя.
- **Как должно быть:**
  - Календарные карточки должны визуально соответствовать реальной длительности интервала и занимать весь доступный vertical/horizontal slot в зависимости от view.
  - Пересекающиеся items должны автоматически раскладываться по параллельным подколонкам без взаимного перекрытия, с сохранением кликабельности и читаемости.
  - Первичный вход в `/schedule` не должен блокироваться softphone/notification onboarding; такие prompts должны быть неблокирующими и контекстно-подходящими.
  - Week/day views должны давать диспетчеру мгновенное понимание диапазона дат, статуса работы, назначения и конфликтов без обязательного открытия sidebar.
  - Все time calculations, filters и visual anchors должны быть согласованы с company dispatch timezone `America/New_York`.
- **Пользовательские сценарии:**
  - Диспетчер открывает неделю и сразу понимает фактическую загрузку команды по длительности слотов, а не по списку однострочных бейджей.
  - Диспетчер видит одновременные работы без наложения и понимает, у кого конфликт по времени.
  - Оператор заходит в `/schedule` из Jobs/Pulse и может сразу работать с календарём без принудительного закрытия нерелевантных модалок.
  - Пользователь различает `Canceled / Submitted / Rescheduled / Unassigned` прямо в grid, не открывая каждую карточку отдельно.
  - Пользователь в любом view видит корректную временную привязку недели и дня в `America/New_York`.
- **Ограничения и нефункциональные требования:**
  - Не создавать отдельную `schedule_items` business table и не дублировать domain model поверх `jobs / leads / tasks`.
  - Не ломать `Pulse-first` модель: dispatch-события остаются частью общего event/realtime контура.
  - Не расширять protected runtime/auth/realtime paths без отдельной задачи: `src/server.js`, `frontend/src/services/apiClient.ts`, `frontend/src/hooks/useRealtimeEvents.ts`, `backend/db/`.
  - UX hardening должен быть реализован как расширение существующего schedule surface, без нового параллельного dispatcher UI.
  - Решение должно оставаться пригодным для desktop-first operator workflow и не деградировать читаемость на узких экранах.
- **Потенциально вовлечённые модули/части системы:**
  - `frontend/src/pages/SchedulePage.tsx`
  - `frontend/src/components/schedule/WeekView.tsx`
  - `frontend/src/components/schedule/DayView.tsx`
  - `frontend/src/components/schedule/MonthView.tsx`
  - `frontend/src/components/schedule/TimelineView.tsx`
  - `frontend/src/components/schedule/TimelineWeekView.tsx`
  - `frontend/src/components/schedule/ScheduleItemCard.tsx`
  - `frontend/src/components/schedule/ScheduleToolbar.tsx`
  - `frontend/src/components/schedule/ScheduleSidebar.tsx`
  - `frontend/src/hooks/useScheduleData.ts`
  - `frontend/src/services/scheduleApi.ts`
  - `backend/src/routes/schedule.js`
  - `backend/src/services/scheduleService.js`
  - `backend/src/db/scheduleQueries.js`
- **Затронутые интеграции:**
  - `Twilio / SoftPhone` — только в части non-blocking onboarding внутри schedule workflow.
  - `Zenbooker` — косвенно, так как provider/job scheduling data уже агрегируется в schedule read model.
  - `Pulse / SSE` — для сохранения общей event model при reschedule/reassign UX.
>>>>>>> Stashed changes
