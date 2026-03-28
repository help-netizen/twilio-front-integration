# Спецификация: PF006 — Automation Engine

**Дата:** 2026-03-24
**Статус:** Proposed
**Приоритет:** P2
**Зависит от:** текущие `Action Required`, `tasks`, `Quick Messages`, `workers`, `realtime`; shared event contracts from `PF001-PF005`

---

## Цель

Создать единый automation engine для автоматических сообщений, внутренних задач и системных действий по событиям продукта.

Этот engine должен заменить набор специальных локальных правил и стать общей основой для:

- reminders
- follow-ups
- status-based notifications
- task creation
- action-required escalation
- document/payment/portal workflows

По текущему roadmap это deferred package, а не часть первой продуктовой волны: до него допускается использовать существующие `Action Required`, thread-level tasks и отдельные special-case rules как временный operational baseline.

---

## Что уже есть

- `ActionRequiredSettingsPage` уже умеет конфигурировать auto-flagging и auto-task creation.
- `inboxWorker` и `conversationsService` уже создают `Action Required` и tasks по inbound events.
- `tasks` уже существуют в backend.
- `Quick Messages` уже дают reusable текстовые шаблоны.
- есть `realtimeService`, webhook ingestion и worker groundwork.

Это означает, что automation engine должен строиться на existing event/data foundation, а не поверх отдельного сервиса вне приложения.

---

## Встраивание в текущий продукт

### Новый route

Для initial release:

- добавить route `/settings/automations`

Это позволяет быстро встроить automation center без перегруза главной nav.

### Миграция текущих настроек

Текущая `Actions & Notifications` страница не удаляется.

Требование:

- её триггеры (`inbound_sms`, `missed_call`, `voicemail`) должны стать special-case UI поверх того же rule engine;
- backend logic не должна оставаться дублирующейся.

---

## Пользовательские сценарии

1. Пользователь включает appointment reminder за 1 день до job.
2. Система автоматически отправляет follow-up, если estimate sent, но не approved через 3 дня.
3. Система отправляет overdue invoice reminder.
4. Система создаёт task и Action Required по событию портала или неуспешной оплате.
5. Администратор просматривает execution log и видит, какие rules сработали, пропустились или упали.

---

## Функциональные требования

### 1. Rule model

Каждое automation rule должно иметь:

- `name`
- `status` (`active`, `paused`, `draft`)
- `trigger_family`
- `time_mode`
- `conditions`
- `actions`
- `cooldown / dedupe policy`
- `created_by`
- `updated_by`

### 2. Supported trigger families

В целевом initial engine должен поддержать:

- `job`
- `lead`
- `estimate`
- `invoice`
- `payment`
- `task`
- `portal`
- `call`
- `message`

Примеры событий:

- job scheduled start approaching
- job status changed
- lead created
- estimate sent / viewed / approved / declined
- invoice sent / due / overdue / paid
- payment succeeded / failed
- task created / due
- portal contact updated
- missed call / voicemail / inbound sms

Если событие пользовательски значимо для оператора, оно должно не только попадать в `domain_events`, но и рендериться как item в текущем `Pulse` timeline, а не в отдельной automation/event ленте.

### 3. Time modes

Поддержать:

- immediately
- X before field date/time
- X after field date/time
- relative to status change

### 4. Conditions

Rule conditions должны уметь фильтровать по:

- status / source / job type
- tags
- provider / assignee / owner
- service area / zip / territory
- channel availability (`has_phone`, `has_email`)
- amount threshold
- business hours / day-of-week

### 5. Actions

В initial engine обязательны actions:

- send SMS
- send email
- create task
- set action required
- assign owner
- send webhook
- update simple field/status on supported entities

### 6. Message composition

Automation messages должны использовать:

- existing Quick Message concepts;
- current custom-field placeholders;
- new canonical shortcodes.

Для совместимости engine должен уметь резолвить:

- текущий placeholder-style для existing business data;
- canonical tokens вида `{{contact.full_name}}`, `{{job.start_at}}`, `{{invoice.balance_due}}`.

### 7. Templates

В initial release должны быть готовые templates:

- appointment reminder
- missed call follow-up
- estimate follow-up
- estimate approved internal notification
- invoice overdue reminder
- payment receipt notification
- create invoice when job marked done

### 8. Execution model

Engine обязан поддерживать:

- event ingestion
- rule matching
- queued execution
- retry
- dead-letter / failed execution visibility
- idempotency per rule + entity + time window

### 9. Audit and visibility

Пользователь должен видеть:

- список rules
- draft/paused/active state
- last run
- next scheduled run, если применимо
- execution history
- failure reasons

### 10. Realtime integration

Actions и automation-created artifacts должны отражаться в realtime flows:

- созданные tasks
- новые action-required states
- updated document states
- internal notifications

### 11. Worker architecture

Automation engine должен соответствовать planned worker split из `RF009`:

- web runtime не должен выполнять всю delayed/scheduled automation logic inline;
- scheduled execution и retries должны жить в dedicated worker path;
- inline request path допустим только для lightweight immediate dispatch.

---

## Data / API требования

### Backend contracts

Нужны как минимум:

- `GET /api/automations`
- `POST /api/automations`
- `GET /api/automations/:id`
- `PATCH /api/automations/:id`
- `POST /api/automations/:id/pause`
- `POST /api/automations/:id/resume`
- `GET /api/automations/:id/executions`

### Data model

Нужны сущности:

- `automation_rules`
- `automation_rule_conditions`
- `automation_rule_actions`
- `automation_executions`
- `domain_events`

`domain_events` должны стать canonical event stream для rule engine, а не ad-hoc набором прямых вызовов.

---

## Ограничения

- visual flow-builder automation UI не входит в initial scope;
- AI-generated rules не входят в initial scope;
- многошаговые branching workflows не входят в initial scope;
- marketplace/add-on gating не входит в initial scope.

---

## Acceptance criteria

- Все текущие special-case Action Required automations могут быть выражены как rules того же engine.
- Пользователь может создать и запустить reminders/follow-ups без code changes.
- Engine поддерживает jobs, leads, estimates, invoices, payments, tasks, portal events.
- Есть execution log, retries и idempotency.
- Automation-created tasks и action-required signals видны в текущем UI через realtime.
- Worker model совместима с planned lifecycle separation из `RF009`.
