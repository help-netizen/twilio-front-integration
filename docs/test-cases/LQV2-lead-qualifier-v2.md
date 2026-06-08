# Тест-кейсы: LQV2 — Lead Qualifier v2 AI Phone Assistant

## Покрытие
- Всего тест-кейсов: 59
- P0: 21 | P1: 21 | P2: 10 | P3: 7
- Unit: 22 | Integration: 18 | E2E: 19 (system prompt + conversation flow)

## Тестовые слои

| Слой | Файл | Что покрывает |
|---|---|---|
| Backend unit/integration | `tests/routes/vapi-tools.test.js` | Tool handlers, middleware, retry, buildCallSummary |
| Conversation / E2E | `tests/e2e/vapi-tools-flow.test.js` | Полные сценарии звонка (VAPI sandbox или mock) |
| System prompt | `tests/prompts/lead-qualifier-v2.prompt.test.js` | FR-4 objections, FR-5 marketing, FR-6 NLP, FR-11 FAQ, FR-11b escalation, FR-12 disqualification |

> **Примечание по System Prompt тестам:** FR-4, FR-5, FR-6, FR-11, FR-11b, FR-12 — поведение ассистента, которое живёт в system prompt, а не в backend tool handlers. Эти тесты валидируют систем-промпт через LLM evaluation (например, promptfoo или аналог): подают transcript фрагмент, проверяют что ответ ассистента соответствует ожидаемой технике/правилу.

---

## Группа 1: Middleware и авторизация

### TC-LQV2-001: Корректный x-vapi-secret — запрос проходит
- **Приоритет:** P0
- **Тип:** Integration
- **Связанный сценарий:** Все сценарии (precondition)
- **Предусловия:** `VAPI_TOOLS_SECRET=test-secret` в env
- **Входные данные:**
  - Header: `x-vapi-secret: test-secret`
  - Body: `{ message: { type: "status-update" } }`
- **Моки:** Нет
- **Шаги:**
  1. POST `/api/vapi-tools` с корректным header
- **Ожидаемый результат:** `200 {}` (status-update acknowledged silently)
- **Файл:** `tests/routes/vapi-tools.test.js`

---

### TC-LQV2-002: Неверный x-vapi-secret — 401
- **Приоритет:** P0
- **Тип:** Integration
- **Предусловия:** `VAPI_TOOLS_SECRET=test-secret` в env
- **Входные данные:** Header: `x-vapi-secret: wrong-secret`
- **Ожидаемый результат:** `401 { error: "Unauthorized" }`

---

### TC-LQV2-003: Отсутствует x-vapi-secret header — 401
- **Приоритет:** P0
- **Тип:** Integration
- **Входные данные:** Нет header
- **Ожидаемый результат:** `401 { error: "Unauthorized" }`

---

### TC-LQV2-004: VAPI_TOOLS_SECRET не задан в env — dev-mode, запрос проходит
- **Приоритет:** P1
- **Тип:** Unit
- **Предусловия:** `VAPI_TOOLS_SECRET` не задан
- **Ожидаемый результат:** `console.warn` вызван, запрос пропускается дальше (200)

---

## Группа 2: Dispatcher и не-tool сообщения

### TC-LQV2-005: Тип сообщения не tool-calls — возвращает {}
- **Приоритет:** P0
- **Тип:** Integration
- **Входные данные:**
  - `{ message: { type: "status-update", ... } }`
  - `{ message: { type: "end-of-call-report", ... } }`
- **Ожидаемый результат:** `200 {}` для обоих случаев

---

### TC-LQV2-006: Неизвестный tool name — возвращает error в result
- **Приоритет:** P1
- **Тип:** Integration
- **Входные данные:**
  - `toolCallList: [{ id: "tc1", function: { name: "unknownTool", arguments: "{}" } }]`
- **Ожидаемый результат:**
  - `200 { results: [{ toolCallId: "tc1", result: "{\"error\":\"Unknown tool: unknownTool\"}" }] }`

---

### TC-LQV2-007: arguments — невалидный JSON string — парсится в {}
- **Приоритет:** P2
- **Тип:** Unit
- **Входные данные:** `arguments: "not valid json"`
- **Ожидаемый результат:** аргументы = `{}`, обработчик получает пустые параметры

---

## Группа 3: handleCheckServiceArea

### TC-LQV2-008: zip в зоне обслуживания — возвращает inServiceArea: true
- **Приоритет:** P0
- **Тип:** Integration
- **Моки:**
  - `stQueries.search` → `{ zip: "02101", area: "Boston", city: "Boston", state: "MA" }`
- **Входные данные:** `checkServiceArea({ zip: "02101" })`
- **Ожидаемый результат:**
  ```json
  { "inServiceArea": true, "area": "Boston", "city": "Boston", "state": "MA", "zip": "02101" }
  ```

---

### TC-LQV2-009: zip вне зоны обслуживания — inServiceArea: false
- **Приоритет:** P0
- **Тип:** Integration
- **Моки:** `stQueries.search` → `null`
- **Входные данные:** `checkServiceArea({ zip: "03801" })`
- **Ожидаемый результат:** `{ "inServiceArea": false }`

---

### TC-LQV2-010: zip не передан — inServiceArea: false + error
- **Приоритет:** P1
- **Тип:** Unit
- **Входные данные:** `checkServiceArea({})`
- **Ожидаемый результат:** `{ "inServiceArea": false, "error": "zip is required" }`

---

### TC-LQV2-011: DB error в checkServiceArea — ошибка в result, не 500
- **Приоритет:** P1
- **Тип:** Integration
- **Моки:** `stQueries.search` → throws Error("DB connection failed")
- **Ожидаемый результат:** `200` с `result: '{"error":"DB connection failed"}'`; запрос не падает в 500

---

## Группа 4: handleValidateAddress

### TC-LQV2-012: Корректный адрес — valid: true, стандартизированный адрес
- **Приоритет:** P0
- **Тип:** Integration
- **Моки:**
  - Google Maps Geocoding API → `{ results: [{ formatted_address: "45 Tremont St Apt 3, Boston, MA 02108, USA", geometry: { location: { lat: 42.357, lng: -71.059 } }, address_components: [...postal_code: "02108"...] }], status: "OK" }`
- **Входные данные:** `validateAddress({ street: "45 Tremont St", apt: "3", city: "Boston", state: "MA", zip: "02108" })`
- **Ожидаемый результат:**
  ```json
  { "valid": true, "standardized": "45 Tremont St Apt 3, Boston, MA 02108", "correctedZip": "02108", "lat": 42.357, "lng": -71.059 }
  ```

---

### TC-LQV2-013: Google Maps ZERO_RESULTS — valid: false
- **Приоритет:** P0
- **Тип:** Integration
- **Моки:** Google Maps API → `{ results: [], status: "ZERO_RESULTS" }`
- **Входные данные:** `validateAddress({ street: "999 Fake St", city: "Nowhere" })`
- **Ожидаемый результат:** `{ "valid": false }`

---

### TC-LQV2-014: Google Maps API ошибка / timeout — valid: false, не throws
- **Приоритет:** P0
- **Тип:** Unit
- **Моки:** Google Maps API fetch → throws Error("Network timeout")
- **Ожидаемый результат:** `{ "valid": false }` — никогда не бросает исключение

---

### TC-LQV2-015: correctedZip отличается от введённого zip
- **Приоритет:** P1
- **Тип:** Integration
- **Моки:** Google Maps → `postal_code: "02115"` при введённом `zip: "02101"`
- **Ожидаемый результат:** `{ "valid": true, "correctedZip": "02115", ... }`

---

### TC-LQV2-016: Отсутствует VITE_GOOGLE_MAPS_API_KEY — valid: false
- **Приоритет:** P1
- **Тип:** Unit
- **Предусловия:** `VITE_GOOGLE_MAPS_API_KEY` не задан
- **Ожидаемый результат:** `{ "valid": false, "error": "VITE_GOOGLE_MAPS_API_KEY not configured" }` или аналог; не бросает

---

## Группа 5: handleCheckAvailability

### TC-LQV2-017: Успешный запрос — возвращает до 3 слотов
- **Приоритет:** P0
- **Тип:** Integration
- **Моки:**
  - `zenbookerClient.findTerritoryByPostalCode("02101")` → `"terr_001"`
  - `zenbookerClient.getTimeslots(...)` → массив из 5 слотов
- **Входные данные:** `checkAvailability({ zip: "02101", unitType: "Refrigerator" })`
- **Ожидаемый результат:**
  - `{ slots: [ { date: "...", label: "...", start: "...", end: "..." }, ... ] }`
  - Максимум 3 слота в ответе
  - `label` — человекочитаемый: *"Tuesday, June 10th between 10am and 1pm"*

---

### TC-LQV2-018: Нет доступных слотов — slots: []
- **Приоритет:** P0
- **Тип:** Integration
- **Моки:** `zenbookerClient.getTimeslots(...)` → `[]`
- **Ожидаемый результат:** `{ "slots": [], "error": "No availability found in the next 5 days" }`

---

### TC-LQV2-019: findTerritoryByPostalCode — zip не найден в Zenbooker
- **Приоритет:** P1
- **Тип:** Integration
- **Моки:** `findTerritoryByPostalCode` → throws Error("Postal code is not in any service territory")
- **Ожидаемый результат:** `{ "slots": [], "error": "Postal code is not in any service territory" }` — не 500

---

### TC-LQV2-020: Zenbooker API недоступен — slots: [], error
- **Приоритет:** P1
- **Тип:** Integration
- **Моки:** `zenbookerClient.getTimeslots` → throws Error("Zenbooker unreachable")
- **Ожидаемый результат:** `{ "slots": [], "error": "Zenbooker unreachable" }`

---

### TC-LQV2-021: Формат label слотов — корректный human-readable
- **Приоритет:** P1
- **Тип:** Unit
- **Входные данные:** Zenbooker slot `{ date: "2026-06-10", start: "10:00", end: "13:00" }`
- **Ожидаемый результат:** label = `"Tuesday, June 10th between 10am and 1pm"`

---

## Группа 6: handleCreateLead

### TC-LQV2-022a: email передан — включается в lead body
- **Приоритет:** P1
- **Тип:** Unit
- **Связанный сценарий:** FR-7 Contact collection (email optional)
- **Входные данные:** `{ ..., email: "john@example.com", phone: "+16175551234", firstName: "John", lastName: "Smith", unitType: "Dryer", problemDescription: "not heating" }`
- **Ожидаемый результат:** `leadsService.createLead` вызывается с `{ Email: "john@example.com" }` в теле

---

### TC-LQV2-022: Успешное создание лида — все поля
- **Приоритет:** P0
- **Тип:** Integration
- **Моки:**
  - `leadsService.createLead` → `{ uuid: "lead-uuid-001", ... }`
- **Входные данные:**
  ```json
  {
    "firstName": "John", "lastName": "Smith",
    "phone": "+16175551234", "zip": "02101",
    "city": "Boston", "state": "MA",
    "unitType": "Refrigerator", "brand": "Samsung",
    "unitAge": "5 years", "problemDescription": "not cooling",
    "preferredSlot": "Tuesday June 10th 10am-1pm",
    "addressValidated": true
  }
  ```
- **Ожидаемый результат:**
  - `{ success: true, leadId: "lead-uuid-001" }`
  - `leadsService.createLead` вызван с `JobSource: "AI Phone"`, `JobType: "Refrigerator Repair"`
  - Comments содержит все поля: `Unit: Refrigerator | Brand: Samsung | Age: 5 years | Problem: not cooling | Fee agreed: Yes | Slot: Tuesday June 10th 10am-1pm | Address validated: yes`

---

### TC-LQV2-023: phone не передан — success: false
- **Приоритет:** P0
- **Тип:** Unit
- **Входные данные:** payload без `phone`
- **Ожидаемый результат:** `{ "success": false, "error": "Phone number is required to create lead" }`
- **Моки:** `leadsService.createLead` НЕ должен вызываться

---

### TC-LQV2-024: phone слишком короткий — success: false
- **Приоритет:** P1
- **Тип:** Unit
- **Входные данные:** `phone: "123"`
- **Ожидаемый результат:** `{ "success": false, "error": "Phone number is required to create lead" }`

---

### TC-LQV2-025: JobSource всегда "AI Phone"
- **Приоритет:** P0
- **Тип:** Unit
- **Ожидаемый результат:** `leadsService.createLead` вызывается с `{ JobSource: "AI Phone" }` независимо от входных параметров

---

### TC-LQV2-026: escalationRequested: true — отражается в Comments
- **Приоритет:** P1
- **Тип:** Unit
- **Входные данные:** `{ ..., escalationRequested: true }`
- **Ожидаемый результат:** Comments содержит `escalation_requested: true`

---

### TC-LQV2-027: createLead API ошибка — retry, затем success: false
- **Приоритет:** P0
- **Тип:** Integration
- **Моки:** `leadsService.createLead` throws на первом вызове, throws на retry
- **Ожидаемый результат:**
  - `leadsService.createLead` вызван 2 раза
  - Итоговый result: `{ success: false, error: "..." }`
  - HTTP статус: `200` (ошибка инкапсулирована в result, не 500)

---

### TC-LQV2-028: createLead retry — первый fail, второй success
- **Приоритет:** P1
- **Тип:** Integration
- **Моки:** первый вызов throws, второй вызов → `{ uuid: "lead-uuid-002" }`
- **Ожидаемый результат:** `{ success: true, leadId: "lead-uuid-002" }`

---

### TC-LQV2-029: preferredSlot: null — Comments содержит "Slot: pending callback"
- **Приоритет:** P1
- **Тип:** Unit
- **Входные данные:** `preferredSlot: null` или не передан
- **Ожидаемый результат:** Comments содержит `Slot: pending callback`

---

### TC-LQV2-029a: addressValidated: false — Comments содержит "Address validated: no"
- **Приоритет:** P1
- **Тип:** Unit
- **Входные данные:** `{ ..., addressValidated: false, phone: "+16175551234", unitType: "Washer", problemDescription: "leaking" }`
- **Ожидаемый результат:** Comments содержит `Address validated: no`

---

## Группа 7: Параллельные tool calls

### TC-LQV2-030: Несколько tool calls в одном запросе — все обрабатываются
- **Приоритет:** P1
- **Тип:** Integration
- **Входные данные:**
  ```json
  {
    "toolCallList": [
      { "id": "tc1", "function": { "name": "checkServiceArea", "arguments": "{\"zip\":\"02101\"}" } },
      { "id": "tc2", "function": { "name": "checkServiceArea", "arguments": "{\"zip\":\"03801\"}" } }
    ]
  }
  ```
- **Ожидаемый результат:**
  - `results` содержит 2 элемента с `toolCallId: "tc1"` и `toolCallId: "tc2"`
  - Порядок соответствует входному массиву

---

## Группа 8: buildCallSummary

### TC-LQV2-031: Все поля присутствуют — полный Comments
- **Приоритет:** P0
- **Тип:** Unit
- **Входные данные:** `{ unitType: "Washer", brand: "LG", unitAge: "3 years", problemDescription: "not spinning", preferredSlot: "Tue 10am", addressValidated: true, escalationRequested: false }`
- **Ожидаемый результат:** `"Unit: Washer | Brand: LG | Age: 3 years | Problem: not spinning | Fee agreed: Yes | Slot: Tue 10am | Address validated: yes"`

---

### TC-LQV2-032: age не передан — "unknown" в Comments
- **Приоритет:** P1
- **Тип:** Unit
- **Входные данные:** unitAge не передан или null
- **Ожидаемый результат:** Comments содержит `Age: unknown`

---

## Группа 9: Server.js монтирование

### TC-LQV2-033: `/api/vapi-tools` смонтирован БЕЗ authenticate/requireCompanyAccess
- **Приоритет:** P0
- **Тип:** Integration
- **Предусловия:** Запрос без Authorization header
- **Входные данные:** POST `/api/vapi-tools` без Auth token, с корректным `x-vapi-secret`
- **Ожидаемый результат:** `200` (не `401` от authenticate)
- **Файл:** `tests/routes/vapi-tools.test.js`

---

## Группа 10: E2E (smoke)

### TC-LQV2-034: E2E — полный flow от VAPI payload до лида в БД
- **Приоритет:** P2
- **Тип:** E2E
- **Предусловия:** Тестовая БД с service_territories, тестовый Zenbooker mock, тестовый Google Maps mock
- **Шаги:**
  1. POST `/api/vapi-tools` с `checkServiceArea({ zip: "02101" })`
  2. POST `/api/vapi-tools` с `validateAddress(...)`
  3. POST `/api/vapi-tools` с `checkAvailability({ zip: "02101" })`
  4. POST `/api/vapi-tools` с `createLead({ ..., phone: "+16175551234", ... })`
- **Ожидаемый результат:**
  - Шаг 1: `inServiceArea: true`
  - Шаг 2: `valid: true`
  - Шаг 3: `slots.length >= 1`
  - Шаг 4: `success: true`, лид найден в `leads` таблице с `job_source = "AI Phone"`
- **Файл:** `tests/e2e/vapi-tools-flow.test.js`

---

## Группа 11: FR-8.4 — Address zip mismatch re-check (Integration)

### TC-LQV2-035: validateAddress correctedZip совпадает с qualification zip — проверка зоны не нужна
- **Приоритет:** P1
- **Тип:** Integration
- **Связанный сценарий:** FR-8.4
- **Входные данные:** qualification zip = "02101"; `validateAddress` → `correctedZip: "02101"`
- **Ожидаемый результат:** `checkServiceArea` не вызывается повторно; `{ valid: true, correctedZip: "02101" }`

---

### TC-LQV2-036: validateAddress correctedZip отличается — ассистент должен повторно вызвать checkServiceArea
- **Приоритет:** P0
- **Тип:** E2E (conversation flow)
- **Связанный сценарий:** FR-8.4, Scenario 5
- **Файл:** `tests/e2e/vapi-tools-flow.test.js`
- **Предусловия:** qualification zip "02101" → `inServiceArea: true`; validateAddress вернул `correctedZip: "02169"`
- **Шаги:**
  1. VAPI вызывает `checkServiceArea({ zip: "02101" })` → `{ inServiceArea: true }`
  2. VAPI вызывает `validateAddress(...)` → `{ correctedZip: "02169" }`
  3. Ассистент вызывает `checkServiceArea({ zip: "02169" })` → `{ inServiceArea: false }`
  4. Ассистент дисквалифицирует звонящего
- **Ожидаемый результат:**
  - `checkServiceArea` вызван дважды: с "02101" и "02169"
  - `createLead` не вызывается
  - Ассистент произносит disqualification script

---

### TC-LQV2-037: validateAddress correctedZip отличается, повторная проверка — зона ОК
- **Приоритет:** P1
- **Тип:** E2E (conversation flow)
- **Предусловия:** correctedZip "02115" → `inServiceArea: true`
- **Ожидаемый результат:** Звонок продолжается. `createLead` в итоге вызывается.

---

## Группа 12: FR-5.2 — Time-limited offer (2 PM ET cutoff)
**Слой:** System Prompt / E2E
**Файл:** `tests/prompts/lead-qualifier-v2.prompt.test.js`

### TC-LQV2-038: Время до 14:00 ET — time-limited offer срабатывает
- **Приоритет:** P0
- **Тип:** E2E (system prompt evaluation)
- **Связанный сценарий:** FR-5.2; spec `parts_order_cutoff: "14:00"`
- **Предусловия:** Системный промпт содержит текущее время = 11:00 ET (или VAPI variable injection)
- **Входные данные:** Caller hesitates after agreeing to proceed
- **Ожидаемый результат:** Ассистент произносит: *"If we confirm before 2 o'clock, our dispatcher can get the part ordered today..."*

---

### TC-LQV2-039: Время после 14:00 ET — time-limited offer НЕ срабатывает
- **Приоритет:** P0
- **Тип:** E2E (system prompt evaluation)
- **Предусловия:** Текущее время = 15:30 ET
- **Входные данные:** Caller hesitates after agreeing
- **Ожидаемый результат:**
  - Ассистент НЕ произносит фразу про "before 2 o'clock" или "order today"
  - Вместо этого применяет другие техники (FOMO, social proof, scarcity)

---

### TC-LQV2-040: Time-limited offer не повторяется дважды в одном звонке
- **Приоритет:** P1
- **Тип:** E2E (system prompt evaluation)
- **Предусловия:** Время < 14:00; триггер уже сработал однажды
- **Ожидаемый результат:** Фраза про "before 2 o'clock" не повторяется в том же звонке

---

## Группа 13: FR-4 — Objection Handling
**Слой:** System Prompt / E2E
**Файл:** `tests/prompts/lead-qualifier-v2.prompt.test.js`

### TC-LQV2-041: Возражение "$95 is too expensive" — reframe + social proof
- **Приоритет:** P0
- **Тип:** E2E (system prompt evaluation)
- **Связанный сценарий:** FR-4 objection matrix
- **Входные данные:** Caller: "That's $95 just for them to show up? That's too expensive."
- **Ожидаемый результат:**
  - Ответ содержит reframe: fee vs. buying new OR value anchor OR social proof
  - Ответ НЕ содержит оправданий или согласия с возражением
  - Ответ ≤ 3 предложения

---

### TC-LQV2-042: Возражение "I want other quotes first" — upfront pricing model
- **Приоритет:** P0
- **Тип:** E2E (system prompt evaluation)
- **Входные данные:** Caller: "I want to shop around and get other estimates first."
- **Ожидаемый результат:** Ответ содержит объяснение upfront pricing: *"Our tech gives you the exact price on-site before any work starts"*

---

### TC-LQV2-043: Возражение "I need to think about it" — timeline pressure
- **Приоритет:** P0
- **Тип:** E2E (system prompt evaluation)
- **Входные данные:** Caller: "I need to think about it and talk to my husband."
- **Ожидаемый результат:**
  - Ответ содержит один из: timeline pressure, loss framing, scarcity, open door с slot lock

---

### TC-LQV2-044: Возражение "I'll just buy a new one" — cost comparison anchor
- **Приоритет:** P1
- **Тип:** E2E (system prompt evaluation)
- **Входные данные:** Caller: "Honestly, maybe I should just buy a new washer instead."
- **Ожидаемый результат:** Ответ содержит cost comparison (repair vs. replace) или risk framing

---

### TC-LQV2-045: Возражение "I don't trust phone services" — social proof
- **Приоритет:** P1
- **Тип:** E2E (system prompt evaluation)
- **Входные данные:** Caller: "How do I know you're legit? I don't trust phone services."
- **Ожидаемый результат:** Ответ содержит ≥ 1 trust anchor из списка (Home Depot, NSA, Liberty, Home Choice, 4.9 rating, years in area)

---

### TC-LQV2-046: Max 2 попытки обработки одного возражения
- **Приоритет:** P0
- **Тип:** E2E (system prompt evaluation)
- **Входные данные:** Caller повторяет то же возражение трижды
- **Ожидаемый результат:** После 2-й попытки ассистент принимает ответ и меняет тактику (не повторяет тот же reframe в третий раз)

---

## Группа 14: FR-6 — NLP Techniques
**Слой:** System Prompt / E2E
**Файл:** `tests/prompts/lead-qualifier-v2.prompt.test.js`

### TC-LQV2-047: Choice without choice при предложении слотов
- **Приоритет:** P0
- **Тип:** E2E (system prompt evaluation)
- **Связанный сценарий:** FR-6.1
- **Предусловия:** `checkAvailability` вернул 3 слота
- **Ожидаемый результат:** Ассистент предлагает ровно 2 варианта в формате *"Would X or Y work better for you?"* — НЕ открытый вопрос *"When works for you?"*

---

### TC-LQV2-048: Meta-model — вагуная проблема проходит через probing
- **Приоритет:** P0
- **Тип:** E2E (system prompt evaluation)
- **Связанный сценарий:** FR-6.6, FR-3.2
- **Входные данные:** Caller: "It's just broken."
- **Ожидаемый результат:** Ассистент задаёт уточняющий вопрос: *"What exactly is it doing — or not doing?"* или аналог. Не принимает "broken" как финальный ответ.

---

### TC-LQV2-049: Reframe — $95 fee → free diagnostic
- **Приоритет:** P1
- **Тип:** E2E (system prompt evaluation)
- **Связанный сценарий:** FR-6.3
- **Входные данные:** Caller mentions the $95 as a cost
- **Ожидаемый результат:** Ответ содержит reframe: "waived if repair approved" или "a free diagnostic if you move forward"

---

## Группа 15: FR-11 — FAQ Knowledge Base
**Слой:** System Prompt / E2E
**Файл:** `tests/prompts/lead-qualifier-v2.prompt.test.js`

### TC-LQV2-050: FAQ — вопрос о цене ремонта → никакой конкретной суммы
- **Приоритет:** P0
- **Тип:** E2E (system prompt evaluation)
- **Связанный сценарий:** FR-11 pricing topic
- **Входные данные:** Caller: "How much does it usually cost to fix a refrigerator?"
- **Ожидаемый результат:**
  - Ответ НЕ содержит конкретных цифр (кроме $95 service call)
  - Ответ содержит: "Our technician gives you a firm price before any work starts"
  - Ответ заканчивается pivot к записи

---

### TC-LQV2-051: FAQ — неизвестный вопрос → предложение callback, без фабрикации
- **Приоритет:** P0
- **Тип:** E2E (system prompt evaluation)
- **Связанный сценарий:** FR-11.3
- **Входные данные:** Caller: "Do you offer financing options?"
- **Ожидаемый результат:**
  - Ответ не содержит выдуманного ответа про financing
  - Ответ предлагает callback: *"One of our team members can give you a definitive answer on that"*

---

## Группа 16: FR-11b — Human Escalation
**Слой:** System Prompt / E2E
**Файл:** `tests/prompts/lead-qualifier-v2.prompt.test.js`

### TC-LQV2-052: Первый запрос живого человека — одна попытка удержания
- **Приоритет:** P0
- **Тип:** E2E (system prompt evaluation)
- **Связанный сценарий:** FR-11b.1, Scenario 7
- **Входные данные:** Caller: "Let me speak to a real person, please."
- **Ожидаемый результат:**
  - Ответ содержит retention attempt: *"I completely understand — let me see if I can help you directly..."*
  - Ответ НЕ сразу предлагает callback

---

### TC-LQV2-053: Повторный запрос после retention attempt → callback
- **Приоритет:** P0
- **Тип:** E2E (system prompt evaluation)
- **Связанный сценарий:** FR-11b.2
- **Входные данные:** Caller снова: "No, I really need to speak to someone."
- **Ожидаемый результат:**
  - Ассистент принимает запрос, предлагает callback
  - Спрашивает подтверждение номера телефона
  - Вызывает `createLead` с `escalationRequested: true` (проверяется через mock)
  - НЕ делает третью попытку удержания

---

## Группа 17: FR-12 — Disqualification paths
**Слой:** System Prompt / E2E
**Файл:** `tests/e2e/vapi-tools-flow.test.js`

### TC-LQV2-054: Дисквалификация — вне зоны обслуживания → createLead не вызывается
- **Приоритет:** P0
- **Тип:** E2E
- **Связанный сценарий:** Scenario 3, FR-12.1
- **Предусловия:** `checkServiceArea({ zip: "03801" })` → `{ inServiceArea: false }`
- **Шаги:**
  1. VAPI вызывает `checkServiceArea({ zip: "03801" })`
  2. Ассистент произносит disqualification script
  3. Звонок завершается
- **Ожидаемый результат:**
  - `createLead` не вызывается (mock не получает вызова)
  - Ответ ассистента содержит *"we don't currently cover your area"*

---

### TC-LQV2-055: Дисквалификация — неподходящий аппарат → никаких tool calls
- **Приоритет:** P0
- **Тип:** E2E (system prompt evaluation)
- **Связанный сценарий:** Scenario 2, FR-2.1
- **Входные данные:** Caller: "My Keurig coffee maker is broken."
- **Ожидаемый результат:**
  - `checkServiceArea` НЕ вызывается
  - `createLead` НЕ вызывается
  - Ответ содержит disqualification: *"We specialize in major built-in appliances"*

---

### TC-LQV2-056: Дисквалификация — отказ от $95 fee → createLead не вызывается
- **Приоритет:** P1
- **Тип:** E2E (system prompt evaluation)
- **Связанный сценарий:** Scenario 4, FR-2.3, FR-12.1
- **Входные данные:** Caller: "No, I'm not paying $95 just for someone to come look at it."
- **Ожидаемый результат:**
  - Ассистент закрывает звонок с open-door: *"Completely understandable. If you change your mind..."*
  - `createLead` не вызывается

---

### TC-LQV2-057: Caller хочет подождать — createLead вызывается с cold lead
- **Приоритет:** P1
- **Тип:** E2E (conversation flow)
- **Связанный сценарий:** FR-12.1 "wants to wait", FR-12.2
- **Файл:** `tests/e2e/vapi-tools-flow.test.js`
- **Входные данные:** Caller (после квалификации): "I think I'll just wait and see if it gets worse."
- **Шаги:**
  1. Ассистент применяет risk escalation (FR-4 objection: "I'll wait and see") — одна попытка
  2. Caller остаётся на позиции
  3. Ассистент собирает имя и телефон, закрывает звонок открытой дверью
  4. `createLead` вызывается
- **Ожидаемый результат:**
  - `createLead` вызывается с `preferredSlot: null`
  - Comments содержит `Slot: pending callback` (или аналогичный cold-статус)
  - Ассистент произносит open-door close: *"No problem at all — if you change your mind, feel free to call us back!"*
  - Никакого принуждения после второй попытки

---

## Зависимости моков

| Внешний сервис | Мок | Используется в |
|---|---|---|
| `backend/src/db/serviceTerritoryQueries` | jest.mock | TC-008 – TC-011, TC-035 – TC-037 |
| `backend/src/services/leadsService` | jest.mock | TC-022a, TC-022 – TC-029a, TC-053 |
| `backend/src/services/zenbookerClient` | jest.mock | TC-017 – TC-020 |
| Google Maps Geocoding API (fetch/axios) | jest.mock или nock | TC-012 – TC-016, TC-035 – TC-037 |
| VAPI call transcript / LLM evaluator | promptfoo или аналог | TC-038 – TC-056 |

## Обновлённый счёт покрытия

| FR | Описание | TC покрытие |
|---|---|---|
| FR-1 | Greeting, intent detection | TC-001, TC-005, E2E-034 |
| FR-2 | Qualification: appliance, area, fee | TC-008, TC-009, TC-054, TC-055, TC-056 |
| FR-3 | Unit & problem collection | TC-048 (meta-model) |
| FR-4 | Objection handling | TC-041 – TC-046 |
| FR-5.1 | FOMO | TC-039 (implied) |
| FR-5.2 | Time-limited offer (2 PM ET) | TC-038, TC-039, TC-040 |
| FR-5.3 | Scarcity | TC-039 (implied) |
| FR-5.4 | Social proof | TC-045 |
| FR-5.5 | Warranty as trust-builder | TC-041 (implied) |
| FR-6.1 | Choice without choice | TC-047 |
| FR-6.3 | Reframing | TC-049 |
| FR-6.6 | Meta-model probing | TC-048 |
| FR-7 | Contact collection (incl. email) | TC-022a |
| FR-8.1-3 | validateAddress | TC-012 – TC-016 |
| FR-8.4 | Zip mismatch re-check | TC-036, TC-037 |
| FR-9 | Schedule availability | TC-017 – TC-021 |
| FR-10 | createLead + retry | TC-022 – TC-029a, TC-027, TC-028 |
| FR-11 | FAQ | TC-050, TC-051 |
| FR-11b | Escalation | TC-052, TC-053 |
| FR-12 | Disqualification & close (all 4 paths) | TC-054, TC-055, TC-056, TC-057 |
