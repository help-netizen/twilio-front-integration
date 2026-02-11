---
title: "ТЗ: Единый разговор в CRM вместо множества call legs (Twilio)"
version: "1.0.0"
date: "2026-02-11"
owner: "Backend + Frontend + Data"
status: "ready-for-implementation"
priority: "high"

context:
  problem: >
    Один входящий звонок от клиента в Twilio создает parent call + несколько child legs
    (дозвон до операторов/устройств). В текущем UI это отображается как много отдельных звонков.
  goal: >
    Показывать в основном списке только один разговор (Interaction) на клиентский звонок,
    а все child legs показывать внутри карточки как попытки дозвона.
  in_scope:
    - Нормализация Twilio Calls в 2 сущности: Interactions и CallLegs
    - Вычисление бизнес-статусов interaction и leg
    - Новый контракт API для списка и карточки разговора
    - Миграция/бэкфилл исторических данных
  out_of_scope:
    - Изменение маршрутизации звонков в Twilio
    - Изменение логики очередей, IVR, распределения агентов
    - Изменение биллинга/тарификации

definitions:
  interaction_sid_rule: "interaction_sid = COALESCE(parent_call_sid, call_sid)"
  root_call: "Вызов, где parent_call_sid = null"
  child_leg: "Вызов, где parent_call_sid != null"
  winner_leg: >
    Child leg, который реально был соединен с клиентом (предпочтительно определяется через
    Dial action callback: DialBridged=true и DialCallSid=<sid>).

data_model:
  interactions:
    pk: interaction_sid
    fields:
      - interaction_sid: "string (CA...)"
      - root_call_sid: "string (CA...)"
      - parent_call_status: "enum Twilio status"
      - direction: "inbound|outbound-*"
      - from_number: "string E.164"
      - to_number: "string E.164"
      - started_at: "datetime"
      - ended_at: "datetime|null"
      - duration_sec: "integer|null"
      - winner_leg_sid: "string|null"
      - interaction_outcome: "answered|missed|abandoned|in_progress"
      - attempts_total: "integer"
      - attempts_answered: "integer"
      - attempts_missed: "integer"
      - attempts_failed: "integer"
      - attempts_busy: "integer"
      - attempts_canceled: "integer"
      - attempts_race_lost: "integer"
      - created_at: "datetime"
      - updated_at: "datetime"
    indexes:
      - "started_at desc"
      - "from_number, started_at desc"
      - "interaction_outcome, started_at desc"

  call_legs:
    pk: call_sid
    fields:
      - call_sid: "string (CA...)"
      - interaction_sid: "string (FK -> interactions)"
      - parent_call_sid: "string|null"
      - twilio_status: "queued|ringing|in-progress|completed|busy|failed|no-answer|canceled"
      - direction: "string"
      - to_target: "phone/client/sip endpoint"
      - operator_id: "string|null"
      - started_at: "datetime|null"
      - ended_at: "datetime|null"
      - duration_sec: "integer|null"
      - queue_time_sec: "integer|null"
      - was_answered_event: "boolean"
      - was_ringing_event: "boolean"
      - derived_attempt_status: >
          answered_by_agent|no_answer_or_rejected|busy|failed|canceled_race|
          race_lost_after_answer|unknown
      - is_winner: "boolean"
      - raw_payload: "jsonb"
      - created_at: "datetime"
      - updated_at: "datetime"
    indexes:
      - "interaction_sid, started_at asc"
      - "parent_call_sid"
      - "twilio_status"
      - "operator_id, started_at desc"

event_sources:
  pull_api:
    - name: "Twilio Calls list"
      usage:
        - "Получение root calls за период"
        - "Получение child legs по parentCallSid"
  webhooks:
    - name: "Dial action callback"
      important_fields:
        - DialCallSid
        - DialBridged
        - DialCallStatus
    - name: "Number/Sip status callbacks"
      events:
        - initiated
        - ringing
        - answered
        - completed
  idempotency:
    key_strategy:
      - "call_sid для snapshot upsert"
      - "call_sid + event_type + event_timestamp для event-журнала"
    rule: "Повторные вебхуки не должны дублировать attempts"

status_logic:
  winner_resolution_priority:
    - "Dial action callback: DialBridged=true + DialCallSid -> winner_leg_sid"
    - "Fallback: leg с answered-event=true и max(duration_sec)"
    - "Fallback: null (winner не определен)"
  leg_derived_status:
    - when: "call_sid == winner_leg_sid"
      set: "answered_by_agent"
    - when: "twilio_status == 'no-answer'"
      set: "no_answer_or_rejected"
    - when: "twilio_status == 'busy'"
      set: "busy"
    - when: "twilio_status == 'failed'"
      set: "failed"
    - when: "twilio_status == 'canceled'"
      set: "canceled_race"
    - when: "twilio_status == 'completed' AND call_sid != winner_leg_sid AND (duration_sec IS NULL OR duration_sec = 0)"
      set: "race_lost_after_answer"
    - when: "twilio_status == 'completed' AND call_sid != winner_leg_sid AND duration_sec > 0"
      set: "race_lost_after_answer"
    - default: "unknown"
  interaction_outcome:
    - when: "winner_leg_sid IS NOT NULL"
      set: "answered"
    - when: "winner_leg_sid IS NULL AND exists(child legs)"
      set: "missed"
    - when: "winner_leg_sid IS NULL AND no child legs AND parent still active"
      set: "in_progress"
    - when: "winner_leg_sid IS NULL AND no child legs AND parent completed"
      set: "abandoned"

ui_requirements:
  list_view:
    show_only: "interactions (root level)"
    hide: "child legs как отдельные строки"
    columns:
      - "Дата/время"
      - "Номер клиента"
      - "Итог (interaction_outcome)"
      - "Длительность (по parent/root)"
      - "Оператор (winner если есть)"
      - "Попытки (например 1/3 answered)"
    badges:
      answered: "Answered"
      missed: "Missed"
      abandoned: "Abandoned"
      in_progress: "In progress"
  detail_view:
    header:
      - "Interaction SID"
      - "Client number"
      - "Root status + duration"
      - "Winner leg/operator"
    sections:
      - name: "Attempts timeline"
        content: "Все child legs по времени"
      - name: "Attempt statuses"
        content: "derived_attempt_status + twilio_status + duration + endpoint/operator"
      - name: "Raw Twilio refs"
        content: "call_sid, parent_call_sid"
  filters:
    - "by interaction_outcome"
    - "by from_number"
    - "by date range"
    - "by operator (winner/non-winner)"
  search:
    - "по номеру"
    - "по interaction_sid"
    - "по call_sid (ведет в карточку interaction)"

internal_api_contract:
  - endpoint: "GET /api/interactions"
    query:
      - "date_from, date_to"
      - "outcome[]"
      - "from_number"
      - "operator_id"
      - "page, page_size"
    response_item:
      - "interaction_sid"
      - "started_at"
      - "from_number"
      - "to_number"
      - "interaction_outcome"
      - "winner_leg_sid"
      - "winner_operator_id"
      - "duration_sec"
      - "attempts_summary {total, answered, missed, busy, failed, canceled, race_lost}"
  - endpoint: "GET /api/interactions/{interaction_sid}"
    response:
      - "interaction object"
      - "legs[] ordered by started_at asc"
  - endpoint: "POST /api/twilio/webhooks/dial-action"
    behavior:
      - "upsert winner_leg_sid, interaction_outcome"
  - endpoint: "POST /api/twilio/webhooks/call-progress"
    behavior:
      - "upsert leg snapshot + event journal"
  - endpoint: "POST /api/jobs/reconcile-interaction/{interaction_sid}"
    behavior:
      - "пересчет derived статусов и outcome"

business_rules:
  - "Статус parent/root НИКОГДА не использовать как единственный признак 'answered/missed'."
  - "Статус interaction определяется по winner_leg, а не только по parent completed."
  - "Child со статусом completed, но не winner — это попытка, а не отдельный разговор."
  - "В основном списке запрещено показывать child legs как отдельные звонки."

migration:
  backfill_window_days: 180
  steps:
    - "Выгрузить calls за период"
    - "Сгруппировать по interaction_sid = coalesce(parent_call_sid, call_sid)"
    - "Создать interactions"
    - "Создать call_legs"
    - "Запустить reconcile для каждой interaction"
  consistency_checks:
    - "Каждый child_leg имеет interaction_sid"
    - "В каждой interaction не более одного winner_leg_sid"
    - "Если winner_leg_sid задан, interaction_outcome=answered"

observability:
  metrics:
    - "interactions_count_daily"
    - "avg_attempts_per_interaction"
    - "rate_child_rows_hidden_in_list (ожидаемо 100%)"
    - "winner_detection_rate"
    - "reconcile_failures"
  alerts:
    - "winner_collision (>1 winner per interaction)"
    - "high_unknown_attempt_status"
    - "webhook_processing_lag > 60s"

acceptance_criteria:
  - id: "AC-01"
    text: "Список звонков отображает только root interactions; child legs в список не попадают."
  - id: "AC-02"
    text: "Карточка interaction показывает все child legs как attempts с derived_attempt_status."
  - id: "AC-03"
    text: "Если один child winner (answered), interaction_outcome=answered даже при других child no-answer/completed."
  - id: "AC-04"
    text: "Child completed без winner не трактуется как отдельный успешный разговор."
  - id: "AC-05"
    text: "Повторные webhook-события не создают дублей legs/attempts."
  - id: "AC-06"
    text: "По interaction_sid открывается единая карточка разговора с полной историей попыток."

test_cases:
  - name: "Один входящий + 3 child, один ответил"
    input:
      - "parent: completed, duration=24"
      - "child A: completed, duration=18 (winner)"
      - "child B: completed, duration=null"
      - "child C: no-answer"
    expected:
      - "В списке: 1 interaction, outcome=answered"
      - "В карточке: A=answered_by_agent, B=race_lost_after_answer, C=no_answer_or_rejected"
  - name: "Никто не ответил"
    input:
      - "parent: completed"
      - "child A: no-answer"
      - "child B: busy"
    expected:
      - "interaction_outcome=missed"
  - name: "Вебхук completed пришел раньше answered"
    expected:
      - "После reconcile winner определяется корректно, outcome стабилен"

delivery_plan:
  phase_1:
    - "DB schema + ingest + reconcile service"
  phase_2:
    - "Новый list API и detail API"
  phase_3:
    - "UI list/detail migration"
  phase_4:
    - "Backfill + валидация + feature flag rollout"
---

# Цель реализации

Убрать «размножение звонков» в CRM: один клиентский звонок = один разговор в списке,  
а все child-вызовы отображаются только внутри карточки разговора.

# Ключевая логика отделения статусов

1. **Не использовать parent status как итог разговора.**  
2. Определять **winner leg** (кто реально взял звонок).  
3. Выставлять итог interaction по winner:
   - есть winner → `answered`
   - winner нет, но были attempts → `missed`
4. Любые non-winner child (`completed`, `no-answer`, `busy`, `canceled`, `failed`) — это **попытки дозвона**, не отдельные разговоры.

# Псевдокод классификации

```pseudo
interaction_sid = coalesce(parent_call_sid, call_sid)

legs = get_child_legs(interaction_sid)
winner_leg_sid = resolve_winner(legs, dial_action_callback)

for leg in legs:
  if leg.call_sid == winner_leg_sid:
    leg.derived = "answered_by_agent"
  else if leg.twilio_status == "no-answer":
    leg.derived = "no_answer_or_rejected"
  else if leg.twilio_status == "busy":
    leg.derived = "busy"
  else if leg.twilio_status == "failed":
    leg.derived = "failed"
  else if leg.twilio_status == "canceled":
    leg.derived = "canceled_race"
  else if leg.twilio_status == "completed":
    leg.derived = "race_lost_after_answer"
  else:
    leg.derived = "unknown"

if winner_leg_sid != null:
  interaction.outcome = "answered"
else if legs.count > 0:
  interaction.outcome = "missed"
else:
  interaction.outcome = parent_active ? "in_progress" : "abandoned"
```

# Definition of Done

- В проде список показывает только interactions (root), child-строки не попадают в общий список.
- В карточке interaction полно и корректно видны все attempts.
- На вашем проблемном кейсе (mixed child statuses) итог всегда один и корректный: **answered**, если есть winner.
