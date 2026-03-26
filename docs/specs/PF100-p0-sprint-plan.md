# Спецификация: PF100 — P0 Sprint Plan

**Дата:** 2026-03-24
**Статус:** Proposed
**Основа:** `PF000` + `PF001..PF006`

---

## Цель

Разложить P0 Core Business Suite на реалистичную последовательность спринтов так, чтобы:

- не сломать текущие `Pulse / Leads / Jobs / Payments`;
- не упереться в blocked dependencies;
- сначала построить foundation, потом user-facing surfaces;
- не начинать одновременно слишком много новых доменов.

---

## Принципы планирования

1. `Automation / event foundation` идёт раньше пользовательских фич, которые на ней завязаны.
2. `Schedule` запускается раньше finance-doc stack, потому что он повышает операционную связность существующих `Jobs / Leads / Tasks`.
3. `Estimates -> Invoices -> Payment Collection -> Client Portal` идут именно в таком порядке.
4. `/payments` не заменяется новой страницей: он постепенно мигрирует в canonical ledger.
5. В каждом спринте должен быть чёткий vertical slice, который можно проверить отдельно.

---

## Sprint 1 — Foundation Contracts

### Цель

Подготовить foundation для событий, документов и платежей без вывода полной клиентской функциональности.

### Scope

- `PF006` foundation only:
  - canonical `domain_events`
  - automation rule model
  - execution queue model
  - migration path для текущих `Action Required` triggers
- shared contracts для:
  - estimate/invoice item model
  - document delivery model
  - payment transaction model
  - portal access token model
- route/service/query skeletons для:
  - `/api/automations`
  - `/api/estimates`
  - `/api/invoices`
  - `/api/payments`
  - `/api/portal`
  - `/api/schedule`

### Выход спринта

- утверждены schema contracts;
- утверждены API contracts;
- понятен worker split для automations;
- можно безопасно начинать feature-specific implementation.

### Не входит

- полноценный UI для users;
- клиентский portal UI;
- live payment processing.

---

## Sprint 2 — Schedule / Dispatcher MVP

### Цель

Запустить operational `/schedule`, используя уже существующие `Jobs / Leads / Tasks / Providers`.

### Scope

- `PF001`:
  - route `/schedule`
  - `Day / Week / Month / Timeline / Timeline Week`
  - unified read model
  - filters
  - quick-view sidebar
  - deeplinks в `Job`, `Lead`, `Pulse`
- create-from-slot для:
  - `Task`
  - `Lead`
  - `Job` shell
- realtime refresh for schedule items

### Зависимости

- shared event contracts из Sprint 1
- расширение task schedule fields, если требуется

### Exit criteria

- диспетчер видит всё планируемое в одном месте;
- drag-and-drop reschedule/reassign архитектурно определён и готов к включению;
- нет второй параллельной schedule entity.

---

## Sprint 3 — Estimates MVP

### Цель

Запустить первый client-facing document layer для продажи и согласования работ.

### Scope

- `PF002`:
  - `/estimates`
  - create from `Lead / Job / Contact / Pulse`
  - line items
  - draft/send flow
  - preview mode
  - SMS/email delivery
  - estimate events
- встраивание в:
  - `LeadDetailPanel`
  - `JobDetailPanel`
  - `Pulse` timeline/events

### Зависимости

- document delivery contracts из Sprint 1
- portal token model из Sprint 1

### Exit criteria

- estimate можно создать и отправить;
- событие отправки и просмотра стандартизованы;
- approved estimate уже проектно готов к `Lead -> Job` и `Invoice` flows.

---

## Sprint 4 — Invoices MVP

### Цель

Добавить второй document layer и связать его с `Jobs` и текущим payment ledger.

### Scope

- `PF003`:
  - `/invoices`
  - create from `Job`, approved `Estimate`, standalone
  - due dates / payment terms
  - invoice status model
  - send + preview
  - invoice summary inside `Jobs`
- canonical links между invoice detail и `/payments`

### Зависимости

- shared item model из Sprint 3
- payment model foundation from Sprint 1

### Exit criteria

- invoice создаётся и живёт как отдельный finance document;
- invoice status не зависит от ручного чтения `Payments`;
- `Job` начинает показывать актуальный invoice summary.

---

## Sprint 5 — Payment Collection MVP

### Цель

Сделать `/payments` operational ledger, а не только sync-report view.

### Scope

- `PF004`:
  - online checkout links
  - estimate deposits
  - invoice full/partial payment
  - manual offline payments
  - payment attempts
  - receipts
  - unified payment read model
- migration `/payments` UI на canonical payment API
- compatibility layer для legacy `/api/zenbooker/payments`

### Зависимости

- Sprint 3 and 4 documents
- provider webhook handling and idempotency

### Exit criteria

- estimate/invoice реально принимают оплату;
- `/payments` видит и legacy synced payments, и новые collected payments;
- failure paths и receipts стандартизованы.

---

## Sprint 6 — Client Portal MVP

### Цель

Открыть единый self-service слой для клиентов.

### Scope

- `PF005`:
  - public portal route
  - `Inbox`
  - `My bookings`
  - `Profile`
  - magic-link/token access
  - portal document actions
  - cards on file / payment history
- internal preview mode для estimates/invoices

### Зависимости

- Sprint 3 estimates
- Sprint 4 invoices
- Sprint 5 payment collection

### Exit criteria

- client send flows ведут в единый portal;
- клиент может approve/sign/pay;
- team получает нормализованные portal events.

---

## Sprint 7 — Automation Productization & Cross-Feature Hardening

### Цель

Довести foundation automations до user-usable product surface и закрыть cross-feature integration.

### Scope

- `PF006` full:
  - `/settings/automations`
  - rules CRUD
  - execution log
  - templates
  - retries / dead-letter visibility
- migration current `Actions & Notifications` на rule engine
- cross-feature templates:
  - appointment reminder
  - estimate follow-up
  - invoice overdue reminder
  - payment receipt notification
  - create task/action-required on key events

### Зависимости

- all previous sprints
- worker execution path from Sprint 1 foundation

### Exit criteria

- automations не special-case logic, а общий движок;
- reminders и follow-ups конфигурируются без code changes;
- все P0 domains publish canonical events.

---

## Итоговый порядок реализации

1. Sprint 1 — foundation contracts + automation/event base
2. Sprint 2 — `PF001 Schedule / Dispatcher`
3. Sprint 3 — `PF002 Estimates`
4. Sprint 4 — `PF003 Invoices`
5. Sprint 5 — `PF004 Payment Collection`
6. Sprint 6 — `PF005 Client Portal`
7. Sprint 7 — `PF006 Automation Engine` productization

---

## Риски порядка

### Если начать с Portal раньше

- придётся делать client surface без реальных estimates/invoices/payments;
- получится декоративный портал без business value.

### Если начать с Payments раньше Invoices

- collection layer будет не к чему привязывать, кроме абстрактных links;
- возрастёт шанс двойной финансовой модели.

### Если отложить Automation Foundation

- события придётся зашивать ad-hoc logic в каждом PF;
- позже миграция будет значительно дороже.

---

## Артефакты, которые должны сопровождать каждый спринт

- functional spec update
- technical design update
- API contract update
- DB schema delta
- test-case package
- rollout / migration notes
