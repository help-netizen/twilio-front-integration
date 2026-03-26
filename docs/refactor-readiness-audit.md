# Refactor Readiness Audit

Дата аудита: `2026-03-24`

## Итог

Проект готов к поэтапному рефакторингу, но не готов к большому переписыванию. Главные блокеры перед первой волной изменений:

- документация и runtime-картина расходятся
- backend boundaries между routes/services/db размыты
- frontend использует несколько transport/data-access паттернов одновременно
- quality gates уже деградировали и не дают надежной регрессионной защиты
- automated frontend coverage отсутствует

## Baseline качества

| Проверка | Результат | Вывод |
|---|---|---|
| `npm test -- --runInBand` | `5` suites failed, `24` tests failed, `78` passed | Тестовый контур частично устарел и уже не совпадает с кодом |
| `frontend: npm run build` | Build проходит | Runtime baseline есть, но есть warning по чанкам и mixed import |
| `frontend: npm run lint` | `419` problems: `392` errors, `27` warnings | Frontend quality gate фактически красный |
| Frontend automated tests | Не найдены | Рефакторинг UI сейчас почти без safety net |

### Падающие test suites

- `tests/keycloakAuth.test.js`
- `tests/paymentsRoute.test.js`
- `tests/inboxWorker.test.js`
- `tests/stateMachine.test.js`
- `tests/twilioWebhooks.test.js`

## Фактическая топология

### Runtime shell

- `src/server.js` — composition root, где одновременно живут route wiring, auth, SSE, media proxy, static serving и boot background worker.

### Основной backend

- `backend/src/routes/*` — основной HTTP surface.
- `backend/src/services/*` — business logic, integrations, realtime/background.
- `backend/src/db/*` и `backend/db/*` — data access и migrations.

### Основной frontend

- `frontend/src/*` — React/TypeScript приложение.
- Отдельный `frontend/package.json`, отдельная сборка, но production runtime обслуживается через root server.

### Legacy layer

- `src/services/frontAPI.js`, `src/services/jwtService.js`, `src/services/callFormatter.js` и `src/routes/*` остались как legacy adapter boundary.
- Документация по-прежнему описывает этот слой как основной, хотя фактический runtime давно сместился в `backend/src/*` и `frontend/src/*`.

## Ключевые находки

| ID | Severity | Находка | Доказательства |
|---|---|---|---|
| A01 | High | `Docs vs code` drift | `docs/requirements.md` и `README.md` указывают на `src/routes/webhooks.js` и старую структуру, тогда как `src/server.js` монтирует `backend/src/routes/webhooks`; `docs/architecture.md` ссылался на `frontend/src/lib/authedFetch.ts`, а фактически используется `frontend/src/services/apiClient.ts`; в `frontend/package.json` уже React Router `7`, а docs описывали v6 |
| A02 | High | Размыты backend boundaries | В `backend/src/routes/*` много прямого `db.query`, при этом параллельно уже существует service layer; `backend/src/db/queries.js` разросся до `1107` строк |
| A03 | High | Runtime tightly coupled | `src/server.js` запускает `backend/src/services/inboxWorker.js` в том же процессе ради общего `realtimeService` singleton |
| A04 | High | Frontend data/transport layer фрагментирован | Используются `frontend/src/services/apiClient.ts`, отдельные axios-клиенты в `frontend/src/services/api.ts` и `pulseApi.ts`, плюс raw `fetch` в `frontend/src/pages/SuperAdminPage.tsx` |
| A05 | Medium | Shared config запрашивается повторно | `GET /api/settings/lead-form` вызывается из многих pages/components/hooks вместо одного shared source |
| A06 | Medium | Есть UI duplication | `frontend/src/components/CallAudioPlayer.tsx` и `frontend/src/components/pulse/PulseCallAudioPlayer.tsx` реализуют почти одну и ту же audio/transcription логику |
| A07 | Medium | Phone formatting и normalization раздроблены | Телефонные helper'ы размазаны между `frontend/src/lib/formatPhone.ts`, `frontend/src/utils/formatters.ts`, `frontend/src/utils/phoneUtils.ts`, локальными helpers и backend форматтерами |
| A08 | Medium | Test architecture drift | Часть Jest тестов проверяет старые контракты и старые пути; frontend automated tests отсутствуют полностью |
| A09 | Medium | Build/perf risk | Frontend build дает warning по mixed import `jobsApi.ts` и chunk размеру `3094.07 kB` |
| A10 | Low | Repo hygiene debt | В репозитории лежат `.DS_Store`, `backend/src/services/callProcessor.js.bak2`, `callProcessor.js.bak3` |

## Подтвержденные примеры

### Backend

- `backend/src/routes/pulse.js`, `backend/src/routes/calls.js`, `backend/src/routes/leads.js`, `backend/src/routes/vapi.js` совмещают HTTP, orchestration и SQL.
- `backend/src/services/inboxWorker.js`, `backend/src/services/leadsService.js`, `backend/src/services/jobsService.js` и `backend/src/routes/calls.js` уже достаточно крупные, чтобы дробить их только по explicit slices.

### Frontend

- Повторные запросы `lead-form` settings идут минимум из:
- `frontend/src/pages/LeadFormSettingsPage.tsx`
- `frontend/src/pages/LeadsPage.tsx`
- `frontend/src/components/leads/CreateLeadDialog.tsx`
- `frontend/src/components/leads/EditLeadDialog.tsx`
- `frontend/src/components/leads/LeadDetailSections.tsx`
- `frontend/src/components/jobs/JobsFilters.tsx`
- `frontend/src/components/jobs/JobMetadataSection.tsx`
- `frontend/src/components/conversations/CreateLeadJobWizard.tsx`
- `frontend/src/hooks/useJobsData.ts`
- `frontend/src/hooks/useQuickMessages.ts`

- Lint baseline красный не точечно, а системно: `no-explicit-any`, `react-hooks/set-state-in-effect`, `react-refresh/only-export-components`, `react-hooks/preserve-manual-memoization`, missing deps.

## Что это значит для рефакторинга

### Нельзя делать в первой волне

- big-bang rewrite backend или frontend
- миграцию protected зон без отдельной задачи
- одновременный refactor communications domain, transport layer и telephony admin

### Можно делать безопасно

- синхронизацию документации с фактической структурой
- фиксацию quality baseline и классификацию текущих падений
- выравнивание transport layer и shared settings access на frontend
- вынос shared audio/transcription contracts
- поэтапное разделение route/service/db boundary на backend

## Рекомендуемые refactor slices

| Slice | Приоритет | Область | Цель |
|---|---|---|---|
| RF001 | P0 | Docs sync | Привести `requirements/architecture/project-spec/README` к фактической структуре |
| RF002 | P0 | Quality baseline | Стабилизировать и классифицировать падающие Jest suites, build и lint baseline |
| RF003 | P1 | Frontend transport | Свести API access к одному canonical path поверх `apiClient.ts` |
| RF004 | P1 | Shared settings | Убрать repeated `lead-form` fetches через shared hook/query cache |
| RF005 | P1 | Communications backend | Разделить `pulse/calls/messaging` по application boundaries без смены контрактов |
| RF006 | P2 | Shared UI/domain helpers | Консолидировать audio/transcription и phone helper surface |
| RF007 | P2 | Telephony admin | Изолировать telephony pages от ad-hoc state и raw fetch patterns |
| RF008 | P2 | Runtime/worker plan | Подготовить отделение worker lifecycle от web runtime без ломки SSE |

## Protected зоны

- `src/server.js` core middleware и runtime wiring
- `frontend/src/services/apiClient.ts`
- `frontend/src/hooks/useRealtimeEvents.ts`
- `backend/db/` schema и migrations

## Вывод

Первая цель не "почистить код", а вернуть проекту управляемую форму. После этого можно начинать refactor slices с ясными границами и с минимальным риском регрессий.
