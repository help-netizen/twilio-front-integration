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
