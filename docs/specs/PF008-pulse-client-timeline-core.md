# Спецификация: PF008 — Pulse Client Timeline Core

**Дата:** 2026-03-24
**Статус:** Proposed
**Приоритет:** Foundation / P0-cross-cutting
**Основа:** `F001 Pulse`, `docs/current_functionality.md`, `PF000`, `PF001..PF006`, `PF007`
**Связанные артефакты:** `PF008-technical-design.md`, `PF104-pulse-sprint-plan.md`, `PF105-pulse-db-api-contracts.md`

---

## Цель

Зафиксировать `Pulse` как ядро коммуникации, клиентского event history и связанных realtime semantics в Blanc.

Ключевая продуктовая идея:

- у каждого клиента есть один `timeline`;
- всё значимое, что происходит по клиенту, должно быть доступно оператору в этом timeline;
- `Pulse` остаётся главным operator workspace, а не только экраном `calls + sms`.

---

## Почему нужен отдельный пакет

Сейчас `Pulse` уже является самым сильным экраном продукта, но его фактическая модель всё ещё узкая:

1. правый timeline рендерит только `calls + sms`;
2. `Action Required`, `tasks`, `owner`, `snooze` живут рядом, но не как полноправные timeline items;
3. будущие `estimates / invoices / payments / portal / automations` уже требуют отображения в Pulse;
4. без отдельного пакета каждая новая фича будет по-своему встраиваться в `Pulse` и быстро создаст дублирующиеся event surfaces;
5. SSE-машина уже стала shared delivery layer для client events, но пока не описана как часть Pulse foundation.

PF008 нужен, чтобы `Pulse` был не просто communication page, а canonical client timeline platform.

---

## Current system reuse

### Уже существующие контуры, которые нужно расширять

- `frontend/src/pages/PulsePage.tsx`
- `frontend/src/components/pulse/PulseTimeline.tsx`
- `frontend/src/hooks/usePulsePage.ts`
- `frontend/src/hooks/usePulseTimeline.ts`
- `frontend/src/hooks/useRealtimeEvents.ts`
- `frontend/src/services/pulseApi.ts`
- `backend/src/routes/pulse.js`
- `backend/src/routes/events.js`
- `backend/src/db/timelinesQueries.js`
- `backend/src/db/conversationsQueries.js`
- `backend/src/services/conversationsService.js`
- `backend/src/services/inboxWorker.js`
- `backend/src/services/realtimeService.js`
- `src/server.js`
- `timelines`
- `calls`, `recordings`, `transcripts`
- `sms_conversations`, `sms_messages`, `sms_media`
- `tasks`

### Что уже хорошо работает и не должно быть потеряно

- three-column Pulse layout;
- timeline-first routing через `/pulse/timeline/:id`;
- automatic timeline adoption for orphan phones -> contact;
- call/audio/transcript/AI summary flow;
- SMS form with `Quick Messages` and AI polish;
- `Action Required`, `Snooze`, `Assign owner`, `thread tasks`;
- SSE-driven refresh for incoming comms.

---

## Canonical definition

`Pulse` — это canonical client timeline и основной operator workspace для коммуникации и событий.

Это означает:

- `Pulse` не равен только `call log + sms`;
- `Pulse` не равен только `inbox`;
- `Pulse` не должен быть заменён отдельными event-feeds в finance, portal, automations или jobs;
- именно в `Pulse` оператор должен видеть полную клиентскую историю в хронологическом порядке.

---

## Продуктовые принципы

### 1. Один timeline на клиента

- один `timeline` на `contact`;
- если контакт ещё не создан, допускается orphan timeline на phone number;
- после связывания с contact timeline должен быть принят текущим contact record, а не дублироваться.

### 2. Timeline является source of truth для операторского просмотра истории

- canonical business records остаются в своих доменах (`calls`, `sms_messages`, `tasks`, `jobs`, `estimates`, `invoices`, `payments`);
- но операторская история по клиенту читается через `Pulse`.

### 3. Коммуникации и high-value события живут в одной хронологии

В одном client timeline должны сосуществовать:

- calls;
- sms/mms;
- workflow items;
- finance items;
- portal actions;
- automation outputs;
- high-value CRM/job events.

### 4. Не создавать параллельные activity centers

- `Jobs`, `Leads`, `Payments`, `Portal`, `Estimates`, `Invoices`, `Automations` могут иметь свои detail views;
- но не должны становиться primary history surfaces для client activity.

### 5. `Action Required / Snooze / Tasks` — dual-surface workflow model

- `Action Required`, `Snooze`, `Assign owner`, `open task` являются прежде всего active workflow controls и action-needed signals;
- их primary UX остаётся в левой queue-навигации и в middle-card controls при просмотре timeline;
- их lifecycle дополнительно отражается в timeline как история работы по клиенту;
- timeline history не заменяет controls и не становится основным способом работы с action-needed state.

### 6. Domain events и Pulse timeline связаны, но не одно и то же

- `domain_events` нужны для automation/rule engine;
- `Pulse timeline items` нужны для operator UI;
- один и тот же бизнес-факт может публиковаться в `domain_events` и отображаться в `Pulse`, но это разные обязанности.

### 7. Messages page не отменяет Pulse

- `Messages` может оставаться inbox/worklist surface;
- canonical client history всё равно принадлежит `Pulse`.

### 8. Pulse package должен обновляться вместе с продуктом

- любой новый модуль, который создаёт client-significant event, обязан определить:
  - как событие попадёт в Pulse timeline;
  - как обновится Pulse queue/state;
  - нужен ли SSE/bubble/update signal;
- `PF008` должен считаться evergreen foundation document и обновляться вместе с улучшениями продукта.

### 9. Shared SSE delivery layer документируется вместе с Pulse

- SSE-машина остаётся shared runtime subsystem, а не отдельным продуктовым модулем;
- не каждое realtime событие приводит к новому item в timeline;
- часть событий обновляет bubble/badge, `Lead`, `Job`, `Payment` или другой экран без нового Pulse item;
- но taxonomy, delivery semantics и правила интеграции всё равно должны жить в Pulse package, потому что именно Pulse является главным местом пересечения client history, queue-state и realtime updates.

---

## Пользовательские сценарии

1. Оператор открывает клиента и видит в одном timeline все звонки, SMS, tasks, finance-события, portal actions и ключевые job события.
2. После inbound SMS система поднимает `Action Required`, создаёт task по правилу и показывает оба сигнала в Pulse.
3. После `estimate.approved` оператор видит это как timeline item рядом с предыдущими сообщениями и звонками, а не в отдельном finance log.
4. После `invoice.paid` или `payment.failed` оператор видит финансовое событие в том же клиентском timeline.
5. Диспетчер открывает job, estimate, invoice или payment и из любого из этих экранов может перейти в Pulse timeline клиента.
6. После portal action или automation escalation оператор получает realtime update и новый item появляется в Pulse без ручного refresh.
7. При просмотре клиента оператор одновременно видит active `Action Required / Snooze / Task` controls в middle-card и их историю в правом timeline.

---

## Функциональные требования

## 1. Timeline identity model

1. `Timeline` остаётся client/thread контейнером, привязанным к contact или orphan phone.
2. В системе не должно появляться несколько параллельных клиентских timeline для одного contact.
3. Если контакт был создан после появления orphan timeline, история должна быть принята в тот же client timeline.
4. Все новые client-facing домены должны уметь разрешать `timeline_id` для клиента.

## 2. Timeline item families

Pulse должен поддерживать как минимум следующие семейства timeline items.

### Communication

- inbound/outbound/internal call
- voicemail
- sms
- mms/media

Примечание:

- transcript, recording и AI summary остаются enrichment существующего call item, а не отдельным параллельным item family по умолчанию.

### Workflow / operator actions

- action required set
- action required handled
- snoozed
- unsnoozed
- owner assigned/reassigned
- task created
- task completed
- task overdue/escalated

### CRM / customer events

- contact created/linked
- lead created
- lead converted to job
- lead lost/reactivated
- job created
- job scheduled/rescheduled
- provider assigned/reassigned
- job status changed

### Finance / client-doc events

- estimate sent/viewed/approved/declined/deposit paid
- invoice sent/due/overdue/paid/partially paid
- payment received/failed/refunded

### Portal / automation

- portal opened
- contact updated by client
- automation-created reminder/task/escalation

## 3. Rendering rules

1. Правый столбец `Pulse` остаётся основным местом рендера timeline items.
2. Все item families должны отображаться в одной хронологии с date separators.
3. Основной порядок сортировки — по `occurred_at` от старых к новым, как сейчас.
4. Каждый item должен иметь:
   - время события;
   - краткий human-readable summary;
   - source label;
   - link на связанный record при наличии;
   - actor/system origin, если это важно для оператора.
5. Finance, portal, automation и workflow события не должны рендериться в отдельных secondary feeds как primary UX.
6. Если событие критично для работы оператора, оно должно быть visible в текущем timeline рядом с SMS/call items.

## 4. Left sidebar / thread queue

1. Левый список `Pulse` должен продолжать показывать open worklist по клиентским timeline.
2. Summary карточки timeline должен учитывать не только latest call/SMS, но и latest significant client event.
3. `Action Required`, `Snoozed`, `open task due`, `unread` остаются важнейшими queue signals.
4. Signal model queue не должна дублироваться отдельным inbox-only списком для тех же client threads.
5. При открытом timeline активные workflow controls продолжают дублироваться в middle-card/navigation area, а не переносятся в хронологию как единственная точка взаимодействия.

## 5. Action Required and tasks

1. `Action Required`, `Snooze`, `Assign owner`, `open task` остаются текущими operator controls и queue signals вне timeline:
   - в левой навигации/queue;
   - в middle-card header/navigation area при просмотре клиента.
2. Эти controls не должны переноситься внутрь timeline как основной UX-способ работы.
3. При этом lifecycle этих действий должен иметь timeline history:
   - action required set/handled;
   - snoozed/unsnoozed;
   - owner assigned/reassigned;
   - task created/completed/escalated.
4. Open task остаётся текущим active work signal в queue и middle-card, а task history дополнительно доступна внутри Pulse chronology.

## 6. Cross-module publishing into Pulse

1. `Leads`, `Jobs`, `Contacts`, `Payments`, `Estimates`, `Invoices`, `Client Portal`, `Automation Engine` должны публиковать Pulse-visible items для high-value client events.
2. Из `Lead`, `Job`, `Contact`, `Estimate`, `Invoice`, `Payment`, `Schedule` должны быть deeplink-переходы в Pulse timeline.
3. Новые high-value client actions не должны запускаться без ответа на вопрос: "Как это появится в Pulse?"
4. Любой новый продуктовый spec, который добавляет client-significant event или новый frontend realtime update, обязан иметь раздел `Pulse / Realtime integration`.

## 7. Realtime behavior

1. Новые timeline items должны появляться через existing realtime layer.
2. `calls`, `sms`, `action required`, `task`, `portal`, `finance`, `automation` события должны поддерживать live update стратегии.
3. Если patch update неоднозначен, допускается targeted refetch timeline, но не global page reload.
4. SSE/event-delivery machine должна документироваться в Pulse package, даже если конкретное обновление:
   - не рендерится прямо в Pulse;
   - показывает bubble/notification;
   - обновляет `Lead`, `Job`, `Payment` или другой экран.
5. Причина: именно Pulse является самым плотным местом пересечения client events, queue-state и realtime delivery semantics.
6. Не каждое SSE событие обязано создавать новый timeline item; допускаются отдельные delivery classes:
   - timeline mutation;
   - queue/state refresh;
   - cross-page entity refresh;
   - notification/bubble update.
7. Для каждого нового SSE event type должен быть понятен его эффект как минимум по трём вопросам:
   - меняет ли он Pulse timeline;
   - меняет ли он Pulse queue/current state;
   - нужен ли он другим экранам или notification surfaces.

## 8. Permissions and visibility

1. Pulse должен соблюдать PF007 authorization model.
2. Если роль пользователя не имеет доступа к finance data, finance timeline items должны скрываться или редактированно маскироваться.
3. Если действует `assigned jobs only`, job-related timeline items должны подчиняться тому же visibility scope.
4. Доступ к client messages, portal actions и payments через timeline не должен обходить backend authorization.

## 9. Compatibility constraints

1. Текущий route `/pulse/timeline/:id` и текущий three-column layout сохраняются.
2. Текущий `PulseTimeline` не должен быть заменён second-screen решением.
3. Текущие `calls` и `sms_messages` не должны дублироваться новой primary таблицей.
4. Existing `Action Required` и `tasks` не должны превращаться в отдельную вне-Pulse workflow систему.

---

## Out of scope

- полный omnichannel email inbox
- отдельный mobile-native redesign
- social channels
- customer-facing portal inside Pulse UI
- full-text search по телу всех timeline items как часть initial PF008 scope

---

## Acceptance criteria

1. `Pulse` формально определён как canonical client timeline, а не только как calls/SMS page.
2. Все high-value client события имеют целевой путь попадания в Pulse.
3. `Action Required`, `snooze`, `owner assignment`, `tasks` входят в Pulse timeline model как history layer, но их active controls остаются в queue и middle-card.
4. Для finance/portal/automation событий запрещено проектировать отдельную primary event-feed поверхность.
5. Calls и SMS сохраняют свои текущие canonical storage paths.
6. Новые бизнес-события проектируются как Pulse-visible timeline items.
7. `Messages` и другие модули не подменяют собой клиентскую историю.
8. PF001..PF006 могут публиковать события в Pulse без появления second timeline system.
9. PF008 также определяет ownership для shared SSE/event-delivery semantics по client-significant событиям.
10. Любая новая клиентская фича обязана обновлять Pulse package, если она добавляет timeline items, queue-state signals или frontend realtime events.
