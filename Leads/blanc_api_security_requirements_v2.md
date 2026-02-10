---
document:
  id: "BLANC-API-INTAKE-REQ-v2"
  title: "Требования к защищённому API приёма лидов (без миграционного режима)"
  language: "ru"
  format: "YAML+Markdown"
  version: "2.0.0"
  status: "approved_draft"
  owner: "BLANC / ABC Homes"
  updated_at: "2026-02-09"
  timezone: "America/New_York"

project_stack:
  backend:
    runtime: "Node.js (CommonJS)"
    framework: "Express v5"
    database: "PostgreSQL (pg)"
    auth: "jsonwebtoken (JWT для внутренних/админ-операций)"
    external_apis: ["Twilio SDK", "Axios", "node-fetch"]
    tests: "Jest"
    dev_server: "Nodemon"
    deploy: ["Docker", "Fly.io"]
    infra_files: ["fly.toml", "Dockerfile"]
  frontend:
    framework: "React 19 + TypeScript"
    bundler: "Vite 7"
    styling: "Tailwind CSS v4"
    ui: ["Radix UI", "Lucide React"]
    routing: "React Router DOM v7"
    data_fetching_cache: "TanStack React Query v5"
    http_client: "Axios"
    dnd: "react-dnd"
    notifications: "Sonner"
    utils: ["clsx", "tailwind-merge", "class-variance-authority", "date-fns", "cmdk"]
    lint: ["ESLint", "eslint-plugin-react-hooks", "eslint-plugin-react-refresh"]

auth_model:
  scheme_name: "BLANC Integration Credentials"
  description: >
    Для каждого интегратора выдаётся пара:
    BLANC_API_KEY (публичный идентификатор интеграции) и
    BLANC_API_SECRET (секрет, показывается только один раз).
  transport:
    required_headers:
      - "X-BLANC-API-KEY"
      - "X-BLANC-API-SECRET"
    content_type: "application/json"
    https_only: true
  forbidden_legacy:
    - "Передача api_key в query string"
    - "Передача auth_secret в body"
  storage_rules:
    secret_storage: "Только hash(secret + server_pepper)"
    plaintext_secret_allowed: false
    pepper_source: "ENV/secret manager"

data_model:
  table: "api_integrations"
  required_fields:
    - "client_name"
    - "key_id"
    - "secret_hash"
    - "scopes"
    - "created_at"
    - "expires_at"
    - "revoked_at"
    - "last_used_at"
  notes:
    key_id: "Это значение BLANC_API_KEY (публичный идентификатор)."
    secret_hash: "Результат хеширования BLANC_API_SECRET с server_pepper."
    scopes: "JSON-массив разрешений (например: ['leads:create'])."
  sql_recommendation:
    types:
      client_name: "text not null"
      key_id: "text not null unique"
      secret_hash: "text not null"
      scopes: "jsonb not null default '[]'::jsonb"
      created_at: "timestamptz not null default now()"
      expires_at: "timestamptz null"
      revoked_at: "timestamptz null"
      last_used_at: "timestamptz null"

api_contract:
  endpoint: "POST /api/v1/integrations/leads"
  success:
    status: 201
    body: "{ success: true, lead_id, request_id }"
  auth_errors:
    missing_headers: { status: 401, code: "AUTH_HEADERS_REQUIRED" }
    invalid_key: { status: 401, code: "AUTH_KEY_INVALID" }
    invalid_secret: { status: 401, code: "AUTH_SECRET_INVALID" }
    revoked_or_expired: { status: 401, code: "AUTH_CREDENTIALS_INACTIVE" }
  validation_error:
    status: 400
    code: "PAYLOAD_INVALID"
  rate_limit_error:
    status: 429
    code: "RATE_LIMIT_EXCEEDED"

security_requirements:
  - id: "SEC-001"
    priority: "MUST"
    text: "Принимать только HTTPS-запросы."
  - id: "SEC-002"
    priority: "MUST"
    text: "Аутентифицировать только по заголовкам X-BLANC-API-KEY и X-BLANC-API-SECRET."
  - id: "SEC-003"
    priority: "MUST"
    text: "Секрет в БД хранить только как hash(secret + server_pepper)."
  - id: "SEC-004"
    priority: "MUST"
    text: "Проверку secret_hash выполнять в constant-time сравнении."
  - id: "SEC-005"
    priority: "MUST"
    text: "Логирование без утечки секретов (маскирование ключей/секретов)."
  - id: "SEC-006"
    priority: "MUST"
    text: "Rate limiting по key_id и IP."
  - id: "SEC-007"
    priority: "SHOULD"
    text: "IP allowlist для партнёров с фиксированными диапазонами."
  - id: "SEC-008"
    priority: "SHOULD"
    text: "Короткий TTL у credentials + регулярная ротация."
  - id: "SEC-009"
    priority: "SHOULD"
    text: "Idempotency-Key для защиты от дублей при повторах."

backend_requirements_express_pg:
  - "Express v5 middleware: validateHeaders -> authenticateIntegration -> validatePayload -> createLead."
  - "pg: все запросы через параметризованные SQL; без конкатенации."
  - "Nodemon только для dev; в production запуск через node."
  - "JWT использовать для внутренних админ-эндпоинтов управления интеграциями (выдача/revoke), не для входящих лидогенераторов."
  - "Таймауты и retry-политики для внешних вызовов (Twilio/Axios/node-fetch)."
  - "Единый error handler с request_id."

frontend_requirements_react:
  - "Админ-экран интеграций: создать/деактивировать ключ, показать scopes, expires_at, last_used_at."
  - "BLANC_API_SECRET показывать только один раз после генерации."
  - "После закрытия модалки секрет повторно не отображать."
  - "Все формы через типобезопасные DTO; ошибки API отображать через Sonner."
  - "Кэш списков интеграций через React Query; invalidate после create/revoke."

observability:
  logs:
    required_fields: ["timestamp", "request_id", "integration_key_id", "status_code", "latency_ms"]
    masking: ["X-BLANC-API-SECRET", "Authorization", "query secrets"]
  metrics:
    - "auth_success_total"
    - "auth_fail_total{reason}"
    - "lead_create_total"
    - "lead_create_fail_total"
    - "rate_limit_total"
  alerts:
    - "Резкий рост 401 за 5 минут"
    - "Резкий рост 429 за 5 минут"
    - "Отсутствие успешных лидов при наличии трафика > N минут"

testing:
  unit_jest:
    - "hash(secret + pepper) корректен и детерминирован."
    - "constant-time compare используется в verify."
    - "revoked_at/expires_at корректно блокируют доступ."
  integration_jest:
    - "201 при валидных headers и payload."
    - "401 при отсутствии/невалидности key/secret."
    - "429 при превышении лимита."
    - "legacy формат (query/body credentials) отклоняется."
  security_checks:
    - "Проверка, что секреты не попадают в логи."
    - "Проверка SQL injection устойчивости."
    - "Проверка replay-дублей при Idempotency-Key (если включено)."

deployment_fly_docker:
  env_required:
    - "DATABASE_URL"
    - "BLANC_SERVER_PEPPER"
    - "JWT_SECRET"
    - "RATE_LIMIT_WINDOW_SEC"
    - "RATE_LIMIT_MAX_PER_KEY"
    - "RATE_LIMIT_MAX_PER_IP"
    - "NODE_ENV"
  healthchecks:
    - "GET /healthz"
    - "GET /readyz (проверка БД)"
  release_policy:
    - "Блокировать deploy, если не прошли Jest + smoke tests."

acceptance_criteria:
  - "Без валидной пары BLANC_API_KEY/BLANC_API_SECRET lead не создаётся."
  - "В БД отсутствуют plaintext секреты."
  - "Секрет показывается один раз при выдаче и не доступен повторно."
  - "Legacy-форматы авторизации не принимаются."
  - "last_used_at обновляется при успешной авторизации."
  - "Система выдерживает burst-трафик в рамках лимитов без деградации SLA."

issue_task_requirements_section:
  Requirements:
    - "Работать в режиме @orchestrator.md."
---

# Требования к защищённому API приёма лидов (BLANC API)

## 1. Назначение
Документ определяет целевую (рекомендуемую) схему аутентификации интеграторов для создания лидов в БД:
- **BLANC_API_KEY** — публичный идентификатор интеграции.
- **BLANC_API_SECRET** — секрет, который показывается только один раз при выдаче.

Миграционный режим не используется: принимается только новый формат.

## 2. Обязательная модель авторизации
1. Входящие запросы на создание лидов принимаются только через HTTPS.
2. Credentials передаются только в заголовках:
   - `X-BLANC-API-KEY`
   - `X-BLANC-API-SECRET`
3. На сервере выполняется:
   - поиск интеграции по `key_id = BLANC_API_KEY`;
   - проверка `revoked_at` и `expires_at`;
   - вычисление `hash(incoming_secret + server_pepper)`;
   - сравнение с `secret_hash` (constant-time).
4. При успехе:
   - создаётся лид,
   - обновляется `last_used_at`.

## 3. Структура БД (обязательные поля)
Таблица `api_integrations` обязана содержать поля:
- `client_name`
- `key_id`
- `secret_hash`
- `scopes`
- `created_at`
- `expires_at`
- `revoked_at`
- `last_used_at`

> Примечание: `key_id` соответствует значению `BLANC_API_KEY`.

## 4. Запрещённые форматы
Сервис **не должен** принимать:
- `api_key` в query string,
- `auth_secret` в body.

Любая попытка использовать legacy-формат должна отклоняться с 401.

## 5. Требования к backend (Node.js/Express 5 + pg)
- Middleware-цепочка: `validateHeaders` → `authenticateIntegration` → `validatePayload` → `createLead`.
- Только параметризованные SQL-запросы через `pg`.
- Единый error handler с `request_id`.
- Логи без секретов (маскирование заголовков и потенциально чувствительных параметров).
- JWT — для внутренних админ-эндпоинтов (управление интеграциями), но не как замена BLANC credentials для лидогенераторов.

## 6. Требования к frontend (React + Vite + TS)
- Экран управления интеграциями: создание, revoke, scopes, срок действия, last_used_at.
- `BLANC_API_SECRET` показывать только один раз после генерации.
- Ошибки API отображать через Sonner.
- Кэш и синхронизация через TanStack Query.

## 7. Набор тестов (Jest)
- Unit: hashing, constant-time compare, revoked/expired сценарии.
- Integration: 201 (успех), 401 (ошибки auth), 429 (rate limit), отказ legacy-форматов.
- Security: отсутствие секретов в логах, SQL injection negative tests.

## 8. Definition of Done
Считается выполненным, если одновременно выполняется:
1. Без валидной пары key/secret лид создать нельзя.
2. Plaintext секреты отсутствуют в БД и логах.
3. Секрет отображается пользователю только один раз при выдаче.
4. Legacy-форматы не поддерживаются.
5. `last_used_at` обновляется при успешной авторизации.
6. Метрики/алерты по auth и rate limit работают в production.

## 9. Приложение: минимальные ENV переменные
- `DATABASE_URL`
- `BLANC_SERVER_PEPPER`
- `JWT_SECRET`
- `RATE_LIMIT_WINDOW_SEC`
- `RATE_LIMIT_MAX_PER_KEY`
- `RATE_LIMIT_MAX_PER_IP`
- `NODE_ENV`
