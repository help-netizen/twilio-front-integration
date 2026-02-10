---
document:
  id: "REQ-WORKIZ-TO-BLANC-LEAD-PROCESSING-v1"
  title: "Требования: перевод Lead Processing с Workiz на BLANC"
  language: "ru"
  format: "YAML+Markdown"
  version: "1.0.0"
  status: "draft"
  owner: "BLANC / Lead Integrations"
  updated_at: "2026-02-09"
  timezone: "America/New_York"

business_goal: >
  Перевести отправку лидов из текущего канала Workiz в сервис BLANC без изменения
  существующей логики парсеров и подготовки данных.

key_constraints:
  - "Всю логику парсеров оставить без изменений."
  - "Всю логику подготовки/нормализации данных оставить без изменений."
  - "Меняется только этап Lead Processing (transport layer): Workiz -> BLANC."
  - "Legacy-авторизация Workiz/старые паттерны не использовать."

credentials:
  delivery_note: >
    API Key и API Secret предоставляются заказчиком в процессе разработки
    через защищённый канал. До передачи использовать только ENV placeholders.
  required_headers:
    - "X-BLANC-API-KEY"
    - "X-BLANC-API-SECRET"
  storage_policy:
    - "Не хранить секреты в коде/репозитории."
    - "Секреты хранить в ENV/secret manager."
    - "Логи должны маскировать ключи и секреты."

target_api:
  base_path: "/api/v1/integrations"
  create_lead:
    method: "POST"
    path: "/api/v1/integrations/leads"
    content_type: "application/json"
    required_scope: "leads:create"
  auth_legacy_rejected:
    - "api_key в query params -> 401 AUTH_LEGACY_REJECTED"
    - "auth_secret в body -> 401 AUTH_LEGACY_REJECTED"

rate_limit_policy:
  per_api_key:
    limit: 60
    window_seconds: 60
  per_ip:
    limit: 120
    window_seconds: 60
  on_limit:
    status: 429
    code: "RATE_LIMITED"
    header: "Retry-After"

error_contract:
  "401":
    - "AUTH_HEADERS_REQUIRED"
    - "AUTH_KEY_NOT_FOUND"
    - "AUTH_KEY_REVOKED"
    - "AUTH_KEY_EXPIRED"
    - "AUTH_SECRET_INVALID"
    - "AUTH_LEGACY_REJECTED"
  "403":
    - "SCOPE_INSUFFICIENT"
  "400":
    - "PAYLOAD_INVALID"
  "429":
    - "RATE_LIMITED"

architecture_change:
  unchanged_modules:
    - "Lead parsers (источники: Thumbtack, Google и т.д.)"
    - "Data preparation / field normalization"
    - "Внутренняя бизнес-валидация до transport шага"
  changed_modules:
    - "Lead Processing transport client: WorkizClient -> BlancClient"
  adapter_contract:
    input: "Существующий нормализованный Lead DTO (без изменения структуры)"
    output_success: "{ success: true, lead_id, request_id }"
    output_error: "{ success: false, code, message, request_id? }"

field_mapping_policy:
  rule: "1:1 перенос текущего normalized payload в BLANC body без изменения parser-логики."
  identifying_fields_requirement: >
    Для успешного создания лида должен присутствовать минимум один идентификатор:
    FirstName или LastName или Phone или Email.
  supported_fields:
    - "FirstName"
    - "LastName"
    - "Phone"
    - "PhoneExt"
    - "SecondPhone"
    - "SecondPhoneExt"
    - "Email"
    - "Company"
    - "Address"
    - "Unit"
    - "City"
    - "State"
    - "PostalCode"
    - "Country"
    - "Latitude"
    - "Longitude"
    - "JobType"
    - "JobSource"
    - "ReferralCompany"
    - "Timezone"
    - "LeadNotes"
    - "Comments"
    - "Tags"
    - "LeadDateTime"
    - "LeadEndDateTime"
    - "Status"
    - "SubStatus"
    - "PaymentDueDate"

non_functional_requirements:
  security:
    - "Только HTTPS."
    - "Заголовочная auth (X-BLANC-API-KEY / X-BLANC-API-SECRET) обязательна."
    - "Запрет legacy auth-паттернов."
  reliability:
    - "Timeout исходящего запроса к BLANC: 10s (configurable)."
    - "Retry только для 5xx/сетевых ошибок: до 2 попыток, экспоненциальная пауза."
    - "Для 4xx retry не выполнять."
  observability:
    - "Логировать request_id, source, статус BLANC, latency."
    - "Не логировать секреты/полные ключи."
    - "Метрики: create_lead_success_total, create_lead_fail_total{code}, rate_limited_total."

implementation_requirements_node_express:
  stack:
    runtime: "Node.js (CommonJS)"
    framework: "Express v5"
    db: "PostgreSQL (pg)"
    tests: "Jest"
    deploy: ["Docker", "Fly.io"]
  tasks:
    - "Добавить BlancClient модуль (axios/node-fetch) для POST /api/v1/integrations/leads."
    - "Заменить вызов Workiz в Lead Processing на BlancClient без изменения parser/data-prep модулей."
    - "Добавить конфиги ENV: BLANC_BASE_URL, BLANC_API_KEY, BLANC_API_SECRET, BLANC_TIMEOUT_MS."
    - "Добавить middleware/утилиты маскировки секретов в логах."
    - "Сохранить текущий контракт внутренних вызовов Lead Processing."

acceptance_criteria:
  - id: "AC-001"
    text: "Парсеры и подготовка данных работают без изменений (по regression-тестам полностью совместимы)."
  - id: "AC-002"
    text: "Лиды создаются в BLANC через POST /api/v1/integrations/leads с заголовками X-BLANC-API-KEY/X-BLANC-API-SECRET."
  - id: "AC-003"
    text: "При отсутствии/ошибке credentials возвращаются корректные коды 401 согласно BLANC API."
  - id: "AC-004"
    text: "При отсутствии scope leads:create возвращается 403 SCOPE_INSUFFICIENT и корректно обрабатывается системой."
  - id: "AC-005"
    text: "При rate limit корректно обрабатывается 429 + Retry-After без бесконечных ретраев."
  - id: "AC-006"
    text: "Секреты не попадают в логи, .env.example не содержит реальных значений."
  - id: "AC-007"
    text: "Интеграционные Jest-тесты покрывают минимум: success, 401, 403, 400, 429, 5xx."

test_plan:
  unit:
    - "Mapper: normalized DTO -> BLANC payload (без изменения исходной parser-логики)."
    - "Error mapper: BLANC code -> внутренний доменный код/сообщение."
  integration:
    - "Успешное создание лида (201/success=true)."
    - "AUTH_HEADERS_REQUIRED (401)."
    - "AUTH_SECRET_INVALID (401)."
    - "SCOPE_INSUFFICIENT (403)."
    - "PAYLOAD_INVALID (400)."
    - "RATE_LIMITED (429, проверка Retry-After)."
  regression:
    - "Сравнение результатов parser/data-prep до/после изменений: без функциональных расхождений."

deliverables:
  - "BlancClient + конфигурация ENV"
  - "Обновлённый Lead Processing service (без изменений parser/data-prep)"
  - "Jest unit/integration tests"
  - "Краткая runbook-инструкция для prod env на Fly.io"

issue_task_requirements_section:
  Requirements:
    - "Работать в режиме @orchestrator.md."
---

# Требования: перевод Lead Processing с Workiz на BLANC

## 1) Цель
Переключить отправку лидов на BLANC API, не затрагивая текущие парсеры источников и подготовку данных.

## 2) Границы изменений

### 2.1 Что **не меняем**
- Логику парсеров лидогенераторов (Thumbtack, Google и т.д.).
- Логику подготовки/нормализации данных.
- Формат внутреннего normalized Lead DTO (вход Lead Processing).

### 2.2 Что **меняем**
- Только transport-слой Lead Processing:
  - было: отправка в Workiz;
  - становится: отправка в BLANC (`POST /api/v1/integrations/leads`).

## 3) Аутентификация и безопасность
- Использовать только заголовки:
  - `X-BLANC-API-KEY`
  - `X-BLANC-API-SECRET`
- `api_key` в query и `auth_secret` в body не использовать (иначе `401 AUTH_LEGACY_REJECTED`).
- Запросы только по HTTPS.
- Ключи/секреты хранить в ENV/secret manager, не в коде и не в репозитории.
- В логах маскировать секреты и полные ключи.

## 4) Важное организационное условие
**API Key и API Secret будут переданы заказчиком в процессе разработки** через защищённый канал.  
До этого момента использовать placeholder-переменные окружения:
- `BLANC_API_KEY=<to_be_provided>`
- `BLANC_API_SECRET=<to_be_provided>`

## 5) Контракт BLANC Create Lead
- Endpoint: `POST /api/v1/integrations/leads`
- Required scope: `leads:create`
- Content-Type: `application/json`
- Минимум одно идентифицирующее поле: `FirstName` или `LastName` или `Phone` или `Email`.

### Успех
```json
{
  "success": true,
  "lead_id": "4AB4IK",
  "request_id": "490336c8-03ce-4d91-9c7a-2c71fd674031"
}
```

### Ошибки, которые обязательно обрабатывать
- `401`: AUTH_HEADERS_REQUIRED, AUTH_KEY_NOT_FOUND, AUTH_KEY_REVOKED, AUTH_KEY_EXPIRED, AUTH_SECRET_INVALID, AUTH_LEGACY_REJECTED
- `403`: SCOPE_INSUFFICIENT
- `400`: PAYLOAD_INVALID
- `429`: RATE_LIMITED (читать `Retry-After`)

## 6) Rate Limiting (обязательное поведение клиента)
- Per API Key: 60 req / 60 sec
- Per IP: 120 req / 60 sec
- При `429`:
  - учитывать `Retry-After`,
  - не делать агрессивные повторы,
  - не уходить в бесконечный retry loop.

## 7) Требования к реализации (Node.js / Express / pg)
1. Создать `BlancClient` (axios или node-fetch).
2. Переключить Lead Processing на `BlancClient`.
3. Сигнатуру входа/выхода Lead Processing сохранить совместимой для остального кода.
4. Добавить ENV:
   - `BLANC_BASE_URL`
   - `BLANC_API_KEY`
   - `BLANC_API_SECRET`
   - `BLANC_TIMEOUT_MS`
5. Добавить таймаут 10s (configurable), retry только для 5xx/сетевых ошибок (до 2 попыток).
6. Для 4xx retry не выполнять.
7. Добавить безопасное логирование и correlation (`request_id`).

## 8) Критерии приёмки (DoD)
- Переключение выполнено только в Lead Processing.
- Parser/Data Preparation проходят regression-тесты без расхождений.
- Лид успешно создаётся в BLANC при валидных ключах.
- Корректно обрабатываются сценарии 400/401/403/429/5xx.
- Секреты отсутствуют в логах и в кодовой базе.
- Jest тесты (unit + integration) зелёные.

## 9) Пример ENV для разработки
```bash
BLANC_BASE_URL=https://your-domain
BLANC_API_KEY=<to_be_provided_during_development>
BLANC_API_SECRET=<to_be_provided_during_development>
BLANC_TIMEOUT_MS=30000
```
