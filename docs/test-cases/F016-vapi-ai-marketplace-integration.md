# Тест-кейсы: F016 — VAPI AI Marketplace Integration + Call Flow Gating

## Покрытие
- Всего тест-кейсов: 22
- P0: 6 | P1: 8 | P2: 5 | P3: 3
- Unit: 8 | Integration: 12 | E2E: 2

---

### TC-F016-001: Успешное подключение VAPI (полный happy path)
- **Приоритет:** P0
- **Тип:** Integration
- **Связанный сценарий:** Сценарий 1
- **Предусловия:** VAPI не подключён. Валидный Vapi API key.
- **Входные данные:**
  - api_key: `"vapi-test-key-valid"`
  - display_name: `"My VAPI Prod"`
  - environment: `"prod"`
  - sip_uri: `"sip:tenant-abc@sip.vapi.ai"`
  - server_url: `"https://api.albusto.com/api/vapi/runtime"`
- **Моки:** `fetch('https://api.vapi.ai/assistant?limit=1')` → 200 OK
- **Шаги:**
  1. POST /api/vapi/connections с api_key, display_name, environment
  2. POST /api/vapi/resources с connectionId, sip_uri, server_url
  3. POST /api/marketplace/apps/vapi-ai/install
- **Ожидаемый результат:**
  - Шаг 1: 200 `{ ok: true, data: { id, status: 'active', display_name: 'My VAPI Prod' } }`
  - Шаг 2: 200 `{ ok: true, data: { id, sip_uri: 'sip:tenant-abc@sip.vapi.ai' } }`
  - Шаг 3: 201 `{ success: true, installation: { status: 'connected' } }`
- **Файл для теста:** `tests/routes/vapi.test.js`, `tests/routes/marketplace.test.js`

---

### TC-F016-002: Невалидный Vapi API key
- **Приоритет:** P0
- **Тип:** Integration
- **Связанный сценарий:** Обработка ошибок — Invalid API key
- **Предусловия:** VAPI не подключён.
- **Входные данные:** api_key: `"invalid-key-123"`
- **Моки:** `fetch('https://api.vapi.ai/assistant?limit=1')` → 401 Unauthorized
- **Шаги:**
  1. POST /api/vapi/connections `{ api_key: 'invalid-key-123' }`
- **Ожидаемый результат:** 400 `{ ok: false, error: 'Invalid Vapi API key' }`
- **Файл для теста:** `tests/routes/vapi.test.js`

---

### TC-F016-003: Vapi API недоступен при верификации
- **Приоритет:** P1
- **Тип:** Integration
- **Связанный сценарий:** Обработка ошибок — network error
- **Входные данные:** api_key: `"any-key"`
- **Моки:** `fetch('https://api.vapi.ai/...')` → throws network error
- **Ожидаемый результат:** 400 `{ ok: false, error: 'Could not verify API key' }`
- **Файл для теста:** `tests/routes/vapi.test.js`

---

### TC-F016-004: Маркетплейс — посев VAPI AI app в БД
- **Приоритет:** P0
- **Тип:** Integration
- **Связанный сценарий:** Регистрация app в marketplace_apps
- **Предусловия:** Чистая БД с marketplace schema.
- **Шаги:**
  1. `ensureMarketplaceSchema()` выполняется
  2. SELECT из marketplace_apps WHERE app_key = 'vapi-ai'
- **Ожидаемый результат:** Запись существует: `{ app_key: 'vapi-ai', provisioning_mode: 'none', status: 'published', category: 'telephony' }`
- **Файл для теста:** `tests/routes/marketplaceMount.test.js`

---

### TC-F016-005: GET /api/marketplace/apps содержит vapi-ai
- **Приоритет:** P0
- **Тип:** Integration
- **Входные данные:** Authenticated request с companyId
- **Шаги:**
  1. GET /api/marketplace/apps
- **Ожидаемый результат:** Ответ 200, в массиве apps есть объект с `app_key: 'vapi-ai'`, `installation: null`
- **Файл для теста:** `tests/routes/marketplace.test.js`

---

### TC-F016-006: Маркетплейс install vapi-ai — provisioning_mode none
- **Приоритет:** P0
- **Тип:** Integration
- **Предусловия:** app 'vapi-ai' существует в marketplace_apps.
- **Шаги:**
  1. POST /api/marketplace/apps/vapi-ai/install
- **Ожидаемый результат:** 201, `installation.status === 'connected'` (немедленно, без push_credentials)
- **Файл для теста:** `tests/routes/marketplace.test.js`

---

### TC-F016-007: Дублирующий install vapi-ai
- **Приоритет:** P1
- **Тип:** Integration
- **Предусловия:** vapi-ai уже установлен (status: connected).
- **Шаги:**
  1. POST /api/marketplace/apps/vapi-ai/install (второй раз)
- **Ожидаемый результат:** 409 `{ success: false, code: 'APP_ALREADY_INSTALLED' }`
- **Файл для теста:** `tests/routes/marketplace.test.js`

---

### TC-F016-008: Disconnect vapi-ai installation
- **Приоритет:** P1
- **Тип:** Integration
- **Предусловия:** vapi-ai установлен.
- **Шаги:**
  1. POST /api/marketplace/installations/:id/disconnect
- **Ожидаемый результат:** 200, `installation.status === 'revoked'`
- **Файл для теста:** `tests/routes/marketplace.test.js`

---

### TC-F016-009: GET /api/vapi/connections — без авторизации
- **Приоритет:** P0
- **Тип:** Integration
- **Предусловия:** Нет Authorization header.
- **Шаги:**
  1. GET /api/vapi/connections (без токена)
- **Ожидаемый результат:** 401
- **Файл для теста:** `tests/routes/vapi.test.js`

---

### TC-F016-010: POST /api/vapi/connections — без авторизации
- **Приоритет:** P0
- **Тип:** Integration
- **Шаги:**
  1. POST /api/vapi/connections `{ api_key: 'key' }` без токена
- **Ожидаемый результат:** 401
- **Файл для теста:** `tests/routes/vapi.test.js`

---

### TC-F016-011: POST /api/vapi/connections — пропущен api_key
- **Приоритет:** P1
- **Тип:** Integration
- **Входные данные:** `{}` (пустое тело)
- **Ожидаемый результат:** 400 `{ ok: false, error: 'api_key is required' }`
- **Файл для теста:** `tests/routes/vapi.test.js`

---

### TC-F016-012: POST /api/vapi/resources — пропущен provider_connection_id
- **Приоритет:** P1
- **Тип:** Integration
- **Входные данные:** `{ sip_uri: 'sip:test@sip.vapi.ai' }` (без provider_connection_id)
- **Ожидаемый результат:** 400 `{ ok: false, error: 'provider_connection_id and sip_uri are required' }`
- **Файл для теста:** `tests/routes/vapi.test.js`

---

### TC-F016-013: GET /api/vapi/connections — возвращает только active connections
- **Приоритет:** P1
- **Тип:** Integration
- **Предусловия:** В БД есть connections со status active и error.
- **Шаги:**
  1. GET /api/vapi/connections
- **Ожидаемый результат:** Возвращаются ВСЕ connections (фильтр active/error для гейтинга на фронтенде), включая обе записи.
- **Файл для теста:** `tests/routes/vapi.test.js`

---

### TC-F016-014: vapiApi.ts — getConnections возвращает typed array
- **Приоритет:** P1
- **Тип:** Unit
- **Моки:** fetch mock → `{ ok: true, data: [{ id: 'c1', status: 'active' }] }`
- **Шаги:**
  1. Вызвать `vapiApi.getConnections()`
- **Ожидаемый результат:** `Promise<VapiConnection[]>` с правильной типизацией
- **Файл для теста:** `tests/services/vapiApi.test.ts` (или unit тест фронтенда)

---

### TC-F016-015: vapiApi.ts — createConnection при ошибке бросает Error с сообщением
- **Приоритет:** P1
- **Тип:** Unit
- **Моки:** fetch mock → 400 `{ ok: false, error: 'Invalid Vapi API key' }`
- **Ожидаемый результат:** Promise rejects с `Error('Invalid Vapi API key')`
- **Файл для теста:** unit тест vapiApi.ts

---

### TC-F016-016: Marketplace — idempotent seed (повторный запуск 088 миграции)
- **Приоритет:** P2
- **Тип:** Integration
- **Шаги:**
  1. Запустить `ensureMarketplaceSchema()` дважды
- **Ожидаемый результат:** Нет ошибок, запись vapi-ai одна (ON CONFLICT DO UPDATE работает)
- **Файл для теста:** `tests/routes/marketplaceMount.test.js`

---

### TC-F016-017: Call Flow Builder — vapi_agent скрыт без active connection
- **Приоритет:** P2
- **Тип:** Unit
- **Предусловия:** `vapiConnected = false`
- **Шаги:**
  1. Рендер insert picker с `vapiConnected = false`
- **Ожидаемый результат:** `vapi_agent` отсутствует в списке вариантов для вставки
- **Файл для теста:** unit тест CallFlowBuilderPage (если Jest + RTL)

---

### TC-F016-018: Call Flow Builder — vapi_agent виден при active connection
- **Приоритет:** P2
- **Тип:** Unit
- **Предусловия:** `vapiConnected = true`
- **Шаги:**
  1. Рендер insert picker с `vapiConnected = true`
- **Ожидаемый результат:** `vapi_agent` присутствует в списке вариантов
- **Файл для теста:** unit тест CallFlowBuilderPage

---

### TC-F016-019: VapiSettingsPage — режим просмотра при подключённом VAPI
- **Приоритет:** P2
- **Тип:** Unit
- **Предусловия:** API returns connection `{ status: 'active' }`, resource `{ sip_uri: 'sip:...' }`, installation `{ status: 'connected' }`
- **Ожидаемый результат:** Поля в read-only режиме, API key masked, кнопка "Disconnect" видна, форма ввода скрыта
- **Файл для теста:** unit тест VapiSettingsPage

---

### TC-F016-020: VapiSettingsPage — частичное состояние (connection без resource)
- **Приоритет:** P2
- **Тип:** Unit
- **Предусловия:** Connection active, resource отсутствует, installation отсутствует.
- **Ожидаемый результат:** Секция API Connection в view-режиме, секция SIP Resource в edit-режиме, "Finish Setup" недоступна
- **Файл для теста:** unit тест VapiSettingsPage

---

### TC-F016-021: Плитка VAPI в маркетплейсе — кнопка "Manage" при connected status
- **Приоритет:** P3
- **Тип:** Unit
- **Предусловия:** `app.installation.status === 'connected'`
- **Ожидаемый результат:** Кнопка показывает "Manage", а не "Enable" или generic dialog
- **Файл для теста:** unit тест IntegrationsPage

---

### TC-F016-022: E2E — полный цикл подключения и появления ноды
- **Приоритет:** P3
- **Тип:** E2E
- **Предусловия:** Тестовый tenant, валидный Vapi API key (test sandbox).
- **Шаги:**
  1. Открыть /settings/integrations → нажать Configure на VAPI AI
  2. Ввести API key, нажать Verify & Connect → ждать success
  3. Ввести SIP URI, нажать Save
  4. Нажать Finish Setup
  5. Открыть /settings/telephony/user-groups/:id/flow
  6. Нажать "+" между двумя нодами
- **Ожидаемый результат:** В insert picker присутствует "VAPI AI Agent" (фиолетовая нода с 🤖)
- **Файл для теста:** Playwright / Cypress e2e suite
