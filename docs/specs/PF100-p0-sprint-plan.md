# Спецификация: PF100 — P0 Sprint Plan

**Дата:** 2026-03-24 (updated 2026-03-29)
**Статус:** In Progress — Sprint 1 ✅ Complete, Sprint 2 ✅ Complete
**Основа:** `PF000` + `PF001..PF005`

---

## Цель

Разложить P0 Core Business Suite на реалистичную последовательность спринтов так, чтобы:

- не сломать текущие `Pulse / Leads / Jobs / Payments`;
- не упереться в blocked dependencies;
- сначала построить foundation, потом user-facing surfaces;
- не начинать одновременно слишком много новых доменов.

---

## Принципы планирования

1. `Pulse` остаётся главным event-centric workspace, поэтому `Schedule` запускается как dispatch/planning surface поверх этого foundation, а не как новый центр продукта.
2. `Estimates -> Invoices -> Payment Collection -> Client Portal` идут именно в таком порядке.
3. `/payments` не заменяется новой страницей: он постепенно мигрирует в canonical ledger.
4. Automation package (`PF006`) считается deferred и не должен блокировать текущий P0 rollout.
5. В каждом спринте должен быть чёткий vertical slice, который можно проверить отдельно.

---

## Sprint 1 — Foundation Contracts

### Цель

Подготовить foundation для документов, portal access и payment linkage без вывода полной клиентской функциональности.

### Scope

- shared contracts для:
  - estimate/invoice item model
  - document delivery model
  - payment transaction model
  - portal access token model
- route/service/query skeletons для:
  - `/api/estimates`
  - `/api/invoices`
  - `/api/payments`
  - `/api/portal`
  - `/api/schedule`

### Выход спринта

- утверждены schema contracts;
- утверждены API contracts;
- можно безопасно начинать feature-specific implementation.

### Не входит

- полноценный UI для users;
- клиентский portal UI;
- live payment processing.

---

## Sprint 2 — Schedule / Dispatcher MVP

### Цель

Запустить operational `/schedule` как planning/dispatch surface, используя уже существующие `Jobs / Leads / Tasks / Providers` и не вытесняя `Pulse` как основной client/event workspace.

### Scope

- `PF001`:
  - route `/schedule`
  - `Day / Week / Month / Timeline / Timeline Week`
  - unified read model
  - filters
  - quick-view sidebar
  - deeplinks в `Job`, `Lead`, `Pulse`
  - client-significant dispatch events публикуются в `Pulse`
- create-from-slot для:
  - `Task`
  - `Lead`
  - `Job` shell
- realtime refresh for schedule items

### Зависимости

- shared event contracts из Sprint 1
- `PF008` Pulse timeline/realtime rules
- расширение task schedule fields, если требуется

### Exit criteria

- диспетчер видит всё планируемое в одном месте;
- drag-and-drop reschedule/reassign архитектурно определён и готов к включению;
- нет второй параллельной schedule entity.
- `Pulse` остаётся canonical client history, а schedule mutations публикуют события в его timeline.

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
  - create from `Job` и approved `Estimate`
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
  - recorded estimate deposits
  - invoice full/partial recorded payment
  - manual offline payments
  - receipts
  - unified payment read model
- migration `/payments` UI на canonical payment API
- compatibility layer для legacy `/api/zenbooker/payments`

### Зависимости

- Sprint 3 and 4 documents

### Exit criteria

- estimate/invoice получают linked recorded payments через canonical `/payments` ledger;
- `/payments` видит и legacy synced payments, и новые recorded payments;
- partial/full payment и receipts стандартизованы без card-processing scope.

---

## Sprint 6 — Client Portal MVP

### Цель

Открыть единый controlled client portal layer для документов и клиентских действий.

### Scope

- `PF005`:
  - public portal route
  - `Inbox`
  - `My bookings`
  - `Profile`
  - magic-link/token access
  - portal document actions
  - payment history / outstanding balances
- internal preview mode для estimates/invoices

### Зависимости

- Sprint 3 estimates
- Sprint 4 invoices
- Sprint 5 payment collection

### Exit criteria

- client send flows ведут в единый portal;
- клиент может approve/sign и просматривать документы/балансы;
- team получает нормализованные portal events.

---
## Итоговый порядок реализации

1. Sprint 1 — foundation contracts
2. Sprint 2 — `PF001 Schedule / Dispatcher`
3. Sprint 3 — `PF002 Estimates`
4. Sprint 4 — `PF003 Invoices`
5. Sprint 5 — `PF004 Payment Collection`
6. Sprint 6 — `PF005 Client Portal`

---

## Риски порядка

### Если начать с Portal раньше

- придётся делать client surface без реальных estimates/invoices/payments;
- получится декоративный портал без business value.

### Если пытаться сделать Schedule главным workspace вместо Pulse

- появится второй конкурирующий центр клиентской истории;
- finance, portal и automations начнут строить параллельные activity surfaces;
- операторская модель станет менее предсказуемой, чем текущий `Pulse-first` контур.

### Если начать с Payments раньше Invoices

- collection layer будет не к чему привязывать, кроме абстрактных links;
- возрастёт шанс двойной финансовой модели.

### Если слишком рано тащить Automation Engine в текущий P0

- вырастет scope первой волны без прямого short-term product payoff;
- команда размажет внимание между foundation, finance-docs и rule engine;
- текущие `Action Required`/thread-task mechanisms уже дают достаточный временный operational baseline.

---

## Артефакты, которые должны сопровождать каждый спринт

- functional spec update
- technical design update
- API contract update
- DB schema delta
- test-case package
- rollout / migration notes
