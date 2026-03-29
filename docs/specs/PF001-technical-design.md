# Technical Design: PF001 — Unified Schedule / Dispatcher

**Дата:** 2026-03-24
**Статус:** Proposed
**Связанный functional spec:** `PF001-unified-schedule-dispatcher.md`

---

## 1. Design intent

`Schedule` должен быть dedicated dispatch/planning workspace, но при этом не должен создавать новую business-entity модель и не должен заменять `Pulse` как canonical operator workspace по клиентской истории.

Ключевая техническая идея:

- aggregated read/write layer;
- reuse existing `jobs`, `leads`, `tasks`, `providers`;
- UI-операции всегда меняют underlying entity.
- client-significant dispatch events публикуются в `Pulse`/realtime layer по правилам `PF008`.

---

## 2. Current system reuse

### Existing frontend surfaces to reuse

- `frontend/src/pages/JobsPage.tsx`
- `frontend/src/pages/LeadsPage.tsx`
- `frontend/src/pages/ContactsPage.tsx`
- `frontend/src/components/pulse/*`
- `SoftPhoneContext`
- `ClickToCallButton` / `OpenTimelineButton` patterns

### Existing backend surfaces to reuse

- `backend/src/routes/jobs.js`
- `backend/src/routes/leads.js`
- existing tasks layer under `pulse.js` + `timelinesQueries.js`
- `backend/src/routes/zenbooker.js` / `zenbookerClient.js` for provider/timeslot data
- `backend/src/services/realtimeService.js`

---

## 3. Target architecture

### Frontend

Новые файлы:

- `frontend/src/pages/SchedulePage.tsx`
- `frontend/src/components/schedule/*`
- `frontend/src/hooks/useScheduleData.ts`
- `frontend/src/hooks/useScheduleActions.ts`
- `frontend/src/services/scheduleApi.ts`

### Backend

Новые файлы:

- `backend/src/routes/schedule.js`
- `backend/src/services/scheduleService.js`
- `backend/src/db/scheduleQueries.js`

Rule:

- route -> service -> query/reuse services;
- не тянуть SQL в page-layer и не дублировать job/lead business logic.

---

## 4. Read model

### Unified schedule item contract

Каждый item должен возвращаться как:

- `entity_type`
- `entity_id`
- `title`
- `subtitle`
- `status`
- `start_at`
- `end_at`
- `timezone`
- `assignee_type`
- `assignee_id`
- `assignee_label`
- `contact_summary`
- `address_summary`
- `source_summary`
- `display_color`
- `is_unassigned`
- `is_unscheduled`
- `is_action_required`

### Data sources

- `job` items: current jobs storage + provider assignment extraction
- `lead` items: current leads storage + optional scheduled date/time
- `task` items: current tasks table, extended if needed

### No schedule table

Schedule service не хранит `schedule_items` как самостоятельную таблицу.

Причина:

- это создало бы второй источник правды;
- пришлось бы синхронизировать все job/lead/task updates вручную.

---

## 5. Write model

### Supported mutations

- reschedule entity
- reassign entity
- create from slot
- update quick status

### Dispatch action routing

- `job` mutations идут в job update flow
- `lead` mutations идут в lead update flow
- `task` mutations идут в tasks flow

Schedule service only orchestrates and validates common inputs.

---

## 6. Data model changes

### Required

- extend `tasks` if current model lacks:
  - `start_at`
  - `end_at`
  - `assigned_provider_id`
  - `show_on_schedule`
- add `dispatch_settings`

### Avoid

- `schedule_items`
- `schedule_task_copies`
- duplicated provider assignment tables for jobs unless existing job model truly cannot persist schedule assignment

---

## 7. API design

### Read

- `GET /api/schedule/items`
- `GET /api/schedule/items/:entityType/:entityId`

### Write

- `PATCH /api/schedule/items/:entityType/:entityId/reschedule`
- `PATCH /api/schedule/items/:entityType/:entityId/reassign`
- `POST /api/schedule/items/from-slot`

### Settings

- `GET /api/schedule/settings`
- `PATCH /api/schedule/settings`

---

## 8. Realtime strategy

### Inputs to listen to

- job updated
- lead updated
- thread task created/updated/completed
- automation-created task

### Frontend strategy

- optimistic drag/drop for local feel
- server confirmation
- fallback refetch when granular patching is ambiguous

### Pulse integration rule

- schedule mutation не ограничивается локальным calendar refresh;
- если mutation меняет client-significant факт (`scheduled`, `rescheduled`, `provider reassigned`, `task scheduled`), backend обязан публиковать событие для `Pulse` timeline и shared SSE taxonomy;
- `Schedule` и `Pulse` читают один и тот же underlying business change, а не обмениваются UI-only state.

---

## 9. Rollout plan

### Phase 1

- read-only schedule
- filters
- sidebar
- deeplinks

### Phase 2

- reschedule/reassign
- create-from-slot
- realtime updates

### Phase 3

- polish of month/timeline-week UX

---

## 10. Main risks

- inconsistent job date/provider normalization from current Zenbooker payloads
- insufficient current task fields for schedule rendering
- duplicated assignment logic if schedule bypasses existing job/lead services

### Mitigation

- central `scheduleService` adapter layer
- explicit normalized schedule contract
- no direct page -> raw fetch -> patch patterns
