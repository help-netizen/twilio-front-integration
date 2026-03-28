# Technical Design: PF006 — Automation Engine

**Дата:** 2026-03-24
**Статус:** Proposed
**Связанный functional spec:** `PF006-automation-engine.md`

---

## 1. Design intent

Automation engine is a deferred cross-cutting package for the later rollout wave, not part of the current P0 delivery slice.

It should not be implemented as scattered `if trigger then send SMS` logic in individual services. Instead:

- all important product events become `domain_events`;
- rules subscribe by condition;
- actions execute through a shared queue/executor;
- current `Action Required` behavior becomes one rule family, not a separate automation system.

---

## 2. Target architecture

### Backend services

New files/folders:

- `backend/src/routes/automations.js`
- `backend/src/services/automation/domainEventService.js`
- `backend/src/services/automation/ruleService.js`
- `backend/src/services/automation/ruleMatcherService.js`
- `backend/src/services/automation/actionExecutorService.js`
- `backend/src/services/automation/automationWorker.js`
- `backend/src/db/automationQueries.js`

### Frontend

New files:

- `frontend/src/pages/AutomationsPage.tsx`
- `frontend/src/components/automations/*`
- `frontend/src/services/automationsApi.ts`

Extensions:

- `ActionRequiredSettingsPage` becomes a rule-engine-backed configuration surface

---

## 3. Event-first design

### Domain event publisher

All P0 domains should publish through one helper:

- `domainEventService.publish(...)`

Publisher is called by:

- estimates service
- invoices service
- payment collection service
- portal service
- schedule/task update services
- current inbound comms services

### Why this matters

Without this, automation debt will continue to accumulate, but current `Action Required` and thread-task flows are acceptable as a temporary baseline until the dedicated automation wave starts.

---

## 4. Rule evaluation model

### Rule structure

Each rule has:

- trigger family
- time mode
- conditions
- actions
- dedupe/cooldown settings

### Matching flow

1. domain event stored
2. candidate active rules selected by family
3. conditions evaluated
4. queue rows created for matching rules
5. worker executes queued actions
6. execution logged

---

## 5. Action execution model

### Supported executors in P0

- SMS sender
- email sender
- task creator
- action-required setter
- owner assignment updater
- webhook sender
- simple status updater

Each action type should have its own executor function under `actionExecutorService`.

---

## 6. Queue and worker model

Automation delayed execution must not live in request/response path.

Design:

- immediate actions may enqueue and execute quickly;
- delayed or retryable actions run in dedicated automation worker;
- aligns with `RF009` plan to separate worker lifecycle from web runtime.

Key queue fields:

- scheduled_for
- status
- attempt_count
- lock info
- last_error

---

## 7. Migration of current Action Required logic

### Current state

- inbound SMS, missed call, voicemail have dedicated config and service branches

### Target state

These become predefined rule templates:

- `message.inbound -> set_action_required + create_task`
- `call.missed -> set_action_required + create_task`
- `voicemail.received -> set_action_required + create_task`

UI may still surface them specially, but backend execution must go through one engine.

---

## 8. Template strategy

Templates are stored as normal rule presets, not hardcoded code paths.

P0 templates:

- appointment reminder
- estimate follow-up
- invoice overdue reminder
- missed call follow-up
- payment receipt notification

This keeps the engine extensible without visual flow-builder complexity.

---

## 9. API design

- `GET /api/automations`
- `POST /api/automations`
- `GET /api/automations/:id`
- `PATCH /api/automations/:id`
- `POST /api/automations/:id/pause`
- `POST /api/automations/:id/resume`
- `GET /api/automations/:id/executions`
- `GET /api/automations/templates`

---

## 10. Data model

Core tables:

- `domain_events`
- `automation_rules`
- `automation_rule_conditions`
- `automation_rule_actions`
- `automation_dispatch_queue`
- `automation_executions`

Rule:

- executions are append-only audit records;
- queue state is operational mutable state.

---

## 11. Rollout plan

### Phase 1

- domain events
- rule storage
- queue model

### Phase 2

- executor set for SMS/email/task/action-required
- migration of existing AR triggers

### Phase 3

- UI page
- templates
- execution log

---

## 12. Main risks

- ad-hoc event publishing from multiple services
- retries producing duplicate outbound actions
- keeping old AR logic alive in parallel too long

### Mitigation

- canonical publisher helper
- dedupe keys and idempotent queue execution
- explicit migration plan from special-case settings to rule-backed templates
