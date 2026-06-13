# Рефакторинг + новая архитектура — отчёт (2026-06-13)

Задача: проанализировать выросший проект (~100k LOC), спроектировать целевую
архитектуру, убрать мёртвый код, заложить 8 направлений. Решения владельца:
**хребет + чистка** (без переписывания работающего), **Stripe Billing**,
консолидация платежей.

Полная целевая архитектура: [ADR-001](ADR-001-platform-core-architecture.md).

---

## 1. Анализ (что нашёл)

| Находка | Вердикт |
|---|---|
| Мёртвый код: `frontAPI.js`, `routes/conversations.js` (не смонтирован), `mailSecretaryGmailFetchService` (только тест), мусорные корневые файлы | удалено |
| `payments` таблица: 0 строк, 0 ссылок в коде, 0 зависимых вьюх | удалена (миграция 100) |
| `fact_payments`: 0 строк, 0 ссылок в JS — **НО** зависят analytics-вьюхи (mart_profit_mtd, vw_job_metrics…) | **оставлена** (grep по коду их не видел; поймал при тесте миграции) |
| Триггеры зашиты в код (`arConfigHelper`) | помечен `@deprecated`, заменён rules-engine |
| QA-агент: 2 integrity-риска в 096/098 | оба исправлены |
| `jwtService.js`, `callFormatter.js` (legacy, только тесты) | оставлены (покрыты тестами; флаг в ADR) |
| realtime-транскрипция (`mediaStreamServer`→…) dormant за фиче-флагом | оставлено как есть |

## 2. Удалено
- `src/services/frontAPI.js` (131) — Front-интеграция заброшена, 0 prod-usages
- `backend/src/routes/conversations.js` (493) — не смонтирован, дублирует
  `routes/messaging.js`
- `backend/src/services/mailSecretaryGmailFetchService.js` (125) + его тест —
  только тест ссылался
- Мусорные корневые файлы: `0`, `'customer'-`, `'id'`, `GIT_WORKFLOW_old.md`,
  `patch-callprocessor.js`
- Таблица `payments` (миграция 100)

## 3. Добавлено — Event-driven хребет (ADR-001)

### Шина событий + логирование
- `services/eventBus.js` — `emit()` пишет `domain_events` (источник правды)
  синхронно, диспетчит подписчикам асинхронно (at-least-once, ошибка
  подписчика не валит producer), журнал в `event_dispatch_log`. Queue-ready.
- `services/eventSubscribers.js` — централизованная регистрация подписчиков.
- Producer-пример: `job.status_changed` эмитится из `routes/jobs.js`.

### Rules Engine (редактируемые правила) — §2.2
- `services/rulesEngine.js` — событийные + таймерные триггеры, условия
  (`{all|any:[{field,op,value}]}`, 9 операторов, dotted-path), `onEvent` +
  `tickScheduler` (delayed/cron, FOR UPDATE SKIP LOCKED), идемпотентность по
  dedupe_key, run-история в `automation_rule_runs`.
- `services/ruleActions.js` — реестр действий с `{{template}}`-подстановкой:
  `send_sms`, `send_email`, `create_task`, `assign_task`,
  `set_action_required`, `fsm_transition`, `run_agent_task`, `webhook`.
  Новое действие = одна запись в REGISTRY.
- `routes/automationRules.js` — CRUD + run-history (под `tenant.company.manage`).
- Таблицы: `automation_rules`, `automation_rule_runs`,
  `automation_scheduled_jobs` (миграция 100).
- Примеры из ТЗ покрыты: «job→статус ⇒ SMS клиенту», «provider assigned ⇒ SMS
  технику», «через N после события ⇒ task».

### Задачи: пользователь + агент — §2.3
- `tasks` расширена: `kind` (user|agent), `agent_type/input/output/status`,
  `source_rule_id`; `thread_id` стал nullable (agent-задачи без треда).
- Agent-задачи ставятся в очередь действием `run_agent_task`, статус
  queued→running→succeeded/failed; видны в общем списке/календаре.

### Биллинг платформы (Stripe) — §2.4
- Миграция 101: `billing_plans` (+seed trial/starter/pro), `billing_subscriptions`,
  `billing_usage_records` (metered), `billing_invoices`.
- `services/billing/billingProvider.js` — провайдер-агностичный фасад.
- `services/billing/stripeProvider.js` — Stripe через REST (без SDK-зависимости,
  безопасно для прод-сборки), webhook-подпись v1 HMAC.
- `services/billingService.js` — trial, Checkout, metered usage из событий
  (подписчик `billing-meter`), webhook→state+domain-события (для правил
  «suspend при неоплате»).
- `routes/billing.js` — подписка/usage/планы + Checkout.
- Square — оставлен слот `squareProvider` (не реализован, по решению).

### MCP/API, Календарь
- Каталогизированы как первоклассные слои в ADR; event-bus экспортирует
  outbound-webhook для сторонних разработчиков маркетплейса (`webhook` action).
- Schedule read-model теперь принимает agent-задачи (kind=agent) — основа для
  «маршруты/календарь».

## 4. Исправлено (по QA-отчёту миграций)
- **QA-MIG-002 (096):** `uq_provider_bridge_per_company` — UNIQUE на
  `zenbooker_team_member_id`, чтобы один техник не давал видимость нескольким
  юзерам (миграция 100).
- **QA-MIG-004 (098):** при переносе номера на другую компанию upsert теперь
  сбрасывает tenant-scoped `group_id` и обновляет `capabilities`
  (`telephonyTenantService.buyNumber`).

## 5. Проверка
- Миграции 100/101 — полная цепочка 096→101 на копии прод-схемы проходит,
  идемпотентна (двойной прогон). `payments` дропнута, `fact_payments`
  сохранена, `automation_*`/`billing_*` созданы, 3 плана засеяны.
- 12 новых юнит-тестов (eventBus, rulesEngine conditions, ruleActions
  templating, onEvent run/skip) — зелёные.
- Полный сьют: 674 passed / 15 failed — те же pre-existing падения на master
  (stateMachine, documentTemplates, inboxWorker, paymentsRoute), не связаны.

## 6. НЕ делалось (сознательно, чтобы не сломать прод)
- Не переписаны payments/telephony/sync с нуля.
- Не введён Redis/очередь (setImmediate-диспетч; апгрейд — когда вырастет нагрузка).
- `payment_transactions`↔`zb_payments` не консолидированы (оба живые; отдельная
  задача с регрессом аналитики).
- `arConfigHelper` физически не удалён — помечен deprecated, чтобы не сломать
  текущие AR-триггеры до миграции конфигов в правила.

## 7. Долг / следующие шаги
1. UI-редактор правил (визуальный конструктор trigger→conditions→actions).
2. Agent-worker (исполнитель `kind=agent` задач через MCP-инструменты).
3. Миграция AR-конфигов из `arConfigHelper` в seed-правила, затем удаление.
4. Stripe `provider_price_id` в планах + webhook-эндпоинт (raw body) + UI
   биллинга/`/settings/billing`.
5. Очередь (BullMQ/Redis) для event-dispatch при росте объёма.
6. Консолидация `payment_transactions`↔`zb_payments` с регрессом analytics-вьюх.

## Миграции этого прохода
- `100_platform_core_event_rules_agent.sql`
- `101_platform_billing.sql`

К деплою накоплено: **096–101** (6 миграций).
