# Спецификация: F013 Schedule Finalization Sprint

## Статус

`Proposed`

## Цель

Собрать все оставшиеся незакрытые пункты `F013 Schedule` в один финальный sprint scope.

После завершения этого спринта:

- `F013` считается закрытым как единый пакет;
- дальнейшие улучшения schedule считаются уже отдельными product enhancements, а не хвостами `F013`;
- `Sprint 4` collision-lane пакет не переоткрывается и считается завершённым.

## Источники scope

- `docs/specs/F013-schedule-sprint3-ux-hardening.md`
- `docs/specs/F013-schedule-sprint5-ux-polish.md`
- `docs/specs/F013-schedule-sprint7-spec.md`
- `docs/specs/F013-schedule-sprint7-design-refresh.md`
- фактический код `frontend/src/pages/SchedulePage.tsx`
- фактический код schedule views / hooks / backend routes по состоянию на `2026-04-17`

## Принцип этого спринта

Этот sprint не добавляет новый продуктовый scope сверх старого `F013`.

Он закрывает только то, что уже было обещано внутри `F013`, но осталось:

- недореализованным;
- сломанным на уровне контракта frontend/backend;
- частично доведённым по UX;
- расходящимся между docs и реальным поведением.

## Что уже считается закрытым и НЕ входит в этот sprint

- базовый route `/schedule`
- `day / week / month / timeline / timeline-week / list`
- timezone-aware rendering foundation
- past overlay / now-line baseline
- DnD reschedule baseline
- collision lanes + overflow popover (`Sprint 4`)
- visual redesign foundation `Sprint 7`

## Scope спринта

### 1. Create-from-slot closure

Текущий create-from-slot flow должен быть доведён до консистентного состояния.

Сейчас в продукте есть drift:

- UI показывает только `Create Job`;
- frontend отправляет `entity_type: 'job'`;
- backend реально поддерживает только `task`.

В рамках этого sprint scope нужно закрыть контур полностью:

- `SlotContextMenu` больше не может обещать действие, которое backend не выполняет;
- все доступные действия должны быть end-to-end рабочими;
- provider/day/time context должен передаваться одинаково во всех schedule views.

### 2. Reassign / Unassign parity

Нужно довести до конца reassignment semantics:

- `job` и `task` должны поддерживать reassignment на provider;
- `job` и `task` должны поддерживать unassign через drop в `Unassigned`;
- backend должен принимать `assignee_id = null` там, где это допустимо;
- optimistic UI и success/error handling должны соответствовать реальному API contract;
- `lead` остаётся non-draggable и не участвует в reassignment flow.

### 3. Filters and settings parity

Оставшиеся F013 gaps по filters/settings нужно закрыть в одном куске:

- добавить `job type` filter;
- довести settings form до заявленного набора dispatch-настроек;
- включить `buffer_minutes` в UI/API contract;
- сохранить текущую persistence model и tenant isolation;
- не создавать второй отдельный settings surface.

### 4. Realtime refresh closure

Текущий debounced full refresh остаётся базой, но нужно закрыть promised F013 behavior:

- использовать targeted item refresh / patch, когда SSE event даёт достаточно данных;
- full refetch оставлять fallback path;
- не дёргать полный reload без необходимости;
- сохранить debounce semantics для batch событий.

### 5. Compact card readability closure

Оставшийся UX polish из `Sprint 5` нужно закрыть как один блок:

- compact cards должны оставаться идентифицируемыми без клика;
- customer context должен быть видим на compact cards;
- status не должен дублироваться;
- минимум шрифта не ниже порога читаемости;
- compact layout не должен ломаться в narrow lanes.

### 6. Toolbar summary closure

Нужно закрыть оставшийся небольшой, но полезный dispatch UX:

- count badge рядом с date label должен иметь breakdown semantics;
- breakdown по `jobs / leads / tasks` должен быть доступен оператору;
- loading state для count badge должен быть консистентен.

### 7. Sprint 7 behavior alignment

Нужно закрыть расхождение между Sprint 7 docs и реальным UI как один deliverable:

- зафиксировать canonical sidebar behavior;
- зафиксировать canonical responsive behavior;
- убрать неоднозначность, где layout contract задаётся grid, а где fixed sidebar stack;
- после этого старые Sprint 7 docs считать source history, а не competing truth.

## Task Breakdown

### F013-FIN-001: End-to-end create-from-slot alignment

**Owner:** Schedule frontend + backend

**Задачи:**

- переработать `SlotContextMenu` под реальный supported action set;
- выровнять frontend payload и backend accepted entity types;
- обеспечить передачу `providerId`, `startAt`, `endAt` во всех relevant views;
- для `lead/job` использовать существующий assisted-create flow, если direct backend create не вводится в этом sprint.

**Acceptance criteria:**

- ни один create action в меню не ведёт к `501 / not implemented`;
- выбранный slot корректно переносится в create flow;
- timeline views сохраняют provider context;
- day/week views сохраняют выбранное время.

### F013-FIN-002: Reassign and unassign completion

**Owner:** Schedule frontend + backend

**Задачи:**

- исправить API contract для `assignee_id = null`;
- довести optimistic update до parity с backend;
- оставить `lead` вне reassignment flow;
- проверить `TimelineView`, `TimelineWeekView`, `ListView`.

**Acceptance criteria:**

- `job/task -> Unassigned` работает через DnD;
- reassignment на provider работает одинаково во всех relevant views;
- invalid entity types не приводят к silent drift в UI.

### F013-FIN-003: Filters and settings completion

**Owner:** Schedule frontend + backend

**Задачи:**

- добавить `job type` filter;
- включить `buffer_minutes` в settings dialog и API;
- сохранить local persistence filters;
- сохранить company isolation.

**Acceptance criteria:**

- `job type` filter влияет на dataset;
- `buffer_minutes` сохраняется и читается из dispatch settings;
- reset filters очищает и новый filter state.

### F013-FIN-004: Realtime smart refresh

**Owner:** Schedule frontend

**Задачи:**

- реализовать item-level patch/update path для job/lead/task events;
- full reload оставить fallback;
- сохранить debounce для noisy event bursts.

**Acceptance criteria:**

- одиночное update событие не требует обязательного полного refetch;
- burst событий не спамит schedule API;
- stale item state не зависает до ручного refresh.

### F013-FIN-005: Compact card readability

**Owner:** Schedule frontend

**Задачи:**

- довести compact layout;
- показать customer context;
- убрать оставшиеся readability regressions;
- не ухудшить collision-lane behavior.

**Acceptance criteria:**

- compact card можно идентифицировать без открытия sidebar;
- customer context виден в compact mode;
- status не дублируется;
- narrow-lane scenario остаётся читаемым.

### F013-FIN-006: Toolbar summary polish

**Owner:** Schedule frontend

**Задачи:**

- добавить breakdown semantics к item count badge;
- показать `jobs / leads / tasks` without clutter;
- выровнять loading behavior.

**Acceptance criteria:**

- оператор видит total count;
- оператор может быстро понять composition текущего периода;
- loading state не прыгает и не ломает toolbar layout.

### F013-FIN-007: Canonicalize Sprint 7 behavior

**Owner:** Product/UX + frontend

**Задачи:**

- определить canonical sidebar behavior как final truth;
- определить canonical responsive rules как final truth;
- обновить docs после принятия этого поведения.

**Acceptance criteria:**

- не остаётся двух конфликтующих layout-spec правд;
- QA и разработка используют один canonical document.

## Рекомендуемый порядок внутри спринта

1. `F013-FIN-001` create-from-slot alignment
2. `F013-FIN-002` reassign/unassign completion
3. `F013-FIN-003` filters and settings completion
4. `F013-FIN-004` realtime smart refresh
5. `F013-FIN-005` compact card readability
6. `F013-FIN-006` toolbar summary polish
7. `F013-FIN-007` canonical docs alignment

## Global acceptance for closing F013

`F013` можно считать закрытым только если одновременно выполнено следующее:

- create-from-slot больше не имеет broken contract между UI и backend;
- reassign/unassign работает end-to-end;
- settings and filters закрывают оставшиеся обещания F013;
- compact card UX не имеет явных dispatch-readability gaps;
- realtime behavior не опирается только на blind full reload;
- docs больше не размазывают F013 по нескольким competing sprint truths.

## Out of scope after this sprint

Следующие задачи не считаются частью `F013`, даже если касаются schedule:

- provider availability engine
- route optimization
- ETA prediction
- advanced capacity planning
- map-first dispatch
- mobile-native dispatcher redesign
- любой новый AI scheduling backend beyond current stub UX

Это уже отдельные future enhancements.
