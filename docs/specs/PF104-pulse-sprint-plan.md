# Спецификация: PF104 — Pulse Sprint Plan

**Дата:** 2026-03-24
**Статус:** Proposed
**Основа:** `PF008`

---

## Цель

Разложить Pulse-пакет на фазы так, чтобы:

- не сломать текущий `Pulse` UX;
- превратить `Pulse` в canonical client timeline;
- подготовить foundation для `PF001..PF006`, где новые домены уже обязаны публиковаться в Pulse.

---

## Планирующие принципы

1. Сначала фиксируется canonical item model, потом расширяется UI.
2. Существующие `calls` и `sms` остаются working baseline и не переписываются big-bang способом.
3. Workflow events (`Action Required`, `tasks`, `assign`, `snooze`) идут раньше finance/portal events.
4. Finance/portal/automation publishing не должен начинаться до готовности Pulse item contracts.
5. Каждый новый продуктовый пакет после PF008 обязан явно указывать Pulse integration, влияние на current controls/queue и SSE/update behavior.

---

## Sprint 1 — Pulse Contracts and Timeline Item Model

### Цель

Зафиксировать Pulse как cross-cutting foundation для operator history.

### Scope

- canonical `timeline item` contract
- item families
- distinction: `domain_events` vs `pulse timeline items`
- distinction: active workflow controls/state vs timeline history
- compatibility strategy for current `/api/pulse/timeline*`
- publishing rules for future PF001..PF006
- ownership rules for shared SSE delivery semantics

### Exit criteria

- все домены понимают, как писать в Pulse;
- все домены понимают, когда нужен Pulse item, когда нужен только queue/state update, и когда нужен bubble/entity refresh;
- текущий `calls + sms` timeline получает target model расширения.

---

## Sprint 2 — Pulse Read Model and UI Generalization

### Цель

Перевести timeline UI с модели `calls + sms` на generalized item renderer.

### Scope

- canonical `items[]` response for Pulse timeline
- `PulseTimeline` renderer registry
- support for:
  - `call`
  - `sms`
  - generic `event`
  - `task/workflow`
- compatibility payloads for existing consumers
- middle-card controls и left queue не деградируют после generalization timeline renderer
- renderer generalization должна оставлять явный extension path для будущего `email` item family внутри `Pulse`

### Exit criteria

- timeline UI умеет показывать не только calls/SMS;
- current Pulse route и layout не ломаются.

---

## Sprint 3 — Workflow Events Native to Pulse

### Цель

Сделать `Action Required`, `tasks`, `assign owner`, `snooze` частью timeline history, а не только side state.

### Scope

- timeline items for:
  - action required set
  - handled
  - snoozed / unsnoozed
  - owner assigned
  - task created / completed / escalated
- current thread actions keep existing UX controls outside timeline
- current thread actions remain duplicated in middle-card/navigation area while viewing timeline
- realtime updates for workflow items

### Exit criteria

- работа оператора по thread отражается в timeline;
- active controls по thread по-прежнему живут вне timeline и не теряются;
- history по workflow больше не теряется.

---

## Sprint 4 — CRM and Schedule Publishing into Pulse

### Цель

Подключить high-value CRM events и dispatch events.

### Scope

- lead created / converted / lost / activated
- job created / scheduled / rescheduled / provider assigned / status changed
- contact linked / updated by internal user
- deeplinks from `Leads / Jobs / Contacts / Schedule` into Pulse

### Exit criteria

- оператор видит ключевые CRM/job changes в одном client timeline;
- `Schedule` и `Jobs` не требуют отдельного customer history feed.

---

## Sprint 5 — Finance, Portal and Automation Publishing

### Цель

Сделать Pulse operator surface для PF002..PF006.

### Scope

- `estimate.*`
- `invoice.*`
- `payment.*`
- `portal.*`
- automation-created reminder/task/escalation
- timeline item rendering for finance/client-doc actions

### Exit criteria

- finance и portal события появляются в Pulse рядом с calls/SMS;
- PF002..PF006 больше не проектируются как отдельные activity centers.

---

## Sprint 6 — Hardening, Permissions, Performance

### Цель

Довести Pulse до production-ready foundation.

### Scope

- PF007 permission enforcement in Pulse items
- left-sidebar summary model
- denormalized timeline summary fields if needed
- SSE event refinement
- governance rule and delivery taxonomy for bubbles/badges/cross-page refreshes
- timeline performance and pagination strategy
- regression checklist for current Pulse behaviors
- governance rule that new features update Pulse package/docs when they add client-significant events

### Exit criteria

- Pulse корректно работает с RBAC;
- long timelines и high event volume остаются usable;
- current operator flows не деградируют;
- новый клиентский функционал не может выйти без описанного Pulse/SSE integration contract.

---

## Зависимости на другие пакеты

- `PF007` нужен для permission-aware Pulse visibility
- `PF001..PF006` должны опираться на Pulse contracts из `PF008`
- `PF006` использует `domain_events`, но operator-visible outcomes должны дополнительно появляться в Pulse

---

## Рекомендуемая последовательность относительно P0 suite

1. `PF007` foundation
2. `PF008` Sprint 1-3
3. `PF100` Wave A/B/C с обязательной публикацией в Pulse
4. `PF008` Sprint 4-6 параллельно rollout `PF002..PF006`
