# Тест-кейсы: TWC-001 — Twilio API Client Singleton

## Покрытие
- Всего тест-кейсов: 9
- P0: 5 | P1: 3 | P2: 1 | P3: 0
- Unit: 8 | Integration: 1 | E2E: 0

---

### TC-TWC-001-001: getTwilioClient возвращает один и тот же instance при повторных вызовах
- **Приоритет:** P0
- **Тип:** Unit
- **Связанный сценарий:** Граничные случаи → повторный вызов после успешной инициализации
- **Предусловия:** `TWILIO_ACCOUNT_SID = 'ACtest'`, `TWILIO_AUTH_TOKEN = 'token123'`
- **Моки:** mock `twilio` package — возвращает `{ id: 'twilio-instance' }`
- **Шаги:**
  1. Импортировать `getTwilioClient` из `backend/src/services/twilioClient.js`
  2. Вызвать `getTwilioClient()` дважды
  3. Сравнить `===`
- **Ожидаемый результат:** оба вызова возвращают один и тот же объект (object identity сохранена); `twilio()` factory вызвана ровно 1 раз.
- **Файл для теста:** `tests/services/twilioClient.test.js`

---

### TC-TWC-001-002: getTwilioClient бросает понятную ошибку без TWILIO_ACCOUNT_SID
- **Приоритет:** P0
- **Тип:** Unit
- **Связанный сценарий:** Обработка ошибок → отсутствие env
- **Предусловия:** `delete process.env.TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN = 'x'`
- **Шаги:**
  1. Сбросить module cache (`jest.resetModules()`)
  2. Вызвать `getTwilioClient()`
- **Ожидаемый результат:** бросает Error с сообщением, содержащим `TWILIO_ACCOUNT_SID` и `TWILIO_AUTH_TOKEN`.
- **Файл для теста:** `tests/services/twilioClient.test.js`

---

### TC-TWC-001-003: getTwilioClient бросает понятную ошибку без TWILIO_AUTH_TOKEN
- **Приоритет:** P0
- **Тип:** Unit
- **Связанный сценарий:** Обработка ошибок → отсутствие env
- **Предусловия:** `TWILIO_ACCOUNT_SID = 'ACtest'`, `delete process.env.TWILIO_AUTH_TOKEN`
- **Шаги:** аналогично 002
- **Ожидаемый результат:** Error с указанием обоих имён переменных.
- **Файл для теста:** `tests/services/twilioClient.test.js`

---

### TC-TWC-001-004: модуль не падает при require без env
- **Приоритет:** P0
- **Тип:** Unit
- **Связанный сценарий:** Сценарий 6 — тесты/CLI без env
- **Предусловия:** оба TWILIO_* env удалены
- **Шаги:**
  1. `jest.resetModules()`
  2. `require('backend/src/services/twilioClient')` — без вызова `getTwilioClient()`
- **Ожидаемый результат:** require не бросает (lazy init).
- **Файл для теста:** `tests/services/twilioClient.test.js`

---

### TC-TWC-001-005: после ошибки на отсутствие env повторный вызов работает после установки env
- **Приоритет:** P1
- **Тип:** Unit
- **Связанный сценарий:** Граничные случаи → env становится доступен после первой ошибки
- **Предусловия:** оба TWILIO_* env удалены
- **Шаги:**
  1. Вызвать `getTwilioClient()` — поймать Error
  2. Установить env: `TWILIO_ACCOUNT_SID = 'ACtest'`, `TWILIO_AUTH_TOKEN = 'tok'`
  3. Снова вызвать `getTwilioClient()`
- **Ожидаемый результат:** второй вызов возвращает Twilio client (mock instance).
- **Файл для теста:** `tests/services/twilioClient.test.js`

---

### TC-TWC-001-006: reconcileStale.fetchAndUpdateFromTwilio использует shared client
- **Приоритет:** P0
- **Тип:** Unit
- **Связанный сценарий:** Сценарий 1
- **Предусловия:** TWILIO_* env заданы; `db` замокан; `twilio` package замокан
- **Шаги:**
  1. Импортировать `reconcileStale.js` и `twilioClient.js`
  2. Шпион на `twilio` factory и на `getTwilioClient`
  3. Прогнать `reconcileStaleCalls()` с N=5 stale-звонками
- **Ожидаемый результат:** `twilio` factory вызвана ≤ 1 раз во всём процессе теста; `client.calls(...).fetch()` вызвана для каждого звонка.
- **Файл для теста:** `tests/services/reconcileStale.test.js` (создать или дополнить)

---

### TC-TWC-001-007: inboxWorker не создаёт новый Twilio client на каждое webhook-событие
- **Приоритет:** P0
- **Тип:** Unit
- **Связанный сценарий:** Сценарий 3
- **Предусловия:** TWILIO_* env заданы; queries и DB замоканы; 5 фиктивных webhook-events в pending
- **Шаги:**
  1. Запустить один цикл `claimAndProcessEvents()`
  2. Шпионить за `twilio` factory
- **Ожидаемый результат:** `twilio` factory вызвана 0 раз внутри одного цикла (если уже инициализирован) или 1 раз (если первый вызов); НЕ N раз.
- **Файл для теста:** `tests/services/inboxWorker.test.js` (создать или дополнить)

---

### TC-TWC-001-008: callAvailability и phoneSettings импортируют новый getter, а не twilio напрямую
- **Приоритет:** P1
- **Тип:** Unit (статический)
- **Связанный сценарий:** регрессионный guard
- **Шаги:**
  1. `fs.readFileSync('backend/src/services/callAvailability.js')` и проверить отсутствие подстроки `twilio(process.env.TWILIO_ACCOUNT_SID`
  2. То же для `backend/src/routes/phoneSettings.js`, `backend/src/services/inboxWorker.js`, `backend/src/services/reconcileStale.js`
  3. Проверить присутствие `getTwilioClient`
- **Ожидаемый результат:** ни одна из четырёх ранее протекавших точек не содержит конструктора `twilio(...)` с подстановкой credentials; все четыре содержат `getTwilioClient`.
- **Файл для теста:** `tests/services/twilioClient.regression.test.js`

---

### TC-TWC-001-009: интеграционный smoke — boot процесса без Twilio env (CLI / тесты) не падает
- **Приоритет:** P1
- **Тип:** Integration
- **Связанный сценарий:** Сценарий 5 / 6
- **Предусловия:** оба TWILIO_* env удалены
- **Шаги:**
  1. require следующих модулей подряд: `conversationsService`, `twilioSync`, `reconcileService`, `reconcileStale`, `callAvailability`, `inboxWorker`
- **Ожидаемый результат:** ни один require не бросает; конкретно — старые конструкции `const client = twilio(undefined, undefined)` на module-level больше не выполняются.
- **Файл для теста:** `tests/services/twilioClient.bootstrap.test.js`

---

## Заметки

- Все тесты используют `jest.resetModules()` для контроля singleton-state между тестами.
- Mock `twilio` package: `jest.mock('twilio', () => jest.fn(() => ({ calls: jest.fn() })))`.
- Для P0 unit-тестов нужны standalone fixtures без реальной БД и без сети.
- Регрессионный тест 008 защищает от того, что кто-то снова добавит `twilio(sid, token)` в один из четырёх hot-spot файлов.
