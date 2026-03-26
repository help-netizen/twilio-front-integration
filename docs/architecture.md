# Архитектура — Blanc Contact Center

## Обзор

Blanc Contact Center уже не является одним integration server. Фактически это hybrid-система из:

- `src/` — runtime shell и legacy adapter layer
- `backend/src/` — основной backend приложения
- `frontend/src/` — основной React frontend
- `voice-agent/` — отдельный конфигурационный и runtime контур AI/voice flows

```text
[Twilio / Front / Zenbooker / Google / Gemini / Vapi]
                     ↕
          [src/server.js runtime shell]
             ↕ auth / routing / SSE / static
      [backend/src application modules] ↔ [PostgreSQL]
             ↕
       [backend/src/services/realtimeService]
             ↕
        [frontend/src React application]
```

## Фактическая структура проекта

### Runtime и composition root

- `src/server.js` — фактический composition root.
- В одном месте совмещает route wiring, auth/tenant middleware, media proxy, static serving, SSE endpoint и запуск worker.
- `src/routes/*` и `src/services/*` — legacy Twilio/Front integration слой. Он больше не отражает полную CRM-архитектуру и не должен быть местом для новой бизнес-логики.

### Backend

#### HTTP boundary

- `backend/src/routes/calls.js`, `pulse.js`, `messaging.js`, `voice.js`, `webhooks.js` — communications surface.
- `backend/src/routes/contacts.js`, `leads.js`, `jobs.js` — CRM surface.
- `backend/src/routes/users.js`, `sessions.js`, `lead-form-settings.js`, `job-tags-settings.js`, `notification-settings.js`, `push-subscriptions.js` — settings/admin surface.
- `backend/src/routes/userGroups.js`, `callFlows.js`, `phoneNumbers.js`, `telephonyOverview.js`, `vapi.js` — telephony admin surface.

#### Application services

- `backend/src/services/leadsService.js`, `jobsService.js`, `contactsService.js` — основной CRM service layer.
- `backend/src/services/conversationsService.js`, `contactDedupeService.js`, `timelineMergeService.js`, `stateMachine.js` — communications/domain services.
- `backend/src/services/voiceService.js`, `zenbookerClient.js`, `zenbookerSyncService.js`, `textPolishService.js` — integration adapters.
- `backend/src/services/realtimeService.js`, `inboxWorker.js`, `reconcileService.js` — realtime/background processing.

#### Data access

- `backend/src/db/connection.js` — PostgreSQL pool.
- `backend/src/db/queries.js` — общий query-модуль, который сейчас играет роль god-module и требует декомпозиции по feature slices.
- `backend/db/` — schema и migrations. Это protected зона, менять только отдельными задачами.

### Frontend

- `frontend/src/App.tsx` — route map приложения.
- `frontend/src/pages/` — page composition.
- `frontend/src/components/` — feature/UI components.
- `frontend/src/hooks/` — feature state и realtime hooks.
- `frontend/src/services/` — frontend API layer.
- `frontend/src/auth/` — auth/session boundary.
- `frontend/src/components/ui/` — shared UI primitives.

### Supporting runtimes

- `voice-agent/` — конфигурации Twilio/Vapi routing и отдельные runtime handlers для voice-agent сценариев.

## Canonical boundaries

### Нужно расширять, а не дублировать

- `frontend/src/services/apiClient.ts` — canonical auth wrapper.
- `frontend/src/hooks/useRealtimeEvents.ts` — canonical realtime hook.
- `backend/src/services/realtimeService.js` — single source of truth для SSE broadcast.
- `backend/src/utils/phoneUtils.js` — canonical backend E.164 normalisation.
- `backend/src/services/voiceService.js`, `zenbookerClient.js`, `zenbookerSyncService.js`, `textPolishService.js` — integration adapters.

### Legacy boundary

- `src/services/frontAPI.js`, `src/services/jwtService.js`, `src/services/callFormatter.js` и `src/routes/*` — legacy adapter layer.
- Этот слой надо удерживать как адаптер к старым Twilio/Front сценариям, а не расширять CRM-логикой.

## Архитектурные seams и риски

### 1. Runtime tight coupling

- HTTP runtime, SSE и background worker запускаются из одного `src/server.js`.
- Это упрощает локальный запуск, но усиливает связанность и мешает scale-out worker/runtime path.

### 2. Boundary drift: route -> service -> db

- В части backend routes orchestration и SQL находятся прямо в route-слое.
- Одновременно часть логики уже живет в services.
- Результат: нет единообразной схемы вызова и трудно выделять безопасные refactor slices.

### 3. Feature overlap в communications domain

- Pulse, calls, conversations, messaging и action-required логика распределены между несколькими routes и services.
- Это самый рискованный домен для регрессий.

---

## PF102 Sprint 3: Tenant Team Management Architecture

В рамках перехода на полноценный Multi-Tenant RBAC (PF012), сервис управления пользователями компании (`backend/src/services/userService.js` и роутер `users.js`) перестраивается для поддержки:
1. Разделения `crm_users` (глобальный identity) и `company_memberships` (локальный доступ).
2. Замены legacy enum `role` на `role_key`, ссылающийся на `company_role_configs`.
3. Введения `company_user_profiles` для хранения локальных настроек сотрудника (дозвон, геолокация, цвет в расписании), которые ранее не имели места в схеме БД.

**Изменяемые файлы:**
- `backend/src/routes/users.js` (замена валидации ролей, обработка профилей)
- `backend/src/services/userService.js` (расширение SQL-запросов для поддержки profiles, invitations)
- `frontend/src/pages/CompanyUsersPage.tsx` (новый UI для `role_key` и настроек профиля)
- `frontend/src/pages/CompanyUserDialogs.tsx` (добавление полей Service Areas, Call Masking)

### 4. Frontend transport drift

- Параллельно используются `authedFetch`, несколько `axios.create()` и raw `fetch`.
- Error handling, auth policy и shared caching из-за этого не единообразны.

### 5. Shared config duplication

- Один и тот же endpoint `GET /api/settings/lead-form` вызывается из множества компонентов и хуков напрямую.
- Это признак отсутствия общего query/cache layer для shared settings.

### 6. UI duplication

- Логика аудиоплеера, summary/transcription и части call-item поведения реализованы в нескольких вариантах.
- Phone formatting и phone normalization размазаны по backend и frontend helper-слоям.

### 7. Test surface gap

- Root Jest покрывает только backend/legacy paths.
- Во `frontend/src` нет automated tests.
- Для безопасного рефакторинга этого недостаточно.

## Направления рефакторинга

### Приоритет 1. Зафиксировать фактическую архитектурную карту

- Сначала синхронизировать `requirements.md`, `architecture.md`, `project-spec.md`, `README.md` с реальным кодом.
- Все следующие задачи должны опираться на эту карту, а не на legacy-описания.

### Приоритет 2. Разрезать communications domain по feature boundaries

- Выделить явные slices: `Pulse / timeline`, `calls / media / transcripts`, `messaging`, `action required / tasks`

### Приоритет 3. Нормализовать backend flow

- Целевая схема: `route -> application service -> repository/query module -> integration adapter`

### Приоритет 4. Нормализовать frontend flow

- Целевая схема: `page/component -> hook -> domain API service -> apiClient`

### Приоритет 5. Убрать shared duplication

- Один transport layer.
- Один shared settings source.
- Один набор phone-formatting и phone-normalization contracts.
- Один shared audio/transcription component family.

## Protected areas

- `src/server.js` core middleware и runtime wiring.
- `frontend/src/services/apiClient.ts`.
- `frontend/src/hooks/useRealtimeEvents.ts`.
- `backend/db/` schema и migrations.
- Любые файлы, помеченные как `PROTECTED`.

## Refactor policy

- Никакого big-bang rewrite.
- Каждый refactor slice должен быть поведенчески нейтральным.
- Любое изменение protected zones — только отдельной задачей.
- Новые helper-функции для auth, phones, realtime и timeline state запрещены, если уже есть canonical реализация.
