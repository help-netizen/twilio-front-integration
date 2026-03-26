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
