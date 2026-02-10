```yaml
project:
  name: "Twilio Call Viewer — Leads tab (Workiz-like)"
  goal: "Сделать вкладку Leads в текущем приложении просмотра звонков, максимально похожую на страницу Leads в Workiz, с базовой CRUD/статусной логикой и быстрыми действиями."
  scope_level: "MVP -> Iteration"
  primary_user: "диспетчер/владелец (оператор), который обрабатывает входящие звонки и создает/обновляет лиды в Workiz"

integrations:
  system_of_record: "Workiz Leads API"
  auth:
    method: "auth_secret (передается в body для POST-эндпоинтов)"
    storage: "server-side secret only"
  endpoints:
    list:
      method: "GET"
      path: "/lead/all/"
      params:
        start_date: "yyyy-MM-dd (from start_date until today)"
        offset: "integer (default 0)"
        records: "integer (max 100, default 100)"
        only_open: "boolean (default true)"
        status: "array[string]"
    details:
      method: "GET"
      path: "/lead/get/{UUID}/"
    create:
      method: "POST"
      path: "/lead/create/"
      body_requires: ["auth_secret"]
    update:
      method: "POST"
      path: "/lead/update/"
      body_requires: ["auth_secret", "UUID"]
    mark_lost:
      method: "POST"
      path: "/lead/markLost/{UUID}/"
      body_requires: ["auth_secret"]
    activate:
      method: "POST"
      path: "/lead/activate/{UUID}/"
      body_requires: ["auth_secret"]
    assign:
      method: "POST"
      path: "/lead/assign/"
      body_requires: ["auth_secret", "UUID", "User"]
    unassign:
      method: "POST"
      path: "/lead/unassign/"
      body_requires: ["auth_secret", "UUID", "User"]
    convert_to_job:
      method: "POST"
      path: "/lead/convert/"
      body_requires: ["auth_secret", "UUID"]

ui:
  placement:
    app: "current call viewer"
    tab_name: "Leads"
  layout:
    split_view: true
    left: "таблица/список лидов"
    right: "панель деталей выбранного лида (drawer/side panel)"
  main_list_columns:
    - "LeadDateTime (scheduled)"
    - "Status"
    - "Name (FirstName + LastName / Company)"
    - "Phone"
    - "City/State"
    - "JobType"
    - "JobSource"
    - "Assigned (Team/User)"
    - "SerialId"
  row_actions:
    - "Open details"
    - "Call (tel:) / copy phone"
    - "Mark lost / Activate"
    - "Convert to Job"
  detail_actions:
    - "Edit lead"
    - "Assign / Unassign"
    - "Change Status"
    - "Mark Lost / Activate"
    - "Convert to Job"
    - "Open in Workiz (link from API responses when available)"
  filters:
    - "Date range: start_date (preset Today/7d/30d + custom)"
    - "Only open toggle (only_open)"
    - "Status multi-select (status[])"
    - "Search (client-side): name/phone/email/company/SerialId"
  pagination:
    type: "offset-based"
    page_size: 100
    controls:
      - "Next/Prev (offset += records)"
      - "Load more (optional)"
  states:
    loading: "skeleton table + spinner in side panel"
    empty: "no leads found + tips to change filters"
    error: "toast + retry + show correlation id"
    optimistic_updates: "for status/assign actions with rollback on error"

backend:
  approach: "Create a Workiz proxy service (server-side) to protect auth_secret and normalize API"
  responsibilities:
    - "store auth_secret in env"
    - "call Workiz API"
    - "normalize responses (Workiz often returns arrays)"
    - "validate inputs"
    - "rate limit + retry with backoff"
    - "cache list queries (short TTL) to reduce load"
  proposed_internal_routes:
    - "GET /api/leads?start_date=&offset=&records=&only_open=&status="
    - "GET /api/leads/:uuid"
    - "POST /api/leads (create)"
    - "PATCH /api/leads/:uuid (update fields)"
    - "POST /api/leads/:uuid/mark-lost"
    - "POST /api/leads/:uuid/activate"
    - "POST /api/leads/:uuid/assign"
    - "POST /api/leads/:uuid/unassign"
    - "POST /api/leads/:uuid/convert"
  mapping_notes:
    list_response_shape: "Workiz returns array of lead objects; wrap into {results, offset, records, has_more}"
    detail_response_shape: "Workiz returns array with one object; unwrap to single Lead"

data_model:
  lead_fields_core:
    identity: ["UUID", "SerialId", "ClientId"]
    timing: ["LeadDateTime", "LeadEndDateTime", "CreatedDate", "Timezone"]
    status: ["Status", "SubStatus", "LeadLost", "PaymentDueDate"]
    contact: ["FirstName", "LastName", "Company", "Phone", "PhoneExt", "SecondPhone", "SecondPhoneExt", "Email"]
    address: ["Address", "Unit", "City", "State", "PostalCode", "Country", "Latitude", "Longitude"]
    meta: ["JobType", "ReferralCompany", "JobSource", "LeadNotes", "Comments", "Team"]
  normalization:
    phone: "store raw + formatted E.164 when possible (client-side formatting)"
    datetime: "store ISO string; display in user's timezone (America/New_York) but respect lead.Timezone if provided"
  list_sort:
    default: "LeadDateTime desc (as Workiz)"

security:
  secrets:
    - "auth_secret never goes to frontend"
  logging:
    - "do not log PII fully (mask phone/email in info logs)"
  permissions:
    - "MVP: any authenticated app user can view/update leads"
    - "future: role-based (dispatcher/admin/tech)"

testing:
  unit:
    - "Workiz response unwrapping/normalization"
    - "query builder for list endpoint"
  integration:
    - "happy path list/details/create/update"
    - "mark lost / activate / assign / convert"
  ui:
    - "table rendering + filters"
    - "optimistic updates rollback"
    - "pagination offset correctness"

milestones:
  - id: "M1"
    name: "Read-only Leads tab"
    deliverables:
      - "Leads tab UI with table"
      - "Filters (date, only_open, status) + client-side search"
      - "Details side panel"
  - id: "M2"
    name: "Edit + actions"
    deliverables:
      - "Create lead modal"
      - "Edit lead form"
      - "Mark lost/activate + convert to job"
  - id: "M3"
    name: "Assignment + UX polish"
    deliverables:
      - "Assign/unassign user"
      - "Bulk actions (optional)"
      - "Caching, performance, telemetry"
```

# План и требования: вкладка **Leads** (аналог Workiz)

## 1) Цель и UX-идея
Сделать в текущем приложении просмотра звонков отдельную вкладку **“Leads”**, которая позволяет:
- быстро увидеть список лидов (как в Workiz),
- открыть детали лида справа,
- выполнить ключевые действия: **создать / обновить / сменить статус / lost/activate / assign/unassign / convert to job**,
- быстро звонить/копировать номер и переходить в Workiz по ссылке (если доступна).

## 2) Экран “Leads”: структура

### 2.1 Список лидов (таблица)
**Обязательное (MVP):**
- Сортировка: `LeadDateTime desc` (как у Workiz)
- Колонки:
  - `LeadDateTime` (scheduled)
  - `Status`
  - `Name` (First+Last или Company)
  - `Phone`
  - `City/State`
  - `JobType`
  - `JobSource`
  - `Assigned` (Team/User)
  - `SerialId`

**Действия в строке:**
- открыть детали
- call/copy phone
- mark lost / activate
- convert to job

### 2.2 Панель деталей (справа)
Показывать:
- статус + substatus
- контактные данные
- адрес
- заметки/комменты
- метаданные (JobType, JobSource, ReferralCompany, CreatedDate)
- назначение (Team/User)

Кнопки:
- Edit
- Assign / Unassign
- Mark Lost / Activate
- Convert to Job
- Open in Workiz (если есть `link` в ответах на create/update/convert)

## 3) Фильтры и поиск

### 3.1 Серверные фильтры (через Workiz API)
- `start_date` (пресеты: Today / Last 7 days / Last 30 days + custom)
- `only_open` (toggle, default true)
- `status[]` (multi-select)

### 3.2 Клиентский поиск (быстрый)
По полям:
- `FirstName`, `LastName`, `Company`
- `Phone`, `Email`
- `SerialId`

## 4) Пагинация
Workiz использует `offset` + `records` (макс 100).
- page_size = 100
- UI: Next/Prev или “Load more”
- Логика `has_more`: если вернулось ровно `records`, то вероятно есть следующая страница.

## 5) Архитектура интеграции (важно)
**Не дергать Workiz напрямую из фронта** из-за `auth_secret`.

### 5.1 Серверный proxy (обязателен)
Внутренний API вашего проекта:
- `GET /api/leads` → Workiz `GET /lead/all/`
- `GET /api/leads/:uuid` → Workiz `GET /lead/get/{UUID}/`
- `POST /api/leads` → Workiz `POST /lead/create/`
- `PATCH /api/leads/:uuid` → Workiz `POST /lead/update/`
- `POST /api/leads/:uuid/mark-lost` → Workiz `POST /lead/markLost/{UUID}/`
- `POST /api/leads/:uuid/activate` → Workiz `POST /lead/activate/{UUID}/`
- `POST /api/leads/:uuid/assign` → Workiz `POST /lead/assign/`
- `POST /api/leads/:uuid/unassign` → Workiz `POST /lead/unassign/`
- `POST /api/leads/:uuid/convert` → Workiz `POST /lead/convert/`

### 5.2 Нормализация ответов Workiz
Workiz часто возвращает **массив** даже для одного объекта.
- details: `[ { ...lead } ]` → распаковать в `{ ...lead }`
- create/update/convert: `[ { flag, data: [ { UUID, ClientId, link } ] } ]` → привести к `{ok, uuid, clientId, link}`

## 6) Поведение при действиях (UX)
- Для быстрых действий (lost/activate/assign) сделать **optimistic UI**:
  - сразу обновить статус в таблице,
  - если API вернул ошибку — откатить и показать toast.
- Все ошибки показывать понятно + действие “Retry”.

## 7) Нефункциональные требования
- Производительность: кешировать список лидов на сервере кратко (например 10–30 сек) по ключу фильтров
- Логи: маскировать PII (телефон/email) в обычных логах
- Безопасность: `auth_secret` только на сервере
- Тесты: минимум unit для нормализации + интеграционные для основных эндпоинтов

## 8) План релизов (по шагам)

### M1 — Read-only Leads
- вкладка Leads
- список + фильтры + пагинация
- детали справа
- call/copy phone

### M2 — Create/Edit + статусные действия
- create lead modal
- edit lead form
- mark lost / activate
- convert to job

### M3 — Assignment + полировка
- assign/unassign
- улучшение кеша/телеметрии
- bulk actions (если понадобится)
