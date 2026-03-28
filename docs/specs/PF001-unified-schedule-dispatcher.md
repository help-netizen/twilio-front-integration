# Спецификация: PF001 — Unified Schedule / Dispatcher

**Дата:** 2026-03-24
**Статус:** Proposed
**Приоритет:** P0
**Зависит от:** текущие `Leads`, `Jobs`, `Contacts`, `Providers`, `Pulse tasks`, realtime foundation

---

## Цель

Создать единое dispatch-workspace, где операторы и диспетчеры видят и управляют всеми запланированными `jobs`, `leads` и `tasks` в одном календарном интерфейсе.

`Schedule` должен стать сильным dispatch/planning surface рядом с `Pulse`, но не заменять `Pulse` как главный operator workspace по клиенту и событиям.

---

## Что уже есть

- `Jobs` уже содержат schedule-related данные, providers, tags и статусы.
- `Leads` уже могут содержать service/date context и конвертироваться в jobs.
- `Providers` уже доступны через Zenbooker-backed страницу.
- В `Pulse` уже есть thread-level tasks и `Action Required`.
- Есть Zenbooker timeslots и territory logic в текущем lead-to-job flow.
- Есть SSE для job/thread updates.

---

## Встраивание в текущий продукт

### Новый route

- Добавить top-level route `/schedule`.
- Не смешивать его с telephony schedules в `/settings/telephony/*`.

### Навигация

- `Schedule` должен появиться в главной navigation рядом с `Pulse`, `Leads`, `Jobs`, `Contacts`, `Payments`.
- `Pulse` остаётся canonical event-centric workspace, где оператор читает клиентскую историю и работает с сигналами.
- `Schedule` отвечает за планирование, назначение и перенос работы, а не за полную клиентскую историю.
- Из `Jobs`, `Leads`, `Pulse` и `Contacts` должны быть deeplink-переходы в конкретный schedule slot/item.

### Связь с существующими экранами

- клик по item на schedule открывает quick-view sidebar;
- из quick-view можно:
  - открыть полную карточку `Job`
  - открыть полную карточку `Lead`
  - открыть `Pulse` thread
  - позвонить через `Softphone`
  - открыть SMS / timeline
- из `Pulse` должно быть возможно перейти в релевантный schedule context для событий типа `schedule`, `reschedule`, `assignment`, `follow-up`.

### Связь с Pulse

- `Schedule` не создаёт отдельный activity log по клиенту.
- client-significant dispatch события (`job scheduled`, `job rescheduled`, `provider reassigned`, `task scheduled`) должны отражаться в `Pulse` timeline по правилам `PF008`.
- `Action Required / Snooze / Tasks` остаются operator controls и queue-signals в `Pulse`; schedule использует их как operational inputs, но не перехватывает их primary UX.

---

## Пользовательские сценарии

1. Диспетчер видит все jobs, leads и tasks на день/неделю и быстро понимает загрузку команды.
2. Диспетчер drag-and-drop переносит job на другой слот или reassignment к другому provider.
3. Оператор открывает item в sidebar, звонит клиенту, пишет SMS и обновляет статус без ухода со schedule.
4. Пользователь создаёт новый job или lead прямо из пустого временного слота.
5. Пользователь видит unassigned work и быстро распределяет его по providers.
6. Оператор видит в `Pulse`, что клиент просит перенести визит, и из карточки клиента быстро открывает нужный schedule context для reschedule.

---

## Функциональные требования

### 1. Calendar views

`Schedule` должен поддерживать 5 представлений:

- `Day`
- `Week`
- `Month`
- `Timeline`
- `Timeline Week`

`Timeline` и `Timeline Week` являются основными dispatch views.

### 2. Какие сущности отображаются

В schedule отображаются:

- `Jobs`
- `Leads`
- `Tasks`

Правила:

- `Jobs` и `Leads` без даты/времени не показываются на таймлайне, но должны быть доступны в `Unscheduled / Unassigned` секции.
- `Tasks` отображаются как scheduled item только если у них есть date/time anchor; иначе остаются в list-mode внутри sidebar/filter drawer.
- `Completed` и `Cancelled` сущности скрываются по умолчанию, но доступны через фильтры.

### 3. Цвета и визуальная модель

- item color по умолчанию привязан к provider/assignee;
- если provider не назначен, используется neutral/unassigned style;
- `Lead`, `Job`, `Task` должны визуально различаться типом item;
- overdue task и urgent lead должны иметь заметные state indicators, но без визуального шума.

### 4. Sidebar quick view

При выборе item открывается sidebar с:

- entity type + ID
- client/contact name
- phone / email
- service address
- date/time slot
- assigned provider / owner
- status
- job type / source / tags
- быстрыми действиями:
  - `Call`
  - `Message`
  - `Open in Pulse`
  - `Open full page`
  - `Reschedule`
  - `Reassign`
  - `Mark status`

### 5. Drag-and-drop dispatch actions

В `Timeline` и `Timeline Week` пользователь должен иметь возможность:

- перенести item во времени;
- изменить длительность;
- назначить или сменить provider;
- переместить unassigned item в provider lane;
- быстро создавать item drag-выделением пустого слота.

Изменения должны обновлять underlying entity, а не временную копию schedule item.

### 6. Create-from-slot

Из пустого slot пользователь может создать:

- `Job`
- `Lead`
- `Task`

Интеграция:

- job creation использует существующую job/domain модель;
- lead creation использует текущие lead form settings и contact dedupe;
- task creation использует существующую tasks layer из Pulse, а не отдельную task-сущность.

### 7. Filters

Обязательные фильтры:

- entity type
- status
- provider / assignee
- source
- job type
- tags
- service area / territory
- `only unassigned`
- `only action required`

Фильтры должны работать одинаково для list/time-based views.

### 8. Business hours

- Schedule обязан учитывать company timezone.
- Business hours на schedule не должны дублировать telephony business hours.
- Для P0 допускается отдельная business-hours config для dispatch schedule.

### 9. Realtime

Schedule должен обновляться без manual refresh при:

- job update
- lead update
- task create/update/complete
- assignment change
- automation-created task

Если realtime event нельзя применить patch-wise, допускается slice refetch.

---

## Data / API требования

### Backend

Нужен unified schedule read layer:

- `GET /api/schedule/items`
- `PATCH /api/schedule/items/:id/reschedule`
- `PATCH /api/schedule/items/:id/reassign`
- `POST /api/schedule/items/from-slot`

Требования:

- не хранить schedule как отдельную primary business table;
- использовать aggregation layer поверх `jobs`, `leads`, `tasks`, `providers`;
- возвращать единый item contract с `entity_type`, `entity_id`, `start_at`, `end_at`, `assignee`, `status`, `display_color`, `contact summary`.

### Data model

- `Jobs` остаются source of truth для job schedule.
- `Leads` остаются source of truth для lead schedule.
- `Tasks` остаются source of truth для tasks.
- Если task сейчас не имеет достаточных schedule fields, их нужно расширить в существующей task model, а не создавать `schedule_tasks`.

---

## Ограничения

- route optimization, maps и GPS не входят в P0;
- payroll, time tracking и clock-in/out не входят в P0;
- telephony queue dashboard не заменяется schedule-экраном;
- recurring jobs не входят в scope этого пакета.

---

## Acceptance criteria

- Пользователь видит `jobs`, `leads`, `tasks` в едином `/schedule`.
- Есть `Day / Week / Month / Timeline / Timeline Week`.
- Drag-and-drop реально меняет дату/время/assignee underlying record.
- `Schedule` не становится второй клиентской историей: все client-significant dispatch events продолжают отражаться в `Pulse`.
- Из любого item доступны `Call`, `Message`, `Open in Pulse`, `Open full page`.
- Create-from-slot создаёт валидный `job`, `lead` или `task`.
- Schedule обновляется через realtime без ручного reload.
- Не создаётся вторая параллельная task/job/lead domain model.
