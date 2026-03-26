# Спецификация: PF105 — Pulse DB Tables & API Contracts

**Дата:** 2026-03-24
**Статус:** Proposed
**Основа:** `PF008`

---

## Цель

Зафиксировать proposed data model и canonical API contracts для `Pulse` как client timeline core.

Этот документ переводит продуктовую модель `PF008` в инженерные контракты.

---

## Архитектурные решения

1. `timelines` остаётся canonical client/thread identity.
2. `calls`, `recordings`, `transcripts`, `sms_conversations`, `sms_messages` остаются canonical communication storage.
3. Для non-call / non-sms Pulse-visible items вводится отдельный append-only слой `timeline_events`.
4. `domain_events` и `timeline_events` не сливаются:
   - `domain_events` — automation/rule engine stream;
   - `timeline_events` — operator-facing Pulse chronology projection.
5. `Action Required` current state продолжает жить в `timelines`, но его lifecycle должен дополнительно иметь history items.
6. `tasks` остаются canonical task records, но важные task mutations должны быть Pulse-visible.
7. `realtimeService` и SSE contracts документируются вместе с Pulse package, потому что они являются delivery layer для timeline, queue-state и cross-page event refreshes.
8. Active workflow controls не читаются из `timeline_events`: source of truth для current state остаётся в `timelines` и `tasks`, а timeline хранит history/projection.

---

## Existing tables reused

### Reuse without replacement

- `timelines`
- `calls`
- `recordings`
- `transcripts`
- `sms_conversations`
- `sms_messages`
- `sms_media`
- `tasks`
- `contacts`
- existing leads storage
- existing jobs storage

### Existing tables that need extension

## `timelines`

Рекомендуемые расширения:

- `last_activity_at`
- `latest_item_at`
- `latest_item_kind`
- `latest_item_preview`

Назначение:

- ускорить левый Pulse queue/list;
- перестать вычислять latest significant item только через `latest_call + latest_sms`.

## `tasks`

Расширения не обязательны для PF008 core, но task lifecycle должен иметь стабильный источник `created_at / completed_at / owner / priority` для Pulse rendering.

---

## Proposed tables

## 1. `timeline_events`

- `id`
- `timeline_id`
- `company_id`
- `contact_id`
- `event_family`
- `event_key`
- `source_type`
- `source_id`
- `actor_type`
- `actor_id`
- `occurred_at`
- `summary_text`
- `payload_json`
- `visibility_scope`
- `dedupe_key`
- `created_at`

Назначение:

- append-only Pulse-visible events for everything that is not already a canonical call/SMS record;
- хранит finance, portal, workflow, CRM/system items, которые должны рендериться в Pulse.

### Минимальные event families

- `workflow`
- `crm`
- `job`
- `finance`
- `portal`
- `automation`
- `system`

### Примеры event keys

- `thread.action_required_set`
- `thread.handled`
- `thread.snoozed`
- `thread.unsnoozed`
- `thread.assigned`
- `task.created`
- `task.completed`
- `lead.created`
- `lead.converted_to_job`
- `job.scheduled`
- `job.rescheduled`
- `job.provider_assigned`
- `job.status_changed`
- `estimate.sent`
- `estimate.viewed`
- `estimate.approved`
- `invoice.sent`
- `invoice.overdue`
- `invoice.paid`
- `payment.received`
- `payment.failed`
- `portal.opened`
- `portal.contact_updated`
- `automation.task_created`
- `automation.escalated`

---

## Canonical Pulse item contract

Каждый item в Pulse timeline должен возвращаться в unified shape:

- `item_id`
- `item_kind` — `call | sms | event | task`
- `item_family`
- `timeline_id`
- `contact_id`
- `company_id`
- `occurred_at`
- `summary`
- `status`
- `direction`
- `actor`
- `source`
- `preview`
- `payload`
- `deeplinks`

### Notes

- `call` and `sms` items materialize from existing tables;
- `event` items materialize from `timeline_events`;
- `task` items may materialize from `timeline_events` and/or `tasks`, but API must return one stable contract.
- active workflow controls должны приходить отдельно через `timeline` / `state`, даже если их lifecycle отражён в `items[]`.

---

## API contracts

## 1. Timeline read

### `GET /api/pulse/timeline-by-id/:timelineId`

Canonical Pulse timeline endpoint.

Ответ:

```json
{
  "ok": true,
  "timeline": {
    "id": 123,
    "contact_id": 456,
    "company_id": "uuid",
    "is_action_required": true,
    "action_required_reason": "estimate_approved",
    "snoozed_until": null,
    "owner_user_id": "uuid"
  },
  "contact": {
    "id": 456,
    "full_name": "John Smith",
    "phone_e164": "+15551234567"
  },
  "items": [
    {
      "item_id": "call:9001",
      "item_kind": "call",
      "item_family": "communication",
      "timeline_id": 123,
      "occurred_at": "2026-03-24T10:00:00Z",
      "summary": "Incoming call completed",
      "status": "completed",
      "direction": "inbound",
      "source": { "type": "call", "id": 9001 },
      "payload": {}
    },
    {
      "item_id": "event:801",
      "item_kind": "event",
      "item_family": "finance",
      "timeline_id": 123,
      "occurred_at": "2026-03-24T10:15:00Z",
      "summary": "Estimate approved",
      "status": "approved",
      "source": { "type": "estimate", "id": "uuid" },
      "payload": {
        "estimate_id": "uuid"
      }
    }
  ],
  "state": {
    "open_task": {
      "id": "uuid",
      "title": "Call client back",
      "priority": "p1",
      "due_at": "2026-03-24T11:00:00Z"
    }
  }
}
```

Design rule:

- `items[]` отвечает за chronology/history;
- `timeline` и `state` отвечают за active controls and queue-state;
- UI не должен восстанавливать текущее `Action Required / Snooze / open task` состояние через парсинг history items.

### `GET /api/pulse/timeline/:contactId`

Compatibility endpoint for current contact-based routing.

Требование:

- на rollout-период может адаптировать response к старым consumers;
- canonical direction развития — `timeline-by-id` + `items[]`.

## 2. Thread list / queue

### `GET /api/pulse/threads`

Фильтры:

- `q`
- `action_required_only`
- `owner_user_id`
- `unread_only`
- `include_snoozed`
- `page`
- `limit`

Ответ должен содержать:

- `timeline_id`
- `contact summary`
- `latest_item_at`
- `latest_item_kind`
- `latest_item_preview`
- `is_action_required`
- `action_required_reason`
- `snoozed_until`
- `open_task`
- `has_unread`

## 3. Timeline identity

### `POST /api/pulse/ensure-timeline`

Compatibility endpoint.

Canonical future route:

### `POST /api/pulse/timelines/ensure`

Тело:

```json
{
  "phone": "+15551234567",
  "contact_id": 456
}
```

## 4. Workflow actions on timeline

### `POST /api/pulse/threads/:timelineId/mark-handled`

### `POST /api/pulse/threads/:timelineId/snooze`

```json
{ "snoozed_until": "2026-03-25T09:00:00Z" }
```

### `POST /api/pulse/threads/:timelineId/assign`

```json
{ "owner_user_id": "uuid" }
```

### `POST /api/pulse/threads/:timelineId/tasks`

```json
{
  "title": "Call client back",
  "description": "Discuss estimate",
  "priority": "p1",
  "due_at": "2026-03-24T14:00:00Z"
}
```

### `POST /api/pulse/threads/:timelineId/set-action-required`

Требование:

- каждая из этих мутаций должна не только менять current state, но и писать Pulse-visible lifecycle item;
- при этом сами controls остаются отдельными operator actions вне timeline UI.

---

## Realtime contracts

Помимо текущих SSE событий, Pulse package должен поддерживать:

- `timeline.item_added`
- `timeline.item_updated`
- `timeline.state_updated`

### Existing events retained

- `thread.action_required`
- `thread.handled`
- `thread.snoozed`
- `thread.unsnoozed`
- `thread.assigned`
- `timeline.read`
- `timeline.unread`
- `call.created`
- `call.updated`
- `message.added`
- `message.delivery`
- `conversation.updated`
- `contact.read`
- `contact.unread`
- `transcript.delta`
- `transcript.finalized`
- `job.updated`

### Delivery classes

SSE contract в Pulse package должен покрывать 4 класса доставки:

- `timeline mutation`
- `thread state / queue refresh`
- `cross-page entity refresh`
- `notification / badge / bubble signal`

Rule:

- not every SSE event creates a new timeline item;
- not every timeline item requires a visible bubble/notification;
- naming and payload rules for new event types must be documented in Pulse package.

### Normalized metadata requirement for new SSE events

Для новых SSE event types нужно по возможности передавать:

- `company_id`
- `timeline_id`
- `contact_id`
- `entity_type`
- `entity_id`
- `occurred_at`

Это не ломает legacy payloads, но задаёт target contract для новых consumers и новых event families.

Rule:

- если consumer способен точечно применить item patch, используется incremental update;
- иначе timeline refetch remains valid fallback.

### Ownership note

SSE machine остаётся shared runtime subsystem, но документируется в Pulse package because:

- Pulse consumes the widest set of client-significant events;
- thread queue and timeline are tightly coupled with realtime semantics;
- те же события часто обновляют и другие страницы, и notification bubbles.

---

## Internal publishing contract

Не HTTP, но обязательный application contract:

- `pulseEventWriter.write(...)`

Минимальные аргументы:

- `timeline_id`
- `event_key`
- `event_family`
- `source_type`
- `source_id`
- `occurred_at`
- `summary_text`
- `payload`

Используется из:

- leads service
- jobs service
- estimates service
- invoices service
- payment service
- portal service
- automation executor
- pulse workflow actions

---

## Compatibility requirements

1. Current `pulseApi.getTimeline()` and `getTimelineById()` must keep working on migration path.
2. Existing `calls[] + messages[]` response may stay temporarily, but target contract is `items[]`.
3. Current `Action Required` buttons and controls stay in `PulsePage`.
4. Calls/SMS must not be copied into a second primary storage table.
5. Current left queue and middle-card controls remain the canonical active workflow surfaces during and after rollout.
