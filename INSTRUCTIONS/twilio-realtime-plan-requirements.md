# Twilio Call Viewer — План разработки и требования (YAML + Markdown)

```yaml
meta:
  document_id: twilio-realtime-sync-plan-v1
  version: "1.0"
  date: "2026-02-07"
  author_role: "Solution Architect"
  language: "ru"
  project: "Twilio Call Viewer"
  goal: >
    Перевести проект на push-first модель (webhooks + inbox + worker + realtime push в UI)
    с reconcile-джобами, чтобы страница звонков была актуальной почти мгновенно,
    без постоянного опроса Twilio за широкий период.
  based_on_current_project:
    schema_tables: [contacts, conversations, messages]
    current_api: [GET /api/conversations, GET /api/conversations/:id/messages, POST /api/sync/today]
    current_notes:
      - "В messages нет updated_at (только created_at)"
      - "Есть parent_call_sid и логика parent/child"
      - "Есть manual sync за 3 дня через /api/sync/today"
  success_metrics:
    - name: "Webhook->UI latency P95"
      target: "<= 2s"
    - name: "Event loss"
      target: "0 (дубли допустимы, потери нет)"
    - name: "Reconcile lag"
      target: "<= 10m для hot набора"
    - name: "Manual full sync calls"
      target: "свести к аварийному режиму"

architecture:
  pattern: "Push-first + Reconcile-second"
  flow:
    - "Twilio Webhook -> API Ingestion"
    - "Ingestion -> twilio_webhook_inbox (idempotent append)"
    - "Worker -> normalize event -> call_events (immutable) + messages (snapshot upsert)"
    - "Worker -> publish event to realtime channel (WS/SSE)"
    - "Reconcile jobs (hot/warm/cold) -> patch drift and late fields"
  guarantees:
    - "At-least-once ingestion"
    - "Idempotent processing"
    - "Out-of-order tolerant state updates"
    - "Backward compatible read API for existing frontend"

data_model_changes:
  add_tables:
    - name: "twilio_webhook_inbox"
      purpose: "Надежный прием webhook payload + дедупликация + ретраи"
      required_columns:
        - "id bigserial pk"
        - "source text not null"
        - "event_type text not null"
        - "call_sid varchar(100)"
        - "recording_sid varchar(100)"
        - "dedupe_key varchar(255) unique not null"
        - "payload jsonb not null"
        - "received_at timestamptz default now()"
        - "processed_at timestamptz"
        - "processing_status text default 'pending'"
        - "error text"
    - name: "call_events"
      purpose: "Immutable event log по каждому звонку"
      required_columns:
        - "id bigserial pk"
        - "call_sid varchar(100) not null"
        - "event_type text not null"
        - "event_status text"
        - "event_time timestamptz not null"
        - "source text not null"
        - "payload jsonb not null"
        - "created_at timestamptz default now()"
      indexes:
        - "(call_sid, event_time desc)"
        - "(event_type, event_time desc)"
    - name: "sync_state"
      purpose: "Курсоры и состояние reconcile джоб"
      required_columns:
        - "job_name text primary key"
        - "cursor jsonb not null default '{}'"
        - "last_success_at timestamptz"
        - "last_error_at timestamptz"
        - "last_error text"
        - "updated_at timestamptz default now()"

  alter_tables:
    - table: "messages"
      changes:
        - "add column updated_at timestamptz default now() not null"
        - "add column last_event_time timestamptz"
        - "add column is_final boolean default false not null"
        - "add column finalized_at timestamptz"
        - "add column sync_state text default 'active' not null"
      indexes:
        - "partial idx_messages_active_status on (status, start_time desc) where status in ('queued','initiated','ringing','in-progress')"
        - "idx_messages_updated_at on (updated_at desc)"
        - "idx_messages_parent_call_sid on (parent_call_sid)"
    - table: "conversations"
      recommendation:
        - "metadata.total_calls считать агрегатно при rebuild; не полагаться только на инкремент"

api_contracts_new:
  public_read:
    - "GET /api/calls/active"
    - "GET /api/events?after_seq={n}&limit={m}"
    - "GET /api/health/sync"
  inbound_webhooks:
    - "POST /webhooks/twilio/voice-status"
    - "POST /webhooks/twilio/recording-status"
  internal_admin:
    - "POST /api/sync/reconcile/hot"
    - "POST /api/sync/reconcile/warm"
    - "POST /api/sync/reconcile/cold"
    - "POST /api/sync/call/:sid"
  compatibility:
    - "GET /api/conversations сохранить"
    - "GET /api/conversations/:id/messages сохранить"
    - "POST /api/sync/today оставить как аварийный/manual режим"

reconcile_policy:
  hot:
    interval: "каждые 1-2 минуты"
    scope: "нефинальные статусы: queued, initiated, ringing, in-progress"
  warm:
    interval: "каждые 10-15 минут"
    scope: "finalized <= 2-6 часов назад (late enrichment: duration/price/recording)"
  cold:
    interval: "1 раз в сутки (ночью)"
    scope: "окно 24 часа для целостности"
  freeze:
    rule: "после final + cooldown перевести запись в frozen и больше не поллить"

event_processing_rules:
  idempotency:
    - "Каждый webhook сначала в inbox"
    - "dedupe_key UNIQUE"
    - "Повторный event -> no-op"
  ordering:
    - "Сравнение event_time с last_event_time"
    - "Не допускать откат статуса на более ранний этап (кроме явных исключений)"
  state_machine:
    non_final: [queued, initiated, ringing, in-progress]
    final: [completed, busy, no-answer, canceled, failed]

security_requirements:
  - "Проверка X-Twilio-Signature на каждом webhook"
  - "Rate limiting inbound webhook endpoints"
  - "IP allowlist (по возможности) + WAF rules"
  - "Secrets только через secure vault/env manager"
  - "PII-safe logging: не логировать полный payload в application logs"

observability:
  metrics:
    - "webhook_received_total"
    - "webhook_invalid_signature_total"
    - "webhook_inbox_pending"
    - "worker_processing_latency_ms"
    - "realtime_publish_latency_ms"
    - "reconcile_drift_detected_total"
  alerts:
    - "inbox_pending > threshold 5m"
    - "dead_letter events > threshold"
    - "sync health endpoint degraded"
    - "reconcile lag > SLA"
  tracing:
    - "trace_id сквозной: webhook -> inbox -> worker -> db -> realtime push"

testing:
  layers:
    - "Unit: normalizer, state machine, dedupe key"
    - "Integration: webhook endpoint + DB + worker"
    - "E2E: Twilio test call -> UI update under 2s"
    - "Chaos: duplicate events, out-of-order, delayed callbacks"

rollout:
  strategy: "Blue/Green + feature flags"
  flags:
    - "realtime_push_enabled"
    - "webhook_ingestion_enabled"
    - "reconcile_jobs_enabled"
  steps:
    - "Deploy schema first"
    - "Deploy ingestion in shadow mode (store-only)"
    - "Enable worker for subset (10%)"
    - "Enable realtime UI"
    - "Switch default sync path from /api/sync/today to webhook+reconcile"
    - "Keep /api/sync/today for emergency manual use"
  rollback:
    - "Disable flags"
    - "Keep read API untouched"
    - "Resume manual sync temporarily"

task_board:
  - id: "EPIC-1"
    title: "Архитектура и ADR"
    priority: "P0"
    estimate_days: 2
    owner: "Backend Lead"
    deliverables:
      - "ADR-001 Realtime Sync Architecture"
      - "Sequence diagrams"
      - "State machine transitions table"
    acceptance:
      - "Команда согласовала ADR"
      - "Определены SLO/SLA и error budget"

  - id: "TASK-DB-1"
    epic: "EPIC-1"
    title: "Миграции: inbox/events/sync_state + alter messages"
    priority: "P0"
    estimate_days: 2
    owner: "Backend Engineer"
    depends_on: ["EPIC-1"]
    requirements:
      - "Создать таблицы twilio_webhook_inbox, call_events, sync_state"
      - "Добавить поля updated_at, is_final, finalized_at, last_event_time, sync_state в messages"
      - "Добавить частичные/служебные индексы"
      - "Обеспечить rollback SQL"
    acceptance:
      - "Миграции применяются без даунтайма"
      - "Explain analyze показывает использование новых индексов"
      - "Исторические данные читаются без регрессий"

  - id: "TASK-API-1"
    epic: "EPIC-1"
    title: "Webhook endpoints + signature validation"
    priority: "P0"
    estimate_days: 2
    owner: "Backend Engineer"
    depends_on: ["TASK-DB-1"]
    requirements:
      - "POST /webhooks/twilio/voice-status"
      - "POST /webhooks/twilio/recording-status"
      - "Проверка X-Twilio-Signature"
      - "Быстрый 200 после append в inbox"
    acceptance:
      - "Невалидная подпись -> 403"
      - "Валидный webhook пишет inbox строку"
      - "RPS выдерживает пиковую нагрузку"

  - id: "TASK-WORKER-1"
    epic: "EPIC-1"
    title: "Inbox consumer/worker (idempotent)"
    priority: "P0"
    estimate_days: 3
    owner: "Backend Engineer"
    depends_on: ["TASK-API-1"]
    requirements:
      - "Lock/claim pending events (skip locked)"
      - "Canonical event normalization"
      - "Upsert snapshot в messages"
      - "Append immutable row в call_events"
      - "Dead-letter policy после N ретраев"
    acceptance:
      - "Duplicate webhook не меняет snapshot второй раз"
      - "Out-of-order events обрабатываются корректно"
      - "Ошибочные события попадают в dead-letter"

  - id: "TASK-STATE-1"
    epic: "EPIC-1"
    title: "State machine и freeze policy"
    priority: "P0"
    estimate_days: 1
    owner: "Backend Engineer"
    depends_on: ["TASK-WORKER-1"]
    requirements:
      - "Явная таблица допустимых переходов статусов"
      - "is_final/finalized_at проставляются автоматически"
      - "cooldown -> frozen по расписанию"
    acceptance:
      - "Недопустимый переход логируется и игнорируется"
      - "final calls перестают попадать в hot reconcile"

  - id: "TASK-SYNC-1"
    epic: "EPIC-1"
    title: "Reconcile jobs (hot/warm/cold)"
    priority: "P0"
    estimate_days: 3
    owner: "Backend Engineer"
    depends_on: ["TASK-WORKER-1", "TASK-STATE-1"]
    requirements:
      - "hot: non-final, 1-2 мин"
      - "warm: finalized recent, 10-15 мин"
      - "cold: daily 24h window"
      - "sync_state курсоры + restart-safe"
    acceptance:
      - "Дрейф после симуляции устраняется автоматически"
      - "Нет full scan за 3 дня в штатном режиме"

  - id: "TASK-RT-1"
    epic: "EPIC-1"
    title: "Realtime transport (SSE или WebSocket)"
    priority: "P1"
    estimate_days: 3
    owner: "Backend + Frontend"
    depends_on: ["TASK-WORKER-1"]
    requirements:
      - "Publish событий: call.created/call.updated/recording.updated"
      - "Auth для realtime канала"
      - "Reconnect with last_seq"
    acceptance:
      - "UI получает апдейт <2s P95"
      - "После reconnect нет потери событий"

  - id: "TASK-API-2"
    epic: "EPIC-1"
    title: "Delta API + health endpoints"
    priority: "P1"
    estimate_days: 2
    owner: "Backend Engineer"
    depends_on: ["TASK-WORKER-1"]
    requirements:
      - "GET /api/events?after_seq"
      - "GET /api/calls/active"
      - "GET /api/health/sync"
    acceptance:
      - "Клиент может восстановиться после оффлайна через delta feed"
      - "Health отражает lag/backlog честно"

  - id: "TASK-FE-1"
    epic: "EPIC-1"
    title: "UI интеграция realtime + fallback poll"
    priority: "P1"
    estimate_days: 3
    owner: "Frontend Engineer"
    depends_on: ["TASK-RT-1", "TASK-API-2"]
    requirements:
      - "Подписка на realtime"
      - "Оптимистичное обновление активных звонков"
      - "Fallback на delta endpoint при reconnect"
      - "Индикатор stale data"
    acceptance:
      - "Новый звонок виден без ручного refresh"
      - "Смена статуса отражается в таймлайне"
      - "При потере соединения UI самовосстанавливается"

  - id: "TASK-OBS-1"
    epic: "EPIC-1"
    title: "Метрики, алерты, дашборд"
    priority: "P1"
    estimate_days: 2
    owner: "DevOps/Backend"
    depends_on: ["TASK-WORKER-1", "TASK-SYNC-1"]
    requirements:
      - "Prom metrics + structured logs"
      - "Alerts: backlog/dead-letter/lag/signature failures"
      - "Dashboard: ingest, process, publish, reconcile"
    acceptance:
      - "On-call получает actionable alerts"
      - "MTTR инцидентов < 15 мин"

  - id: "TASK-QA-1"
    epic: "EPIC-1"
    title: "Полный тест-пакет и нагрузочное тестирование"
    priority: "P1"
    estimate_days: 3
    owner: "QA + Backend"
    depends_on: ["TASK-FE-1", "TASK-OBS-1"]
    requirements:
      - "Набор тест-кейсов на дубли/out-of-order/late callbacks"
      - "Load test webhook burst"
      - "E2E сценарии реальных звонков"
    acceptance:
      - "Критические сценарии проходят"
      - "Нет деградации текущих GET API"

  - id: "TASK-ROL-1"
    epic: "EPIC-1"
    title: "Поэтапный rollout и deprecation старого sync"
    priority: "P0"
    estimate_days: 2
    owner: "Tech Lead"
    depends_on: ["TASK-QA-1"]
    requirements:
      - "Feature flags + staged rollout"
      - "Shadow mode перед full switch"
      - "Runbook rollback"
      - "POST /api/sync/today оставить только как emergency"
    acceptance:
      - "Production switch без инцидентов P1"
      - "Документирован rollback"

definition_of_done_global:
  - "Все P0 задачи закрыты"
  - "SLO по latency и event loss выполняются 7 дней подряд"
  - "Нагрузка и отказоустойчивость подтверждены"
  - "Команда поддержки получила runbook и дашборды"

risks_and_mitigations:
  - risk: "Webhook подписи/конфиг ломаются при релизе"
    mitigation: "canary endpoint + synthetic webhook checks"
  - risk: "Out-of-order событий приводит к неверному статусу"
    mitigation: "strict state machine + last_event_time guard"
  - risk: "Рост inbox backlog"
    mitigation: "autoscale workers + alert + dead-letter triage"
  - risk: "Дрейф counters (total_calls)"
    mitigation: "периодический aggregate rebuild job"

open_questions:
  - "SSE vs WebSocket как стандарт проекта?"
  - "Нужно ли хранить raw payload без редактирования PII?"
  - "Какой retention для call_events и inbox?"
```

---

## 1) Контекст и baseline

В текущем проекте уже есть:
- таблицы `contacts`, `conversations`, `messages`;
- API чтения: `GET /api/conversations`, `GET /api/conversations/:id/messages`;
- ручной sync через `POST /api/sync/today` (последние 3 дня);
- parent/child связь звонков через `parent_call_sid`;
- активные статусы используются в выборках (`queued`, `initiated`, `ringing`, `in-progress`).

---

## 2) Почему нужна новая модель

### Проблема 1 — current sync дорогой
Если регулярно дергать Twilio за период, это растет по стоимости и latency.

### Проблема 2 — нет надежного ingestion слоя
Без inbox + idempotency легко получить дубли/рассинхрон.

### Проблема 3 — нет immutable истории событий
Один snapshot в `messages` удобен для UI, но не для аудита и восстановления.

---

## 3) Целевая модель

**Webhook -> Inbox -> Worker -> Snapshot + Event Store -> Realtime Push -> Reconcile Jobs**

- **Webhook** дает почти мгновенные изменения.
- **Inbox** дает надежность и дедуп.
- **Worker** нормализует и применяет изменения.
- **Event Store** хранит фактическую историю.
- **Snapshot** (`messages`) остается быстрым источником для UI.
- **Reconcile** чинит редкие пропуски/late updates.

---

## 4) Шаблон требований на каждую задачу

1. **Scope:** что входит/не входит.
2. **Input/Output:** API, payload, таблицы.
3. **Совместимость:** backward compatibility.
4. **Надежность:** idempotency, retry, timeout.
5. **Observability:** метрики/логи/трейсы.
6. **Security:** подписи, секреты, rate limit.
7. **Тесты:** unit/integration/e2e.
8. **Acceptance:** измеримый результат.

---

## 5) Слабые места текущей модели, которые закрывает план

1. В `messages` нужен `updated_at` для корректного delta/realtime.
2. `conversations.metadata.total_calls` может дрейфовать — нужен периодический rebuild.
3. Нужен явный event log (`call_events`) и ingestion inbox.
4. `/api/sync/today` стоит оставить, но как emergency/manual, не как основной контур.

---

## 6) Итог

Этот план дает:
- почти realtime обновления страницы звонков,
- минимальные запросы к Twilio (без постоянного full scan),
- устойчивость к дублям и out-of-order событиям,
- предсказуемый rollout и поддержку в production.
