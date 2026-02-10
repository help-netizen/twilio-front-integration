---
title: "Техническое ТЗ: Leads (Workiz-like) для Call Viewer — детальный прототип UI + API-контракт"
spec_id: "CV-LEADS-002"
version: "2.0.0"
status: "Ready for implementation"
date: "2026-02-09"
language: "ru"
owners:
  product: "Robert"
  tech: "Backend + Frontend"
feature_flag:
  key: "FEATURE_LEADS_TAB"
  default: false
  rollout: "dev -> staging -> production"
---

# Техническое ТЗ для разработчика
## Вкладка **Leads** в текущем приложении просмотра звонков

Документ ниже — финальная версия, чтобы команда могла **сразу кодить**: есть детальный прототип компонентов UI и точные контракты внутренних API.

---

## 1) Цели и объем

### 1.1 Бизнес-цель
Сделать вкладку **Leads** внутри текущего call viewer, чтобы оператор мог:
- видеть и фильтровать лиды;
- открывать детали;
- создавать и редактировать лиды;
- выполнять быстрые действия (lost/activate/assign/unassign/convert);
- работать без перехода в Workiz (кроме optional перехода по ссылке).

### 1.2 Scope (MVP)
1. Список лидов + фильтры + пагинация.
2. Drawer с деталями выбранного лида.
3. Create Lead modal.
4. Edit Lead modal.
5. Actions: mark lost, activate, assign, unassign, convert.
6. Внутренний proxy API для Workiz.

### 1.3 Out of scope
- Webhooks и realtime-синк.
- Сложный RBAC (минимум: авторизованный пользователь).
- Bulk-edit нескольких лидов (можно отдельной задачей).

---

## 2) Архитектура и принципы

### 2.1 Поток данных
`Frontend (Leads tab)` -> `Internal API (/api/leads...)` -> `Workiz API`

### 2.2 Почему обязательно через backend
- `auth_secret` хранится только на сервере.
- Workiz часто возвращает массивы; backend делает нормализацию.
- Централизация валидации, retry/backoff, маскировки логов.

### 2.3 Единый формат ответа внутреннего API

#### Success envelope
```json
{
  "ok": true,
  "data": {},
  "meta": {
    "request_id": "req_01HT...",
    "timestamp": "2026-02-09T20:00:00.000Z"
  }
}
```

#### Error envelope
```json
{
  "ok": false,
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "status must be an array of strings",
    "details": null,
    "correlation_id": "req_01HT..."
  }
}
```

---

## 3) Детальный прототип UI-компонентов

## 3.1 Компоновка вкладки Leads

### Desktop (>= 1280px)
- Верх: `LeadsFiltersBar`
- Центр: 2-колоночный layout:
  - Левая зона (70%): `LeadsTable`
  - Правая зона (30%): `LeadDetailsDrawer` (sticky)

### Tablet (768–1279px)
- Filters сверху
- Таблица на всю ширину
- Drawer открывается overlay справа

### Mobile (<768px)
- Filters collapsible
- Список карточками (упрощенный `LeadsTable`)
- Детали в full-screen drawer

---

## 3.2 Компонент `LeadsTable`

### 3.2.1 Props контракт
```ts
type LeadsTableProps = {
  rows: Lead[];
  loading: boolean;
  selectedLeadUUID: string | null;
  sort: { field: "LeadDateTime" | "Status" | "SerialId"; dir: "asc" | "desc" };
  onSortChange: (field: string) => void;
  onRowClick: (uuid: string) => void;
  onAction: (action: LeadRowAction, lead: Lead) => void;
  pagination: {
    offset: number;
    records: number;
    returned: number;
    has_more: boolean;
  };
  onNextPage: () => void;
  onPrevPage: () => void;
};

type LeadRowAction =
  | "OPEN"
  | "CALL"
  | "COPY_PHONE"
  | "MARK_LOST"
  | "ACTIVATE"
  | "CONVERT";
```

### 3.2.2 Колонки (точная спецификация)

| key | label | width | sortable | render rule | fallback |
|---|---|---:|:---:|---|---|
| LeadDateTime | Scheduled | 180 | ✅ | format `MMM d, yyyy HH:mm` | `—` |
| Status | Status | 140 | ✅ | badge by status | `Unknown` |
| Name | Name | 220 | ❌ | `FirstName + LastName` else `Company` | `No name` |
| Phone | Phone | 160 | ❌ | primary phone + ext | `—` |
| CityState | City/State | 160 | ❌ | `City, State` | `—` |
| JobType | Job Type | 140 | ❌ | plain text | `—` |
| JobSource | Source | 140 | ❌ | plain text | `—` |
| Assigned | Assigned | 180 | ❌ | join `Team[].name` | `Unassigned` |
| SerialId | # | 90 | ✅ | numeric | `—` |
| Actions | Actions | 140 | ❌ | row menu + quick icons | `—` |

### 3.2.3 Поведение
- Click row -> открыть детали в drawer + выделить строку.
- Double click row -> открыть `EditLeadModal`.
- Keyboard:
  - Up/Down — смена выделенной строки.
  - Enter — открыть детали.
- Sticky header.
- При `loading=true` — скелетоны 8 строк.

### 3.2.4 Пустые/ошибочные состояния
- Empty state: «Лиды не найдены. Измените фильтры или дату».
- Error state: inline alert + кнопка Retry.

---

## 3.3 Компонент `LeadsFiltersBar`

### 3.3.1 Поля
1. `Date range preset`
   - values: `today | last7 | last30 | custom`
   - в API отправляется `start_date`.
2. `start_date` (date input, используется для custom).
3. `only_open` (toggle, default true).
4. `status[]` (multi-select).
5. `search` (client-side, debounce 300ms, по name/phone/email/company/serial).

### 3.3.2 Props контракт
```ts
type LeadsFilters = {
  start_date?: string; // YYYY-MM-DD
  only_open: boolean;
  status: string[];
  search: string;
};

type LeadsFiltersBarProps = {
  value: LeadsFilters;
  statusOptions: string[];
  loading: boolean;
  onChange: (next: LeadsFilters) => void;
  onApply: () => void;
  onReset: () => void;
};
```

### 3.3.3 Поведение
- `Apply` -> reset pagination offset=0 -> reload list.
- `Reset` -> `start_date=today`, `only_open=true`, `status=[]`, `search=""`.
- `search` не отправлять в backend (MVP), фильтровать клиентски по загруженным rows.

---

## 3.4 Компонент `LeadDetailsDrawer`

### 3.4.1 Секции
1. Header:
   - Name/Company
   - Status + SubStatus
   - SerialId + UUID (copy)
2. Contact:
   - Phone, SecondPhone, Email
3. Address:
   - Address, Unit, City, State, PostalCode, Country
   - map link (если lat/lng есть)
4. Job info:
   - JobType, JobSource, ReferralCompany, Timezone
5. Notes:
   - LeadNotes, Comments
6. Team:
   - назначенные пользователи
7. Timeline:
   - LeadDateTime, LeadEndDateTime, CreatedDate

### 3.4.2 Actions в drawer
- `Edit`
- `Assign`
- `Unassign`
- `Mark lost` / `Activate` (в зависимости от текущего состояния)
- `Convert to job`
- `Open in Workiz` (если есть WorkizLink)

### 3.4.3 Props контракт
```ts
type LeadDetailsDrawerProps = {
  lead: Lead | null;
  loading: boolean;
  onEdit: (lead: Lead) => void;
  onAssign: (lead: Lead) => void;
  onUnassign: (lead: Lead) => void;
  onMarkLost: (lead: Lead) => void;
  onActivate: (lead: Lead) => void;
  onConvert: (lead: Lead) => void;
  onRefresh: () => void;
};
```

---

## 3.5 `CreateLeadModal` и `EditLeadModal`

### 3.5.1 Общие требования
- Единая форма-компонент `LeadForm`.
- Режимы: `create | edit`.
- `Create`: required поля строже.
- `Edit`: отправлять только измененные поля (PATCH-like behavior через backend).

### 3.5.2 Поля формы (детально)

| Field | Type | Required Create | Required Edit | Validation |
|---|---|:---:|:---:|---|
| LeadDateTime | datetime | ✅ | ❌ | valid ISO datetime |
| LeadEndDateTime | datetime | ❌ | ❌ | >= LeadDateTime |
| FirstName | text | ✅ | ❌ | 1..80 |
| LastName | text | ✅ | ❌ | 1..80 |
| Company | text | ❌ | ❌ | <=120 |
| Phone | tel | ✅ | ❌ | min 5 chars |
| PhoneExt | text | ❌ | ❌ | <=10 |
| SecondPhone | tel | ❌ | ❌ | min 5 chars |
| SecondPhoneExt | text | ❌ | ❌ | <=10 |
| Email | email | ❌ | ❌ | RFC-like email |
| Address | text | ❌ | ❌ | <=200 |
| Unit | text | ❌ | ❌ | <=20 |
| City | text | ❌ | ❌ | <=80 |
| State | text | ❌ | ❌ | <=80 |
| PostalCode | text | ❌ | ❌ | <=20 |
| Country | text | ❌ | ❌ | ISO alpha-2 preferred |
| JobType | text/select | ❌ | ❌ | <=80 |
| JobSource | text/select | ❌ | ❌ | <=80 |
| ReferralCompany | text | ❌ | ❌ | <=120 |
| Timezone | text/select | ❌ | ❌ | IANA tz |
| LeadNotes | textarea | ❌ | ❌ | <=4000 |
| Status | select | ❌ | ❌ | non-empty string |
| Tags | multiselect | ❌ | ❌ | string[] |

### 3.5.3 Модальные сценарии
- Create:
  1) open modal;
  2) заполнение;
  3) submit -> POST /api/leads;
  4) success: toast + close + reload list + select new lead.
- Edit:
  1) open from row/drawer;
  2) prefill;
  3) submit changed fields -> PATCH /api/leads/{uuid};
  4) success: toast + close + refresh list/drawer.

### 3.5.4 Защита от потери данных
- Если форма dirty и user нажимает close -> confirm dialog.

---

## 4) Контракт внутренних API (точные параметры и shape)

## 4.1 Types (референс для фронта)

```ts
export type Lead = {
  UUID: string;
  SerialId?: number | null;
  LeadDateTime?: string | null;
  LeadEndDateTime?: string | null;
  CreatedDate?: string | null;
  ClientId?: number | string | null;
  Status: string;
  SubStatus?: string | null;
  LeadLost?: number | boolean | null;
  PaymentDueDate?: string | null;

  Phone?: string | null;
  PhoneExt?: string | null;
  SecondPhone?: string | null;
  SecondPhoneExt?: string | null;
  Email?: string | null;

  FirstName?: string | null;
  LastName?: string | null;
  Company?: string | null;

  Address?: string | null;
  Unit?: string | null;
  City?: string | null;
  State?: string | null;
  PostalCode?: string | null;
  Country?: string | null;
  Latitude?: string | number | null;
  Longitude?: string | number | null;

  JobType?: string | null;
  ReferralCompany?: string | null;
  Timezone?: string | null;
  JobSource?: string | null;
  LeadNotes?: string | null;
  Comments?: string | null;

  Tags?: string[] | null;
  Team?: Array<{ id: string | number; name: string }> | null;
  WorkizLink?: string | null;
};

export type ApiSuccess<T> = {
  ok: true;
  data: T;
  meta: { request_id: string; timestamp: string };
};

export type ApiError = {
  ok: false;
  error: {
    code: string;
    message: string;
    details?: unknown;
    correlation_id: string;
  };
};
```

---

## 4.2 GET `/api/leads`

### Query params (точно)
- `start_date` (optional, string, формат `YYYY-MM-DD`)
- `offset` (optional, integer, default `0`, min `0`)
- `records` (optional, integer, default `100`, min `1`, max `100`)
- `only_open` (optional, boolean string: `true|false`, default `true`)
- `status` (optional, repeatable string param)
  - example: `?status=Submitted&status=In%20progress`

### Пример запроса
`GET /api/leads?start_date=2026-02-01&offset=0&records=100&only_open=true&status=Submitted&status=In%20progress`

### Response 200 shape
```json
{
  "ok": true,
  "data": {
    "results": [
      {
        "UUID": "XYZ56X",
        "SerialId": 795,
        "LeadDateTime": "2026-02-09T15:00:00.000Z",
        "Status": "Submitted",
        "FirstName": "Joe",
        "LastName": "Acme",
        "Phone": "6195555555",
        "City": "San Diego",
        "State": "CA",
        "JobType": "Repair",
        "JobSource": "Google",
        "Team": [{ "id": "35355", "name": "Oliver workiz" }]
      }
    ],
    "pagination": {
      "offset": 0,
      "records": 100,
      "returned": 1,
      "has_more": false
    },
    "filters": {
      "start_date": "2026-02-01",
      "only_open": true,
      "status": ["Submitted", "In progress"]
    }
  },
  "meta": {
    "request_id": "req_01H...",
    "timestamp": "2026-02-09T20:00:00.000Z"
  }
}
```

### Ошибки
- `400` INVALID_QUERY
- `502` UPSTREAM_ERROR
- `500` INTERNAL_ERROR

---

## 4.3 GET `/api/leads/{uuid}`

### Path params
- `uuid` (required, string)

### Response 200 shape
```json
{
  "ok": true,
  "data": {
    "lead": {
      "UUID": "XYZ56X",
      "SerialId": 795,
      "LeadDateTime": "2026-02-09T15:00:00.000Z",
      "LeadEndDateTime": "2026-02-09T16:00:00.000Z",
      "CreatedDate": "2026-02-08T12:30:00.000Z",
      "ClientId": 1002,
      "Status": "Submitted",
      "SubStatus": null,
      "Phone": "6195555555",
      "Email": "client@workiz.com",
      "FirstName": "Joe",
      "LastName": "Acme",
      "Address": "123 W Main Street",
      "City": "San Diego",
      "State": "CA",
      "PostalCode": "92109",
      "Country": "US",
      "JobType": "Repair",
      "JobSource": "Google",
      "LeadNotes": "Please call client before heading there...",
      "Timezone": "US/Pacific",
      "Team": [{ "id": "35355", "name": "Oliver workiz" }]
    }
  },
  "meta": {
    "request_id": "req_01H...",
    "timestamp": "2026-02-09T20:00:00.000Z"
  }
}
```

### Ошибки
- `400` INVALID_UUID
- `404` LEAD_NOT_FOUND
- `502` UPSTREAM_ERROR

---

## 4.4 POST `/api/leads` (Create)

### Request body
```json
{
  "LeadDateTime": "2026-02-10T14:00:00.000Z",
  "LeadEndDateTime": "2026-02-10T15:00:00.000Z",
  "ClientId": 1002,
  "Phone": "6195555555",
  "PhoneExt": "333",
  "SecondPhone": "6194444444",
  "SecondPhoneExt": "222",
  "Email": "client@workiz.com",
  "FirstName": "Joe",
  "LastName": "Acme",
  "Company": "Acme Inc",
  "Address": "123 W Main Street",
  "City": "San Diego",
  "State": "CA",
  "PostalCode": "92109",
  "Country": "US",
  "Unit": "#12",
  "JobType": "Repair",
  "ReferralCompany": "Thumbtack",
  "Timezone": "US/Pacific",
  "JobSource": "Google",
  "LeadNotes": "Please call client before heading there...",
  "CreatedBy": "Agent Name",
  "ServiceArea": "metro1"
}
```

### Response 201 shape
```json
{
  "ok": true,
  "data": {
    "UUID": "XYZ55Y",
    "ClientId": "1001",
    "link": "https://app.workiz.com/job/1HN2E0/"
  },
  "meta": {
    "request_id": "req_01H...",
    "timestamp": "2026-02-09T20:00:00.000Z"
  }
}
```

### Ошибки
- `400` VALIDATION_ERROR
- `422` UPSTREAM_VALIDATION_ERROR
- `502` UPSTREAM_ERROR

---

## 4.5 PATCH `/api/leads/{uuid}` (Edit)

### Правило
- Отправлять **только измененные поля**.
- Пустой body запрещен.

### Request body example
```json
{
  "Status": "In progress",
  "LeadDateTime": "2026-02-10T16:00:00.000Z",
  "Phone": "6195551234",
  "JobType": "Lock Repair",
  "LeadNotes": "Client requested evening visit",
  "Tags": ["estimate", "callback"]
}
```

### Response 200 shape
```json
{
  "ok": true,
  "data": {
    "UUID": "XYZ55Y",
    "ClientId": "1001",
    "link": "https://app.workiz.com/job/1HN2E0/"
  },
  "meta": {
    "request_id": "req_01H...",
    "timestamp": "2026-02-09T20:00:00.000Z"
  }
}
```

---

## 4.6 POST `/api/leads/{uuid}/mark-lost`

### Request body
```json
{}
```

### Response 200
```json
{
  "ok": true,
  "data": {
    "message": "Lead marked as lost"
  },
  "meta": {
    "request_id": "req_01H...",
    "timestamp": "2026-02-09T20:00:00.000Z"
  }
}
```

---

## 4.7 POST `/api/leads/{uuid}/activate`

### Request body
```json
{}
```

### Response 200
```json
{
  "ok": true,
  "data": {
    "message": "Lead activated"
  },
  "meta": {
    "request_id": "req_01H...",
    "timestamp": "2026-02-09T20:00:00.000Z"
  }
}
```

---

## 4.8 POST `/api/leads/{uuid}/assign`

### Request body
```json
{
  "User": "Alex Wilson"
}
```

### Response 200
```json
{
  "ok": true,
  "data": {
    "UUID": "XYZ55Y",
    "LeadId": "2",
    "link": "https://app.workiz.com/lead/1HN2E0/"
  },
  "meta": {
    "request_id": "req_01H...",
    "timestamp": "2026-02-09T20:00:00.000Z"
  }
}
```

---

## 4.9 POST `/api/leads/{uuid}/unassign`

### Request body
```json
{
  "User": "Alex Wilson"
}
```

### Response 200
```json
{
  "ok": true,
  "data": {
    "UUID": "XYZ55Y",
    "LeadId": "2",
    "link": "https://app.workiz.com/lead/1HN2E0/"
  },
  "meta": {
    "request_id": "req_01H...",
    "timestamp": "2026-02-09T20:00:00.000Z"
  }
}
```

---

## 4.10 POST `/api/leads/{uuid}/convert`

### Request body
```json
{}
```

### Response 200
```json
{
  "ok": true,
  "data": {
    "UUID": "XYZ55Y",
    "ClientId": "1001",
    "link": "https://app.workiz.com/job/1HN2E0/"
  },
  "meta": {
    "request_id": "req_01H...",
    "timestamp": "2026-02-09T20:00:00.000Z"
  }
}
```

---

## 5) Mapping: Internal API -> Workiz

| Internal | Workiz | Нормализация |
|---|---|---|
| GET `/api/leads` | GET `/lead/all/` | array -> `data.results`; `has_more = returned === records` |
| GET `/api/leads/{uuid}` | GET `/lead/get/{UUID}/` | `[lead]` -> `lead` |
| POST `/api/leads` | POST `/lead/create/` | inject `auth_secret`; unwrap `[{flag,data:[...]}]` |
| PATCH `/api/leads/{uuid}` | POST `/lead/update/` | inject `UUID`, `auth_secret` |
| POST `/api/leads/{uuid}/mark-lost` | POST `/lead/markLost/{UUID}/` | unwrap message |
| POST `/api/leads/{uuid}/activate` | POST `/lead/activate/{UUID}/` | unwrap message |
| POST `/api/leads/{uuid}/assign` | POST `/lead/assign/` | body `{UUID,User,auth_secret}` |
| POST `/api/leads/{uuid}/unassign` | POST `/lead/unassign/` | body `{UUID,User,auth_secret}` |
| POST `/api/leads/{uuid}/convert` | POST `/lead/convert/` | body `{UUID,auth_secret}` |

---

## 6) UX-правила и состояния

### 6.1 Optimistic updates
Для действий `mark-lost`, `activate`, `assign`, `unassign`:
- сразу обновлять UI;
- при ошибке откатывать состояние;
- показывать toast с `correlation_id`.

### 6.2 Toast/Alert матрица
- Success: короткий toast 2–3 сек.
- Error: sticky toast + кнопка Retry.
- Validation error: подсветка поля + текст рядом.

### 6.3 Accessibility
- Все кнопки row actions доступны с клавиатуры.
- `aria-label` для иконок (call, copy, convert).
- Фокус trap в модалках.

---

## 7) Нефункциональные требования

1. Лимит записи Workiz: `records <= 100`.
2. Retry policy на 429/5xx: до 3 попыток с exponential backoff.
3. Таймаут upstream: 10 секунд.
4. Маскирование PII в логах.
5. Логи содержат `request_id`.

---

## 8) Checklist по endpoint-ам (готовность к разработке)

## 8.1 Backend
- [ ] Реализован общий HTTP-клиент Workiz с timeout/retry.
- [ ] Реализован маппинг ошибок Workiz -> internal error codes.
- [ ] Реализован GET `/api/leads` + query validation.
- [ ] Реализован GET `/api/leads/{uuid}` + 404 handling.
- [ ] Реализован POST `/api/leads` + body validation.
- [ ] Реализован PATCH `/api/leads/{uuid}` + min 1 field.
- [ ] Реализован POST `/api/leads/{uuid}/mark-lost`.
- [ ] Реализован POST `/api/leads/{uuid}/activate`.
- [ ] Реализован POST `/api/leads/{uuid}/assign`.
- [ ] Реализован POST `/api/leads/{uuid}/unassign`.
- [ ] Реализован POST `/api/leads/{uuid}/convert`.
- [ ] Добавлены unit tests на нормализацию ответов.
- [ ] Добавлены integration tests happy/error paths.

## 8.2 Frontend
- [ ] Вкладка Leads добавлена и защищена feature flag.
- [ ] Filters bar реализован (start_date/only_open/status/search).
- [ ] Table реализована с сортировкой/пагинацией/действиями.
- [ ] Drawer реализован со всеми секциями.
- [ ] Create modal реализована с required validation.
- [ ] Edit modal реализована с diff-submit.
- [ ] Actions wiring к API выполнен.
- [ ] Optimistic update + rollback работает.
- [ ] Empty/Loading/Error states покрыты.
- [ ] E2E smoke tests зелёные.

---

## 9) Порядок реализации (рекомендуемый)

1. **Backend foundation**: клиент Workiz, envelopes, error map.
2. **Read-only UI**: filters + list + drawer.
3. **Create/Edit**: модалки + валидация + submit.
4. **Quick actions**: lost/activate/assign/unassign/convert.
5. **Hardening**: тесты, retry, логи, UX polish.

---

## 10) GitHub Flow для этой задачи

- Основная ветка: `feature/leads-workiz-tab`
- Подветки:
  - `feature/leads-api-contract`
  - `feature/leads-ui-table-filters`
  - `feature/leads-ui-drawer`
  - `feature/leads-ui-create-edit`
  - `feature/leads-actions-workflow`
- PR маленькие, без прямых коммитов в `main`.
- `FEATURE_LEADS_TAB` включать только на staging/prod после smoke.

