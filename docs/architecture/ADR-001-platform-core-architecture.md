# ADR-001 — Albusto Platform Core Architecture

**Date:** 2026-06-13 · **Status:** Accepted · **Scope:** whole platform
**Decision driver:** проект вырос до ~100k LOC (48k backend / 51k frontend, 105
миграций) органически; нужен единый хребет, на который вешаются 8 направлений:
user-задачи, agent-задачи, события+логирование, rules-engine (скрипты по
событиям/таймеру), биллинг tenant-компаний, Stripe/Square, MCP/API,
маршруты/календарь.

---

## 1. Текущее состояние (анализ)

### Что работает хорошо (reuse, не трогаем)
- **RBAC / multi-tenant** (PF007 + ALB-100): deny-by-default, provider scope,
  `req.companyFilter`, platform/tenant разделение. Зрелый слой.
- **`domain_events`** — company-scoped append-only лог (event_type, payload,
  created_at). Готовая основа для event-sourcing.
- **`eventService.logEvent()`** + `getEntityHistory()` — merge доменных
  событий с заметками сущности. Переиспользуем как writer.
- **Telephony** (ALB-107): subaccount-per-tenant — чистая изоляция.
- **FSM/SCXML** (FSM-001) — графовый редактор статусов джобов. Переиспользуем
  движок для rules-engine actions на переходах.
- **Schedule** (PF001/F013) — unified read-model jobs+leads+tasks. База для
  «Маршруты/Календарь».

### Архитектурный долг (зафиксирован, чинится поэтапно)
| Проблема | Где | План |
|---|---|---|
| Триггеры зашиты в код | `arConfigHelper.getTriggerConfig` хардкодит `missed_call`/`inbound_sms` | → rules-engine (этот ADR) |
| 4 платёжные таблицы | `payments`(0), `fact_payments`(0) мертвы; `payment_transactions`(канон), `zb_payments`(источник) | дропнуть 2 мёртвые (этот проход); канон ↔ zb consolidation — отдельно |
| Legacy root `src/` | `frontAPI.js` (Front заброшен), `jwtService/callFormatter` (только тесты) | frontAPI удалён; tested-utils помечены |
| Раннер миграций глотает ошибки | `apply_migrations.js` | заменить на транзакционный с журналом (TASK ниже) |
| Provider bridge без UNIQUE | `company_user_profiles.zenbooker_team_member_id` | partial unique index (этот проход, по QA-MIG-002) |
| number conflict оставляет stale scope | `phone_number_settings` upsert | reset group_id/metadata при смене компании (по QA-MIG-004) |
| Realtime-транскрипция dormant | `mediaStreamServer`→`realtimeTranscriptService`→`assemblyAIBridge` | за фиче-флагом, оставить |

---

## 2. Целевая архитектура — Event-driven core

Хребет платформы — **шина доменных событий** + **rules-engine**. Всё
остальное (задачи, уведомления, биллинг-usage, агенты) — потребители событий.

```
┌──────────────────────────────────────────────────────────────────┐
│  PRODUCERS (доменные действия)                                     │
│  jobs / leads / contacts / calls / sms / payments / telephony …    │
│        │  emit(companyId, eventType, payload, actor)               │
│        ▼                                                            │
│  eventBus.emit()  ──►  domain_events (append-only, company-scoped) │  ← запись/логирование
│        │                                                           │
│        ▼  (async dispatch, at-least-once)                          │
│  ┌──────────────┐   ┌──────────────┐   ┌──────────────────────┐   │
│  │ rules-engine │   │ task-engine  │   │ billing usage meter   │   │
│  │ (правила)    │   │ user+agent   │   │ (telephony/seats/…)   │   │
│  └──────┬───────┘   └──────┬───────┘   └──────────┬───────────┘   │
│         ▼                  ▼                       ▼               │
│   actions:           tasks (user/agent)     Stripe usage records  │
│   send_sms /         assignment / due /     subscription invoices │
│   send_email /       SLA / approval         (платёжный провайдер) │
│   create_task /                                                    │
│   webhook / run_agent                                              │
└──────────────────────────────────────────────────────────────────┘
        ▲                                              ▲
        │ TIMER triggers (cron/scheduler)              │ external webhooks
        │ "через 24ч после X", "каждое утро"           │ Stripe/Square/Twilio
```

### 2.1 Event Bus (`eventBus`)
- Единая точка `emit(companyId, eventType, payload, { actorType, actorId, aggregate })`.
- Пишет в `domain_events` (источник правды) **синхронно**, диспетчит
  подписчикам **асинхронно** (setImmediate сейчас, очередь Redis позже).
- `eventType` — стабильный каталог (`job.status_changed`, `lead.created`,
  `call.missed`, `sms.inbound`, `payment.succeeded`, `provider.assigned`, …).
- Подписчики регистрируются декларативно; ошибка подписчика не валит emit.
- Обёртка над существующим `eventService.logEvent` (обратная совместимость).

### 2.2 Rules Engine (декларативные правила, редактор в UI)
Таблицы: `automation_rules`, `automation_rule_runs`.
- **Trigger:** `event` (тип события + фильтр-условия по payload) **или**
  `schedule` (cron / «через N после события»).
- **Conditions:** JSON-логика (field op value, AND/OR) над payload+контекстом.
- **Actions:** упорядоченный список — `send_sms`, `send_email`,
  `create_task`, `assign_task`, `set_action_required`, `webhook`,
  `run_agent_task`, `fsm_transition`. Каждый action — провайдер-исполнитель.
- Шаблоны сообщений с подстановкой `{{contact.name}}`, `{{job.status}}`.
- Исполнение идемпотентно (dedupe key event×rule), пишет `automation_rule_runs`
  (статус, ошибка, тайминги) — наблюдаемость.
- Примеры из ТЗ: «job → status=Visit completed ⇒ SMS клиенту»; «provider
  assigned ⇒ SMS технику»; «через 24ч после lead без касания ⇒ task диспетчеру».

### 2.3 Task Engine (user + agent задачи, единая модель)
Расширяем существующую `tasks`:
- `kind`: `user` | `agent`.
- user-задачи: assignment (crm_users), due/SLA, приоритет, связь с thread/job.
- agent-задачи: `agent_type`, `input` (JSON), `output`, `status`
  (queued/running/succeeded/failed), запускаются rules-engine action
  `run_agent_task` или вручную; исполняются воркером (MCP-инструменты).
- Обе видны в одном списке/календаре (Schedule уже это умеет для user-tasks).

### 2.4 Billing (платформа ↔ tenant) — Stripe Billing
Таблицы: `billing_subscriptions`, `billing_usage_records`, `billing_invoices`.
- Провайдер-агностичный слой `billingProvider` (Stripe сейчас, Square потом).
- Платформа выставляет tenant-компаниям подписку (seat-based + metered:
  telephony usage из ALB-107, SMS-объём, agent-runs).
- Webhook Stripe → `billing_*` + `domain_events` (`subscription.updated`,
  `invoice.paid`, `payment.failed` → rule «suspend company при неоплате»).
- **Отделено** от tenant→client платежей (PF004 `payment_transactions`).

### 2.5 MCP / API
- Уже есть: integrations API (`/api/v1/integrations`), CRM Sales MCP.
- Каталогизируем как **первоклассный capability-слой**: внешние приложения и
  agent-задачи ходят через тот же scoped-API (api_integrations ключи).
- Event Bus экспортирует подписку «external webhook» — tenant получает свои
  события на свой endpoint (для сторонних разработчиков маркетплейса).

### 2.6 Routes / Calendar
- Schedule read-model расширяется agent-задачами (kind=agent с датой) и
  правило-сгенерированными task'ами.
- Маршрутизация (drive-time оптимизация) — отдельная фича поверх календаря,
  потребляет geo из contacts/jobs (lat/lng уже есть).

---

## 3. Решения (this iteration)

1. **Хребет + чистка** — реализуем event-bus, rules-engine (schema+engine+
   actions), agent-task модель, billing schema + Stripe-слой skeleton. НЕ
   ломаем работающие подсистемы.
2. **Stripe Billing** — провайдер-агностичная абстракция, Stripe-реализация.
3. **Платежи tenant→client** — дропнуть 2 мёртвые таблицы; канон↔zb остаётся.
4. Мигрируем хардкод-триггеры (`arConfigHelper`) на rules-engine как 2
   seed-правила (обратная совместимость, старый код помечен deprecated).

## 4. Не делаем (явно, чтобы не сломать прод)
- Не переписываем payments/telephony/sync с нуля.
- Не вводим Redis/очередь сейчас (setImmediate-диспетч, апгрейд позже).
- Не консолидируем `payment_transactions`↔`zb_payments` в этот проход.
- Не трогаем FSM-движок (переиспользуем как action).

## 5. Миграции этого прохода
- `100` — event bus dispatch журнал + rules engine (`automation_rules`,
  `automation_rule_runs`), agent-task поля на `tasks`, drop мёртвых
  `payments`/`fact_payments`, integrity-фиксы 096/098 (по QA).
- `101` — billing (`billing_subscriptions`, `billing_usage_records`,
  `billing_invoices`).
