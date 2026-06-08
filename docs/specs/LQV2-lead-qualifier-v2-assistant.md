# Спецификация: LQV2 — Lead Qualifier v2 AI Phone Assistant

**Platform:** VAPI | **Model:** GPT-4o | **Voice:** Azure / Andrew | **Persona:** Alex
**Predecessor:** Lead Qualifier v1 (`48844b0e-93aa-4d32-aab9-81a3972e9502`)
**Source of truth:** `voice-agent/assistants/lead-qualifier-v2-spec.md`

## Общее описание

Расширение существующего backend endpoint `/api/vapi-tools` двумя новыми tool handlers (`validateAddress`, `checkAvailability`) и создание полного конфига VAPI ассистента **"Alex"** (Lead Qualifier v2), который ведёт входящий звонок от приветствия до создания лида в CRM.

**VAPI Assistant config:**
```json
{
  "name": "Lead Qualifier v2",
  "firstMessage": "Hi, this is Alex from ABC Homes Appliance Repair! How can I help you today?",
  "firstMessageMode": "assistant-speaks-first",
  "maxDurationSeconds": 900,
  "silenceTimeoutSeconds": 30,
  "endCallFunctionEnabled": true,
  "endCallMessage": "Thank you for calling ABC Homes Appliance Repair. Have a great day!",
  "metadata": { "slug": "lead_qualifier_v2", "stage": "2", "version": "2.0.0" }
}
```

**Phone extraction from VAPI context:**
VAPI injects caller's phone number in the call payload: `message.call.customer.number` (E.164 format, e.g. `"+16175551234"`). The system prompt instructs the assistant to use this value for phone confirmation and pass it to `createLead`. The assistant should say: *"Should we use the number you're calling from — ending in [last 4 digits]?"*

**Business hours and parts cutoff:**
- Parts same-day shipping cutoff: **14:00 ET** (`America/New_York`)
- Time-limited offer (FR-5.2) fires ONLY before 14:00 ET. The system prompt must receive current time via VAPI variable injection (`{{now}}` or equivalent). After 14:00 ET — omit the offer entirely.
- Full business hours TBD (does not block v2).

**Company context (for system prompt and social proof):**
- Company: ABC Homes Appliance Repair
- Area: Greater Boston
- Years in market: 5+
- Rating: 4.9 (Google + Yelp)
- Partners: Home Depot, National Service Alliance, Liberty Mutual, Home Choice
- Service call fee: $95 — waived if repair approved (included in final price); only pay $95 if no repair
- Warranty: 90 days parts + labor on all repairs (standard, no upsell in v2)

**Eligible appliances (for system prompt):**
Refrigerators, Freezers, Washers, Dryers, Dishwashers, Ovens/Ranges/Stoves, Cooktops, Built-in/over-range Microwaves, Wine Coolers, Built-in Ice Makers, Garbage Disposals, Trash Compactors, Hood Vents/Range Hoods, HVAC Units, Commercial Kitchen Equipment.

**Ineligible appliances (for system prompt):**
Countertop microwaves, Coffee makers, Stand mixers, Blenders/Toasters, Vacuum cleaners, Portable air conditioners, Dehumidifiers, Small personal appliances.

---

## Сценарии поведения

### Сценарий 1: Полный квалифицированный звонок → бронь слота → лид в CRM

**Предусловия:**
- VAPI ассистент "Lead Qualifier v2" развёрнут и назначен на SIP номер
- `VAPI_TOOLS_SECRET` совпадает на сервере и в конфиге ассистента
- `VITE_GOOGLE_MAPS_API_KEY` установлен
- `ZENBOOKER_API_KEY` установлен
- В `service_territories` есть записи для company_id = DEFAULT

**Входные данные (от VAPI):**
```json
{
  "message": {
    "type": "tool-calls",
    "toolCallList": [
      { "id": "tc_001", "function": { "name": "checkServiceArea", "arguments": "{\"zip\":\"02101\"}" } }
    ],
    "call": { "customer": { "number": "+16175551234" } }
  }
}
```

**Шаги:**

1. Звонящий дозванивается → VAPI произносит `firstMessage`: *"Hi, this is Alex from ABC Homes Appliance Repair! How can I help you today?"*
2. Звонящий описывает проблему с холодильником Samsung.
3. **checkServiceArea**: ассистент запрашивает zip. Звонящий говорит "02101". VAPI вызывает `POST /api/vapi-tools` с `checkServiceArea({ zip: "02101" })`.
   - `vapiSecretAuth` проверяет `x-vapi-secret` header → OK
   - `stQueries.search(DEFAULT_COMPANY_ID, "02101")` → возвращает `{ zip: "02101", area: "Boston", city: "Boston", state: "MA" }`
   - Response: `{ inServiceArea: true, area: "Boston", city: "Boston", state: "MA", zip: "02101" }`
   - Ассистент: *"Great, we do serve the Boston area!"*
4. Ассистент объясняет $95 service call fee → звонящий соглашается.
5. Ассистент собирает: unit = "Refrigerator", brand = "Samsung", age = "~5 years", problem = "not cooling, making noise".
6. Ассистент применяет objection handling / NLP / marketing техники по необходимости.
7. Ассистент собирает: name = "John Smith", phone подтверждает "+16175551234", address = "45 Tremont St, Apt 3, Boston, MA 02108".
8. **validateAddress**: VAPI вызывает `POST /api/vapi-tools` с `validateAddress({ street: "45 Tremont St", apt: "3", city: "Boston", state: "MA", zip: "02108" })`.
   - Google Maps Geocoding API: `GET https://maps.googleapis.com/maps/api/geocode/json?address=45+Tremont+St,+Boston,+MA+02108&key=VITE_GOOGLE_MAPS_API_KEY`
   - Возвращает: `{ valid: true, standardized: "45 Tremont St Apt 3, Boston, MA 02108", correctedZip: "02108", lat: 42.357, lng: -71.059 }`
   - Ассистент: *"Just to confirm — that's 45 Tremont Street, Apartment 3, Boston, MA 02108, is that right?"*
9. **checkAvailability**: VAPI вызывает `POST /api/vapi-tools` с `checkAvailability({ zip: "02108", unitType: "Refrigerator" })`.
   - Handler вызывает `scheduleService.getAvailableSlots(DEFAULT_COMPANY_ID, { days: 5, slotDurationMin: 120, maxSlots: 3 })`
   - scheduleService читает `dispatch_settings` (рабочие часы/дни) + занятые items (jobs/leads/tasks) из БД Blanc
   - Форматирует до 3 ближайших свободных слота в `label` строки
   - Response: `{ slots: [{ date: "2026-06-10", label: "Tuesday, June 10th between 10am and 1pm", ... }, ...] }`
   - Ассистент: *"Would Tuesday the 10th between 10am and 1pm, or Thursday the 12th between 2 and 5pm work better for you?"*
10. Звонящий выбирает вторник.
11. **createLead**: VAPI вызывает `POST /api/vapi-tools` с полным payload.
    - `leadsService.createLead(body, DEFAULT_COMPANY_ID)` → `{ uuid: "lead-uuid-...", ... }`
    - Response: `{ success: true, leadId: "lead-uuid-..." }`
    - Ассистент: *"Perfect — I've got everything. Our scheduling team will send you a confirmation, and our tech will call before arriving."*
12. Звонок завершается.

**Ожидаемый результат:**
- Лид создан в БД с `job_source = "AI Phone"`, `JobType = "Refrigerator Repair"`
- Comments: `Unit: Refrigerator | Brand: Samsung | Age: ~5 years | Problem: not cooling, making noise | Fee agreed: Yes | Slot: Tuesday, June 10th between 10am and 1pm | Address validated: yes`
- Звонок завершён корректно

---

### Сценарий 2: Дисквалификация — неподходящий аппарат

**Шаги:**
1. Звонящий описывает неисправную кофемашину Keurig.
2. Ассистент определяет тип → "Coffee maker" ∈ ineligible_appliances.
3. Ассистент: *"We specialize in major built-in appliances — unfortunately that one isn't something we service. I'm sorry I can't help!"*
4. Звонок завершается.

**Ожидаемый результат:** `checkServiceArea` и `createLead` не вызываются. Никаких записей в БД.

---

### Сценарий 3: Дисквалификация — вне зоны обслуживания

**Шаги:**
1. Аппарат подходит → ассистент запрашивает zip.
2. Звонящий говорит "03801" (Portsmouth, NH — вне зоны обслуживания).
3. `checkServiceArea({ zip: "03801" })` → `{ inServiceArea: false }`.
4. Ассистент: *"I'm sorry, we don't currently cover your area."*
5. Звонок завершается.

**Ожидаемый результат:** `createLead` не вызывается.

---

### Сценарий 4: Адрес не валидируется (2 попытки) → лид всё равно создаётся

**Шаги:**
1. Звонящий называет адрес → `validateAddress` возвращает `{ valid: false }`.
2. Ассистент просит повторить/уточнить.
3. Вторая попытка → снова `{ valid: false }`.
4. Ассистент продолжает с введённым адресом без блокировки.
5. `createLead` вызывается, Comments содержит `Address validated: no`.

**Ожидаемый результат:** Лид создан несмотря на неуспешную валидацию адреса.

---

### Сценарий 5: validateAddress возвращает другой zip → повторная проверка зоны

**Шаги:**
1. Zip из квалификации: "02101" → `inServiceArea: true`.
2. Адрес введён "123 Main St, Quincy, MA 02169" → `validateAddress` → `correctedZip: "02169"`.
3. Ассистент повторно вызывает `checkServiceArea({ zip: "02169" })`.
4. Если `inServiceArea: false` → дисквалификация.

---

### Сценарий 6: Звонящий не может выбрать слот

**Шаги:**
1. Квалификация, сбор данных, адрес — всё ОК.
2. `checkAvailability` возвращает слоты. Звонящий: *"I need to check with my wife first."*
3. Ассистент: *"No problem — I'll make a note and our scheduling team will call you back."*
4. `createLead` вызывается с `preferredSlot: null`, Comments: `Slot: pending callback`.

**Ожидаемый результат:** Лид создан со статусом для callback.

---

### Сценарий 7: Звонящий требует живого человека

**Шаги:**
1. Звонящий: *"Let me speak to a real person."*
2. Ассистент (1 retention попытка): *"I completely understand — let me see if I can help you directly. What's the main thing you're trying to get sorted?"*
3. Звонящий снова: *"No, I want a real person."*
4. Ассистент подтверждает номер телефона.
5. `createLead` вызывается, Comments содержит `escalation_requested: true`.
6. Ассистент: *"Of course — someone from our team will call you back shortly."*

**Ожидаемый результат:** Лид создан с флагом эскалации.

---

### Сценарий 8: checkAvailability — нет доступных слотов

**Шаги:**
1. `zenbookerClient.getTimeslots(...)` возвращает пустой массив.
2. Handler возвращает `{ slots: [], error: "No availability found in the next 5 days" }`.
3. Ассистент: *"It looks like our schedule is quite full right now. Our scheduling team will call you back to find a time that works."*
4. `createLead` с `preferredSlot: null`, Comments: `Slot: no availability, team to call back`.

---

### Сценарий 9: createLead API failure (retry)

**Шаги:**
1. `leadsService.createLead()` throws on first call.
2. Handler waits 2 seconds, retries once.
3. Если второй вызов тоже падает — возвращает `{ success: false, error: "..." }`, логирует ошибку.
4. Ассистент не информирует звонящего об ошибке. Продолжает к Close.

**Ожидаемый результат:** Ошибка в логах, звонок завершается корректно.

---

### Сценарий 10: time-limited offer trigger (FR-5.2)

**Предусловие:** Текущее время ET < 14:00.
**Шаги:**
1. Звонящий колеблется после согласия на $95.
2. Ассистент: *"If we confirm before 2 o'clock, our dispatcher can get the part ordered today — that usually means we wrap up in one visit instead of two."*

**Предусловие:** Текущее время ET ≥ 14:00.
**Шаги:** Триггер не срабатывает. Другие техники убеждения применяются (FR-5.1, FR-5.3).

---

## Граничные случаи

1. **zip в `checkServiceArea` — не 5 цифр** → `stQueries.search` обрабатывает через `search()` (пробует city/area матч); если не найдено — `{ inServiceArea: false }`. Ассистент переспрашивает zip.
2. **Caller name не дан** → `firstName: "Unknown"`, `lastName: "Caller"` в `createLead`.
3. **Phone number не собран** → `createLead` возвращает `{ success: false, error: "Phone number is required" }`. Ассистент не создаёт лид, просит подтвердить номер. Телефон берётся из `message.call.customer.number` VAPI payload — ассистент подтверждает его устно.
4. **VAPI отправляет `status-update` или `end-of-call-report`** → handler возвращает `{}` без обработки (не tool-calls тип).
5. **Параллельные tool calls в одном запросе** → обрабатываются последовательно в цикле, все результаты возвращаются в одном ответе.
6. **`arguments` в tool call — строка JSON** → парсится; если невалидный JSON → пустой объект `{}`, обработчик получает пустые параметры.
7. **Google Maps API rate limit / timeout** → `handleValidateAddress` catches, возвращает `{ valid: false }`. Лид не блокируется. Max 2 попытки валидации адреса перед тем как продолжить.
8. **Blanc scheduleService error в `checkAvailability`** → возвращает `{ slots: [], error: "Unable to check schedule" }`. Ассистент предлагает callback.
9. **`maxDurationSeconds: 900` достигнут** → VAPI завершает звонок. Если `createLead` уже был вызван — лид в БД. Если нет — лид потерян (не блокирующий риск для v2).
10. **validateAddress correctedZip ≠ qualification zip** → ассистент обязан повторно вызвать `checkServiceArea` с `correctedZip`. Если `inServiceArea: false` — дисквалификация, `createLead` не вызывается.
11. **Caller запрашивает живого человека** → 1 retention attempt, затем callback: вызвать `createLead` с `escalationRequested: true`, закрыть звонок. Warm transfer — v3.
12. **Warranty — trust-builder** → Ответ на ценовые возражения должен включать: *"Every repair comes with a 90-day parts and labor warranty — if anything comes back, we fix it at no charge."* Никакого upsell в v2.
13. **Time-limited offer (14:00 ET cutoff)** → Ассистент получает текущее время через VAPI variable injection в system prompt. Если время ≥ 14:00 ET — ассистент не упоминает дедлайн заказа парта. Другие техники убеждения (FOMO, scarcity) применяются без ограничения по времени.

---

## Обработка ошибок

| Ошибка | Реакция системы | Реакция ассистента |
|---|---|---|
| `VAPI_TOOLS_SECRET` не совпадает | `401 Unauthorized` | VAPI повторяет попытку или завершает tool call с ошибкой |
| `checkServiceArea` — DB error | `{ inServiceArea: false, error: "..." }` | Ассистент говорит что не может проверить зону, предлагает callback |
| `validateAddress` — Google error | `{ valid: false }` | Ассистент переспрашивает адрес (1 раз), затем продолжает без валидации |
| `checkAvailability` — scheduleService error | `{ slots: [], error: "..." }` | Ассистент предлагает callback от команды scheduling |
| `createLead` — ошибка после retry | `{ success: false, error: "..." }` | Ассистент не сообщает звонящему; звонок завершается как обычно; ошибка в логах |
| `createLead` — phone < 5 chars | `{ success: false, error: "Phone required" }` | Ассистент просит подтвердить номер |

---

## Взаимодействие компонентов

```
VAPI Platform
    │  POST /api/vapi-tools
    │  Headers: x-vapi-secret: <VAPI_TOOLS_SECRET>
    │  Body: { message: { type: "tool-calls", toolCallList: [...] } }
    ▼
vapiSecretAuth (middleware)
    │
    ▼
Router dispatcher (switch on function.name)
    ├── "checkServiceArea"  → handleCheckServiceArea
    │       └── stQueries.search(DEFAULT_COMPANY_ID, zip)
    │                └── PostgreSQL: service_territories WHERE company_id AND (zip OR city)
    │
    ├── "validateAddress"   → handleValidateAddress
    │       └── Google Maps Geocoding API (server-side)
    │                └── https://maps.googleapis.com/maps/api/geocode/json
    │
    ├── "checkAvailability" → handleCheckAvailability
    │       ├── scheduleService.getAvailableSlots(companyId, { days, slotDurationMin })
    │       └── — dispatches to scheduleService.getAvailableSlots
    │                └── PostgreSQL: dispatch_settings + schedule items (jobs/leads/tasks)
    │
    └── "createLead"        → handleCreateLead
            └── leadsService.createLead(body, DEFAULT_COMPANY_ID)
                     └── PostgreSQL: INSERT INTO leads
```

---

## API Contracts

### `POST /api/vapi-tools`

**Auth:** `x-vapi-secret` header (value = `VAPI_TOOLS_SECRET` env var). No `authenticate`/`requireCompanyAccess` — public endpoint secured by shared secret.

**Request:**
```json
{
  "message": {
    "type": "tool-calls",
    "toolCallList": [
      {
        "id": "string",
        "function": {
          "name": "checkServiceArea | validateAddress | checkAvailability | createLead",
          "arguments": "JSON string or object"
        }
      }
    ]
  }
}
```

**Response (success):**
```json
{
  "results": [
    { "toolCallId": "string", "result": "JSON string" }
  ]
}
```

**Response (non tool-calls message type):**
```json
{}
```

**Errors:**
- `401` — wrong or missing `x-vapi-secret`
- `500` — unhandled exception in outer try/catch

#### Tool: `checkServiceArea`
```
Input:  { zip: string }
Output: { inServiceArea: boolean, area?: string, city?: string, state?: string, zip?: string, error?: string }
```

#### Tool: `validateAddress`
```
Input:  { street: string, apt?: string, city?: string, state?: string, zip?: string }
Output: { valid: boolean, standardized?: string, correctedZip?: string, lat?: number, lng?: number }
Never throws — always returns object.
Address validation max attempts: 2. On second failure — proceed with entered address, flag as unvalidated.
```

#### Tool: `checkAvailability`
```
Input:  { zip: string, unitType?: string, days?: number }
        days defaults to 5 if not provided
Output: { slots: Array<{ date: string, label: string, start: string, end: string }>, error?: string }
        duration hardcoded to 120 minutes
        date starts from today (ET timezone)
        max 3 slots returned
        label format: "Tuesday, June 10th between 10am and 1pm" (ET timezone, human-readable)
```

#### Tool: `createLead`
```
Input:  {
  firstName: string,          -- required
  lastName: string,           -- required
  phone: string,              -- required (from call metadata or collected; min 5 chars)
  email?: string,             -- optional (collected if caller provided)
  zip?: string,
  city?: string,
  state?: string,
  unitType?: string,
  brand?: string,
  unitAge?: string,           -- if unknown, omit (will default to "unknown" in Comments)
  problemDescription?: string,
  preferredSlot?: string,     -- if null/omitted → "pending callback" in Comments
  addressValidated?: boolean, -- false if validateAddress failed; defaults to false
  escalationRequested?: boolean -- true if caller requested human agent
}
Output: { success: boolean, leadId?: string, error?: string }

Retry policy: on failure, wait 2 seconds, retry once. After 2 failures: return { success: false, error }.
Never throw — always return object. Never inform caller of failure.

CRM field mapping:
  FirstName       ← firstName (or "Unknown" if missing)
  LastName        ← lastName (or "Caller" if missing)
  Phone           ← phone (E.164 normalized by leadsService)
  Email           ← email (if provided)
  JobType         ← "{unitType} Repair" or "Appliance Repair"
  JobSource       ← "AI Phone" (HARDCODED — never override)
  City            ← city
  State           ← state
  PostalCode      ← zip
  Comments        ← buildCallSummary (see below)

Comments template:
  "Unit: {unitType} | Brand: {brand} | Age: {unitAge|'unknown'} | Problem: {problemDescription} | Fee agreed: Yes | Slot: {preferredSlot|'pending callback'} | Address validated: {addressValidated ? 'yes' : 'no'}{escalationRequested ? ' | escalation_requested: true' : ''}"
```

---

## Безопасность и изоляция данных

- Endpoint намеренно публичный — VAPI делает server-to-server вызовы без сессии пользователя
- Единственный механизм защиты: `x-vapi-secret` shared secret
- Все DB запросы используют `DEFAULT_COMPANY_ID` — single-tenant deployment
- `VITE_GOOGLE_MAPS_API_KEY` — backend only, никогда не `VITE_*`
- При отсутствии `VAPI_TOOLS_SECRET` в env — dev-mode warning, пропускает auth (только local dev)
