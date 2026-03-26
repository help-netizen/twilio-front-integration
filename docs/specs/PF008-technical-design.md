# Technical Design: PF008 — Pulse Client Timeline Core

**Дата:** 2026-03-24
**Статус:** Proposed
**Связанный functional spec:** `PF008-pulse-client-timeline-core.md`

---

## 1. Design intent

PF008 должен превратить `Pulse` из screen, который сегодня агрегирует `calls + sms`, в canonical client timeline platform.

Ключевая техническая цель:

- оставить текущий working `Pulse` UX;
- расширить timeline model на workflow/business events;
- сохранить `Action Required / Snooze / Assign / Tasks` как отдельные control surfaces в middle-card и queue, но добавить им history layer в timeline;
- не заводить второй communication system и не дублировать `calls/sms` storage;
- держать realtime/SSE machine в одном документированном контуре с Pulse, потому что они постоянно пересекаются.

---

## 2. Current system reuse

### Existing frontend surfaces to reuse

- `frontend/src/pages/PulsePage.tsx`
- `frontend/src/components/pulse/PulseTimeline.tsx`
- `frontend/src/components/pulse/PulseCallListItem.tsx`
- `frontend/src/components/pulse/SmsListItem.tsx`
- `frontend/src/components/pulse/SmsForm.tsx`
- `frontend/src/hooks/usePulsePage.ts`
- `frontend/src/hooks/usePulseTimeline.ts`
- `frontend/src/hooks/useRealtimeEvents.ts`
- `frontend/src/hooks/realtimeEventTypes.ts`
- `frontend/src/services/pulseApi.ts`

### Existing backend surfaces to reuse

- `backend/src/routes/pulse.js`
- `backend/src/routes/events.js`
- `backend/src/db/timelinesQueries.js`
- `backend/src/db/conversationsQueries.js`
- `backend/src/services/conversationsService.js`
- `backend/src/services/inboxWorker.js`
- `backend/src/services/realtimeService.js`
- `src/server.js`

### Current gaps

- `PulseTimeline` умеет рендерить только `call | sms`;
- `Action Required`, `snooze`, `assign`, `tasks` не имеют полноценной timeline history;
- future `estimate/invoice/payment/portal/automation` events пока не имеют canonical Pulse write path;
- `pulse.js` route layer вручную собирает aggregated response и не имеет extensible timeline item pipeline;
- SSE behavior формально живёт вне отдельного Pulse package, хотя фактически сильно с ним связан;
- shared SSE taxonomy не разделяет явно: timeline mutation, queue-state update, cross-page entity refresh и notification/bubble signal.

---

## 3. Target architecture

### Backend

Новые и расширяемые слои:

- `backend/src/routes/pulse.js`
  - retains HTTP boundary
  - moves toward canonical timeline API
- `backend/src/routes/events.js`
  - retains SSE boundary
  - stays shared runtime entrypoint, but follows Pulse-owned event semantics
- `backend/src/services/pulse/pulseTimelineService.js`
  - builds unified timeline read model
- `backend/src/services/pulse/pulseEventWriterService.js`
  - writes non-call/non-sms Pulse-visible items
- `backend/src/services/pulse/pulseSummaryProjectionService.js`
  - updates thread list summary fields
- `backend/src/db/pulseQueries.js`
  - `timeline_events`
  - thread summary queries
- `backend/src/db/timelinesQueries.js`
  - remains home for timeline identity + current state
- `backend/src/services/realtimeService.js`
  - remains shared frontend-delivery subsystem for Pulse, queue and cross-page refreshes

### Frontend

- `frontend/src/components/pulse/PulseTimeline.tsx`
  - generalized item renderer
- `frontend/src/components/pulse/PulseEventListItem.tsx`
- `frontend/src/components/pulse/PulseTaskListItem.tsx`
- `frontend/src/components/pulse/pulseTimelineRenderers.ts`
- `frontend/src/hooks/usePulseTimeline.ts`
  - consumes canonical `items[]`
- `frontend/src/hooks/useRealtimeEvents.ts`
  - remains canonical frontend realtime hook and is documented here as Pulse-adjacent delivery layer
- `frontend/src/types/pulse.ts`
  - expanded timeline item model

Rule:

- existing route `/pulse/timeline/:id` stays;
- renderer becomes generic, not hardcoded around only two item types;
- middle-card controls for `Action Required / Snooze / Assign / Tasks` stay outside the timeline and continue to exist as dedicated UI controls;
- timeline mirrors workflow history, but does not replace action surfaces.

---

## 4. Read model strategy

### Timeline identity

`timelines` remains the single client/thread identity table.

### Unified timeline read model

Pulse timeline is assembled from:

- `calls`
- `sms_messages`
- `timeline_events`
- current thread/task state from `timelines` and `tasks`

### Important design choice

Do not create a second primary storage table for all calls/SMS items.

Instead:

- communication items read directly from canonical communication tables;
- non-communication items read from `timeline_events`;
- API returns one unified `items[]` contract.

---

## 5. Write / publishing model

### Communication writes

- calls continue to write into `calls`
- sms continue to write into `sms_messages`
- inbox/conversation services continue to manage communication persistence

### Non-communication Pulse items

These are written through one helper:

- `pulseEventWriterService.write(...)`

Used by:

- pulse workflow actions
- jobs/leads/contact services
- estimates/invoices/payment services
- portal service
- automation executor

### Why this split

- avoids duplicating communication storage;
- gives one extensible writer path for everything else;
- keeps Pulse additions cheap for future domains.

---

## 6. Relationship to `domain_events`

PF006 introduces `domain_events`.

PF008 does not replace them.

Target relation:

1. source service persists canonical domain record
2. source service publishes `domain_event`
3. if event is operator-significant for client history, it also becomes a Pulse-visible item

Implementation options allowed:

- direct dual-write inside service with shared helper
- projector from `domain_events` into `timeline_events`

Preferred rule:

- operator-facing Pulse logic should stay explicit and predictable;
- automation-only events should not automatically flood Pulse.

---

## 7. Frontend evolution

### Current state

`PulseTimeline` constructs:

- `call` items
- `sms` items

### Target state

`PulseTimeline` should render:

- `call`
- `sms`
- `event`
- `task/workflow`

through a renderer map, not nested hardcoded `if type ===`.

Important:

- timeline history expands;
- control surfaces do not move into timeline as the only way to act.

### UX constraints

- current chronology view stays;
- date separators stay;
- current call and sms item design stays;
- new event/task items adopt Pulse visual language and do not feel like a foreign widget embedded in the page.

### Control/state rule

- active workflow state reads from `timelines` and `tasks`, not from scanning timeline history;
- left queue and middle-card controls remain the primary control surfaces;
- timeline items for workflow actions are audit/history artifacts plus operator context, not the only interaction model.

---

## 8. Thread list / left sidebar strategy

Current left queue is driven mostly by latest call/SMS plus current timeline flags.

Target state:

- thread summary is timeline-aware across all significant item families;
- denormalized summary fields may be stored on `timelines` for efficiency;
- `Action Required`, `Snoozed`, `open task due`, `unread` remain first-class queue signals.

This avoids recomputing left sidebar from wide unions on every refresh.

---

## 9. Realtime strategy

### Existing behavior retained

- `call.created`
- `call.updated`
- `message.added`
- `message.delivery`
- `conversation.updated`
- `job.updated`
- `contact.read`
- `contact.unread`
- `transcript.delta`
- `transcript.finalized`
- `timeline.read`
- `timeline.unread`
- `thread.action_required`
- `thread.handled`
- `thread.snoozed`
- `thread.unsnoozed`
- `thread.assigned`

### New behavior

Pulse package adds:

- `timeline.item_added`
- `timeline.item_updated`
- `timeline.state_updated`

### Delivery classes

Pulse-owned SSE semantics should distinguish four delivery classes:

- timeline mutation
- thread/worklist state refresh
- cross-page entity refresh
- notification/badge/bubble update

Rule:

- not every SSE event maps to a new `timeline_events` row;
- not every `timeline_events` row requires a dedicated notification surface;
- classification lives in Pulse package so product modules do not invent divergent realtime behaviors.

Frontend rule:

- if item can be appended/patched safely, do incremental update;
- if ordering or grouping is ambiguous, invalidate `usePulseTimeline` query and refetch.

### Why SSE is documented inside Pulse package

Even when an SSE event updates:

- toast/bubble notifications;
- `Leads`, `Jobs`, `Payments`;
- badges or queue counters;

it still belongs in Pulse documentation because Pulse is the densest integration point between:

- client history
- queue/workflow state
- realtime event delivery
- operator awareness

Therefore:

- Pulse package owns the documentation contract for shared SSE semantics;
- F006 remains the runtime capability, but Pulse defines how client-significant events should be delivered and consumed.

---

## 10. Data model strategy

### Reuse

- `timelines`
- `calls`
- `recordings`
- `transcripts`
- `sms_conversations`
- `sms_messages`
- `tasks`

### Add

- `timeline_events`

### Extend if needed

- summary fields on `timelines`

### Avoid

- `timeline_items` as second primary storage for calls/sms
- separate finance activity tables used only for UI feed rendering
- a second event feed in frontend outside Pulse for the same client history

---

## 11. Integration with current and future modules

### Current Pulse workflows

- `mark handled`
- `snooze`
- `assign owner`
- `create task`

must produce Pulse-visible lifecycle history, while keeping their current dedicated controls outside timeline.

### Current domains

- `Contacts`
- `Leads`
- `Jobs`

need stable deeplinks to Pulse and high-value publishing points.

### Future P0 domains

- `Estimates`
- `Invoices`
- `Payment Collection`
- `Client Portal`
- `Automation Engine`

must treat Pulse publishing as required integration, not optional nice-to-have.

### Ongoing maintenance rule

Any future feature that emits client-significant events or new SSE updates must update:

- Pulse publishing behavior
- Pulse/SSE documentation contracts
- renderer assumptions, if new item family is introduced

---

## 12. Rollout phases

### Phase 1

- timeline item contract
- `timeline_events`
- canonical read model service

### Phase 2

- generalized frontend renderer
- workflow history items
- compatibility APIs

### Phase 3

- CRM/job publishing
- finance/portal publishing
- realtime item events

### Phase 4

- denormalized thread summary
- RBAC-aware item visibility
- performance tuning

---

## 13. Main risks

- duplicated event writes from many services
- ordering inconsistencies between `calls/sms` and `timeline_events`
- Pulse UI overload if every low-value mutation becomes an item
- permission leakage through timeline payloads
- left sidebar performance degradation on large tenants

### Mitigation

- one `pulseEventWriterService`
- explicit whitelist of Pulse-worthy event keys
- stable `occurred_at` and `source_type/source_id` contracts
- permission filtering in backend timeline builder
- optional summary projection on `timelines`

---

## 14. Protected areas

- `src/server.js` runtime wiring
- `frontend/src/services/apiClient.ts`
- `frontend/src/hooks/useRealtimeEvents.ts`
- existing `calls` / `sms_messages` canonical storage paths
- current Pulse route structure unless explicitly changed by separate routing task
