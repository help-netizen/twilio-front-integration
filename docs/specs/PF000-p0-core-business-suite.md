# Спецификация: PF000 — P0 Core Business Suite

**Дата:** 2026-03-24
**Статус:** Proposed
**Горизонт:** P0

---

## Цель

Подготовить связанный пакет базовых бизнес-фич, без которых Blanc ещё не воспринимается как полнофункциональный field-service / contact-center продукт:

- единый `Schedule / Dispatcher`
- `Estimates`
- `Invoices`
- operational `Payment Collection`
- `Client Portal`

Этот пакет должен встраиваться в уже существующий продуктовый фундамент, а не создавать параллельные сущности и дублирующие интерфейсы.

---

## Текущий фундамент

В проекте уже существуют:

- `Pulse` как главный коммуникационный workspace
- `Softphone` и Twilio-based call flows
- `Contacts / Leads / Jobs`
- `Payments` как текущий ledger/reporting слой
- `Messages` как SMS conversation layer
- `Quick Messages`
- `Action Required + thread tasks`
- `Users / Providers / Telephony settings`
- `Zenbooker`-based jobs, timeslots, providers и sync
- `realtimeService` + SSE
- worker groundwork (`inboxWorker`, `snoozeScheduler`, `reconcileStale`)

Поэтому новые P0-фичи обязаны:

1. переиспользовать текущие `contacts`, `leads`, `jobs`, `tasks`, `payments` и realtime;
2. не заводить отдельный "второй CRM" для schedule/finance/portal;
3. использовать существующие entry points в `Pulse`, `Leads`, `Jobs`, `Contacts`, `Payments`, `Settings`;
4. оставлять `authedFetch`, текущую auth-модель и `backend/src/services/*` основой backend contracts.

---

## Состав пакета

- [PF001 — Unified Schedule / Dispatcher](/Users/rgareev91/contact_center/twilio-front-integration/docs/specs/PF001-unified-schedule-dispatcher.md)
- [PF002 — Estimates](/Users/rgareev91/contact_center/twilio-front-integration/docs/specs/PF002-estimates.md)
- [PF003 — Invoices](/Users/rgareev91/contact_center/twilio-front-integration/docs/specs/PF003-invoices.md)
- [PF004 — Payment Collection](/Users/rgareev91/contact_center/twilio-front-integration/docs/specs/PF004-payment-collection.md)
- [PF005 — Client Portal](/Users/rgareev91/contact_center/twilio-front-integration/docs/specs/PF005-client-portal.md)

---

## Общие продуктовые принципы

### 1. Один источник правды по сущностям

- `Contacts`, `Leads`, `Jobs`, `Tasks`, `Payments` остаются canonical business records.
- `Schedule`, `Portal`, `Automations`, `Estimates`, `Invoices` работают поверх этих сущностей и создают новые только там, где их реально ещё нет.

### 1a. `Pulse` остаётся главным operator workspace

- `Pulse` является canonical client timeline и основным event-centric workspace для операционного контура.
- `Schedule` является важным dispatch/planning surface, но не должен становиться главным activity center продукта.
- новые P0-фичи должны встраиваться в `Pulse`, а не вытеснять его альтернативными event feeds.
- communication- и phone-related направления тоже должны рассматриваться как часть `Pulse`, его timelines и queue-state, а не как отдельные operator workspaces.

### 2. Связь с Pulse обязательна

Все клиентские события высокого значения должны отражаться в текущем `Pulse` timeline, то есть прямо внутри существующей хронологии, где сейчас показываются сообщения и звонки.

Это означает:

- не отдельный finance/event feed;
- не отдельный portal activity widget как primary surface;
- а timeline items внутри уже существующего Pulse thread/timeline UI;
- при необходимости эти же события дополнительно поднимают `Action Required`, но основной способ отображения для оператора — текущий timeline.

Обязательные события:

- estimate sent / viewed / approved / declined
- invoice sent / overdue / paid
- portal action
- payment received / failed
- automation-created task / reminder / escalation

### 3. Клиентские ссылки должны идти через portal layer

- estimate/invoice send flow не должен отдавать сырые приватные backend links;
- клиент всегда попадает в controlled `Client Portal` experience;
- внутренний preview mode для сотрудников не должен совпадать с клиентским доступом.

### 4. Автоматизации не должны жить отдельной логикой

- текущие `Action Required` триггеры и будущие reminders/follow-ups должны работать на общем automation/event engine;
- старые специальные настройки могут сохраниться как упрощённый UI, но не как отдельный backend path.

### 5. Finance сначала job-centric

- финансовые документы должны быть привязаны к `lead` и/или `job`, а не жить как standalone records;
- `Estimate` и `Invoice` развиваются как связанные document flows поверх существующих `Lead / Job`, сохраняя reporting/automation consistency.

### 6. Не копировать слабые ограничения Workiz без причины

Если текущая архитектура Blanc позволяет сделать лучше, допускается отступление от Workiz, но только при сохранении:

- быстрого вывода на рынок
- предсказуемого UX
- простой операционной модели

---

## Последовательность реализации

### Wave A — Foundation

1. `PF008 Pulse client timeline core` foundation
2. `PF001 Unified Schedule / Dispatcher`
3. shared finance/domain contracts for estimates/invoices/payments

### Wave B — Finance

1. `PF002 Estimates`
2. `PF003 Invoices`
3. `PF004 Payment Collection`

### Wave C — Client-facing layer

1. `PF005 Client Portal`
2. final Pulse + notification integrations

---

## Что не входит в этот пакет

- `Price Book`
- `Online Booking`
- `Dashboard & Reports`
- `QuickBooks`
- `Granular Roles & Permissions`
- `Phone Ops for field scenarios`
- `Automation Engine`
- `Task center / automation templates`

Эти фичи идут следующим приоритетом после стабилизации P0-core.
