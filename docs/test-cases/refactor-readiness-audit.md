# Тест-кейсы: F011 Refactor-Readiness Audit

## Покрытие
- Всего тест-кейсов: 13
- P0: 4 | P1: 5 | P2: 3 | P3: 1
- Unit: 4 | Integration: 8 | E2E: 1

## Контекст
Инициатива `F011` не меняет пользовательское поведение. Ее цель - зафиксировать текущее состояние проекта, сформировать baseline для рефакторинга и не допустить скрытых регрессий при поэтапном упрощении архитектуры.

В текущем состоянии проекта baseline выглядит так:
- `npm test -- --runInBand` падает в `keycloakAuth`, `paymentsRoute`, `inboxWorker`, `stateMachine`, `twilioWebhooks`.
- `frontend` build проходит, но дает warning по `jobsApi.ts` и крупному чанку порядка 3 MB.
- `frontend` lint падает массово: 419 problems, из них 392 errors и 27 warnings.
- В `docs/specs/` и `docs/test-cases/` нет содержимого кроме `.gitkeep`, поэтому первый проход должен создать опорные артефакты для дальнейшего аудита.

---

### TC-F011-001: Документы соответствуют реальной структуре репозитория
- **Приоритет:** P0
- **Тип:** Integration
- **Связанный сценарий:** Audit artefacts -> синхронизация `requirements.md`, `architecture.md`, `README.md` и фактических путей коду
- **Предусловия:** Доступен текущий checkout проекта
- **Входные данные:** Снимок `docs/requirements.md`, `docs/architecture.md`, `docs/project-spec.md`, `docs/changelog.md`, `docs/current_functionality.md`
- **Моки:** Не требуются; используется файловая структура репозитория
- **Шаги:**
  1. Сверить перечисленные в документах пути с фактическими `src/`, `backend/src/`, `frontend/src/`.
  2. Проверить, что legacy-слой и новый backend описаны без противоречий.
  3. Убедиться, что protected paths отмечены явно.
- **Ожидаемый результат:** Документы отражают реальную структуру проекта, не содержат только устаревшую monolith-картину и допускают поэтапный рефакторинг.
- **Файл для теста:** `docs/requirements.md`, `docs/architecture.md`, `docs/project-spec.md`

### TC-F011-002: Baseline backend test suite фиксирует текущие падения
- **Приоритет:** P0
- **Тип:** Integration
- **Связанный сценарий:** Regression baseline -> сохранить текущее состояние тестового контура до любых refactor-slice изменений
- **Предусловия:** Запуск `npm test -- --runInBand` в корне `twilio-front-integration`
- **Входные данные:** Полный backend Jest run
- **Моки:** Моки внешних сервисов не нужны; важен фиксированный результат suite
- **Шаги:**
  1. Запустить backend test suite.
  2. Зафиксировать набор упавших suites и количество passed/failed tests.
  3. Сопоставить падения с уже известными зонами риска.
- **Ожидаемый результат:** Текущий baseline стабильно воспроизводится, а именно видны падения в `keycloakAuth`, `paymentsRoute`, `inboxWorker`, `stateMachine`, `twilioWebhooks`.
- **Файл для теста:** `tests/keycloakAuth.test.js`, `tests/paymentsRoute.test.js`, `tests/inboxWorker.test.js`, `tests/stateMachine.test.js`, `tests/twilioWebhooks.test.js`

### TC-F011-003: Frontend build baseline остается проходящим
- **Приоритет:** P0
- **Тип:** Integration
- **Связанный сценарий:** Quality gate stabilization -> сборка фронта должна оставаться зеленой при рефакторинге
- **Предусловия:** Запуск `npm run build` в `frontend`
- **Входные данные:** Production build frontend
- **Моки:** Не требуются
- **Шаги:**
  1. Запустить production build.
  2. Проверить, что сборка завершилась успешно.
  3. Зафиксировать warning по bundle size и mixed import для `jobsApi.ts`.
- **Ожидаемый результат:** Build проходит без ошибок, warning по крупному чанку и `jobsApi.ts` остается задокументированным как baseline, а не silent regression.
- **Файл для теста:** `frontend/package.json`, `frontend/src/components/conversations/CreateLeadJobWizard.tsx`, `frontend/src/services/jobsApi.ts`

### TC-F011-004: Frontend lint baseline фиксируется перед рефакторингом
- **Приоритет:** P0
- **Тип:** Integration
- **Связанный сценарий:** Quality gate stabilization -> линт должен быть измеряемым и не ухудшаться при точечных изменениях
- **Предусловия:** Запуск `npm run lint` в `frontend`
- **Входные данные:** Полный lint run на текущем коде
- **Моки:** Не требуются
- **Шаги:**
  1. Запустить линт фронтенда.
  2. Зафиксировать общее число проблем и типы нарушений.
  3. Сравнить результат с baseline для последующих refactor-slice задач.
- **Ожидаемый результат:** Baseline остается воспроизводимым: 419 problems, из них 392 errors и 27 warnings.
- **Файл для теста:** `frontend/src/**/*`

### TC-F011-005: Auth fallback не падает на `req.query` при отсутствии query object
- **Приоритет:** P1
- **Тип:** Unit
- **Связанный сценарий:** Safe refactor slice -> `keycloakAuth.authenticate` должен безопасно обрабатывать browser-native запросы и отсутствие query
- **Предусловия:** Тестируется `backend/src/middleware/keycloakAuth.js`
- **Входные данные:** `req.headers.authorization = undefined`, `req.query = undefined`, `FEATURE_AUTH_ENABLED=true`
- **Моки:** JWT verification и `getKey` заглушены
- **Шаги:**
  1. Вызвать `authenticate` с `req.query = undefined`.
  2. Проверить, что middleware не кидает exception.
  3. Проверить ответ `401 AUTH_REQUIRED`.
- **Ожидаемый результат:** Отсутствие `req.query` не приводит к `TypeError`; middleware возвращает корректный auth error.
- **Файл для теста:** `tests/keycloakAuth.test.js`, `backend/src/middleware/keycloakAuth.js`

### TC-F011-006: Twilio webhook signature validation и dedupe работают предсказуемо
- **Приоритет:** P1
- **Тип:** Unit
- **Связанный сценарий:** Safe refactor slice -> `validateTwilioSignature` и `generateEventKey` не должны менять семантику webhook intake
- **Предусловия:** Тестируется `backend/src/webhooks/twilioWebhooks.js`
- **Входные данные:** Валидный и невалидный `x-twilio-signature`, payload с `CallSid`, `RecordingSid`, `TranscriptionSid`
- **Моки:** `twilio.validateRequest`, `queries.insertInboxEvent`
- **Шаги:**
  1. Проверить отказ при отсутствии signature/token.
  2. Проверить успешную валидацию валидного webhook.
  3. Проверить генерацию dedupe key для voice/recording/transcription событий.
- **Ожидаемый результат:** Невалидные запросы отклоняются, валидные попадают в inbox, dedupe key строится стабильно.
- **Файл для теста:** `tests/twilioWebhooks.test.js`, `backend/src/webhooks/twilioWebhooks.js`

### TC-F011-007: State machine сохраняет freeze-поведение для завершенных вызовов
- **Приоритет:** P1
- **Тип:** Unit
- **Связанный сценарий:** Safe refactor slice -> не сломать sync_state и cooldown логику
- **Предусловия:** Тестируется `backend/src/services/stateMachine.js`
- **Входные данные:** `currentState` с прошедшим `cooldown`, переход в `completed`
- **Моки:** `shouldFreeze` при необходимости подменяется
- **Шаги:**
  1. Выполнить `applyTransition` для финального статуса.
  2. Проверить `finalized_at`.
  3. Проверить `sync_state`.
- **Ожидаемый результат:** При выполнении freeze-условия `sync_state` становится `frozen`, иначе остается `active`.
- **Файл для теста:** `tests/stateMachine.test.js`, `backend/src/services/stateMachine.js`

### TC-F011-008: Inbox worker нормализует voice и recording events в canonical shape
- **Приоритет:** P1
- **Тип:** Unit
- **Связанный сценарий:** Safe refactor slice -> не сломать intake и нормализацию событий Twilio
- **Предусловия:** Тестируется `backend/src/services/inboxWorker.js`
- **Входные данные:** Twilio voice payload, Twilio recording payload, payload без optional полей
- **Моки:** `queries`, `db`, `CallProcessor`
- **Шаги:**
  1. Нормализовать voice event.
  2. Нормализовать recording event.
  3. Проверить default values для missing fields.
- **Ожидаемый результат:** Внутренний формат событий остается стабильным, а отсутствующие поля получают безопасные значения по умолчанию.
- **Файл для теста:** `tests/inboxWorker.test.js`, `backend/src/services/inboxWorker.js`

### TC-F011-009: Payments route не зависает и корректно отделяет валидацию от сервисной логики
- **Приоритет:** P1
- **Тип:** Integration
- **Связанный сценарий:** Safe refactor slice -> стабилизировать платежные endpoints без изменения контрактов
- **Предусловия:** Запуск `tests/paymentsRoute.test.js` с моками `paymentsService`
- **Входные данные:** Запросы `GET /`, `GET /:id`, `POST /sync`
- **Моки:** `listPayments`, `getPaymentDetail`, `syncPayments`
- **Шаги:**
  1. Проверить 400 на missing `date_from/date_to`.
  2. Проверить 404 на отсутствующий transaction.
  3. Проверить успешный sync без таймаута.
- **Ожидаемый результат:** Эндпоинты отдают предсказуемые статусы и не полагаются на небезопасный сетевой wrapper в тестах.
- **Файл для теста:** `tests/paymentsRoute.test.js`, `backend/src/routes/payments.js`

### TC-F011-010: Повторные запросы `lead-form` settings можно свести к одному источнику данных
- **Приоритет:** P2
- **Тип:** Integration
- **Связанный сценарий:** Safe refactor slice -> устранить repeated settings fetches без изменения UI
- **Предусловия:** Несколько потребителей данных `lead-form` смонтированы одновременно
- **Входные данные:** `CreateLeadDialog`, `EditLeadDialog`, `LeadDetailSections`, `JobsFilters`, `JobMetadataSection`
- **Моки:** `authedFetch('/api/settings/lead-form')`, `React Query` cache или shared hook
- **Шаги:**
  1. Смонтировать несколько потребителей в одном сценарии.
  2. Зафиксировать количество сетевых запросов.
  3. Проверить, что данные остаются консистентными между потребителями.
- **Ожидаемый результат:** Для одного жизненного цикла данных используется общий источник, без дублирующих запросов и рассинхронизации.
- **Файл для теста:** `frontend/src/components/leads/CreateLeadDialog.tsx`, `frontend/src/components/leads/EditLeadDialog.tsx`, `frontend/src/components/leads/LeadDetailSections.tsx`, `frontend/src/components/jobs/JobsFilters.tsx`, `frontend/src/components/jobs/JobMetadataSection.tsx`

### TC-F011-011: Дублирующие audio player implementation остаются эквивалентными по поведению
- **Приоритет:** P2
- **Тип:** Integration
- **Связанный сценарий:** Safe refactor slice -> можно выносить общий player без потери функций
- **Предусловия:** Тестируются `CallAudioPlayer` и `PulseCallAudioPlayer`
- **Входные данные:** Call с `audioUrl`, `summary`, `transcription`, `gemini_summary`, `gemini_entities`
- **Моки:** `authedFetch('/api/calls/:callSid/media')`, `authedFetch('/api/calls/:callSid/transcribe')`, `useLiveTranscript`
- **Шаги:**
  1. Отрендерить оба плеера на одинаковом call payload.
  2. Проверить кнопки summary/transcription, playback controls и reset/generate flow.
  3. Убедиться, что live transcript отображается только для live call без `audioUrl`.
- **Ожидаемый результат:** Поведение обоих implementation совпадает по UX-контракту, даже если внутренняя реализация будет вынесена в общий слой.
- **Файл для теста:** `frontend/src/components/CallAudioPlayer.tsx`, `frontend/src/components/pulse/PulseCallAudioPlayer.tsx`

### TC-F011-012: SSE события не теряют маппинг при рефакторинге realtime слоя
- **Приоритет:** P2
- **Тип:** Integration
- **Связанный сценарий:** Safe refactor slice -> сохранить поведение `useRealtimeEvents`
- **Предусловия:** Тестируется `frontend/src/hooks/useRealtimeEvents.ts`
- **Входные данные:** SSE payloads для `call.updated`, `call.created`, `message.added`, `message.delivery`, `conversation.updated`, `contact.read`, `transcript.delta`, `transcript.finalized`, `job.updated`, generic thread events
- **Моки:** `EventSource`, `getAuthToken`
- **Шаги:**
  1. Эмулировать подключение к SSE.
  2. Отправить каждый тип события.
  3. Проверить вызовы соответствующих callbacks.
- **Ожидаемый результат:** Все события продолжают попадать в ожидаемые обработчики, reconnect работает без потери подписок.
- **Файл для теста:** `frontend/src/hooks/useRealtimeEvents.ts`, `frontend/src/pages/useMessagesRealtime.ts`

### TC-F011-013: Критичный пользовательский поток Pulse не ломается после refactor slice
- **Приоритет:** P3
- **Тип:** E2E
- **Связанный сценарий:** End-to-end regression -> открыть Pulse, перейти в timeline, увидеть аудио/транскрипцию и live updates
- **Предусловия:** Доступен тестовый аккаунт и данные с одним звонком и одной SMS
- **Входные данные:** Пользователь открывает `/pulse`, выбирает контакт, переходит на `/pulse/timeline/:id`
- **Моки:** Twilio/Front/SSE ответы через тестовый стенд или Playwright fixtures
- **Шаги:**
  1. Открыть Pulse.
  2. Перейти в timeline конкретного контакта.
  3. Проверить список событий, аудиоплеер, summary, transcription и SSE update.
- **Ожидаемый результат:** Основной операторский flow сохраняется без визуальных или функциональных регрессий.
- **Файл для теста:** `frontend/src/pages/PulsePage.tsx`, `frontend/src/components/pulse/PulseTimeline.tsx`, `frontend/src/components/pulse/PulseCallAudioPlayer.tsx`

## Примечание
Первый проход по `F011` должен не исправлять код, а зафиксировать baseline и подготовить очередь безопасных refactor slices. Если какой-то test-case пока нельзя автоматизировать, он должен оставаться как документируемая проверка до появления нужного тестового harness.
