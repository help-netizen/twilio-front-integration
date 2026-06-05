# Тест-кейсы: F017 — Согласованность Softphone и User Groups

**Спецификация:** `docs/specs/F017-telephony-groups-softphone-consolidation.md`

## Покрытие
- Всего тест-кейсов: 51
- P0: 16 | P1: 15 | P2: 8 | P3: 3
- Unit: 15 | Integration: 21 | E2E: 5
- Трассируемость: все 48 требований F017 имеют ≥1 тест-кейс (см. § Матрица в конце)

---

## 1. Маршрутизация: номер → группа (F-ROU, F-INC)

### TC-F017-001: Привязка номера к группе пишет group_id
- **Приоритет:** P0 · **Тип:** Integration
- **Сценарий:** F-INC-02
- **Шаги:** PUT /api/phone-numbers/:id/group `{ group_id: 'ug-1' }`
- **Ожидание:** `phone_number_settings.group_id = 'ug-1'`, `routing_mode='client'` автоматически
- **Файл:** `tests/routes/phoneNumbers.test.js`

### TC-F017-002: Привязка занятого номера к другой группе → 409
- **Приоритет:** P1 · **Тип:** Integration
- **Сценарий:** F-ROU-02, F-GRP-07
- **Предусловие:** номер уже привязан к 'ug-1'
- **Шаги:** PUT /api/phone-numbers/:id/group `{ group_id: 'ug-2' }`
- **Ожидание:** 409 с именем текущей группы; привязка не меняется
- **Файл:** `tests/routes/phoneNumbers.test.js`

### TC-F017-003: Отвязка номера (group_id=null)
- **Приоритет:** P1 · **Тип:** Integration
- **Сценарий:** F-ROU-01
- **Шаги:** PUT /api/phone-numbers/:id/group `{ group_id: null }`
- **Ожидание:** `group_id=NULL`; входящий на номер → voicemail/reject
- **Файл:** `tests/routes/phoneNumbers.test.js`

### TC-F017-004: Входящий резолвит группу по номеру
- **Приоритет:** P0 · **Тип:** Integration
- **Сценарий:** F-ROU-03, F-INC-04
- **Моки:** Twilio signature valid; `phone_number_settings` → group_id='ug-1'
- **Шаги:** POST /webhooks/twilio/voice-inbound `{ To: '+1..01', From, CallSid }`
- **Ожидание:** создаётся `call_flow_executions` для CallSid с group_id='ug-1', TwiML первого узла flow
- **Файл:** `tests/webhooks/voiceInbound.test.js`

### TC-F017-005: Входящий на номер без группы → voicemail
- **Приоритет:** P1 · **Тип:** Integration
- **Сценарий:** F-ROU-04
- **Шаги:** voice-inbound на номер с group_id=NULL
- **Ожидание:** TwiML voicemail (Record), без рассылки агентам
- **Файл:** `tests/webhooks/voiceInbound.test.js`

### TC-F017-006: Состояние исполнения сохраняется и резолвится на dial-action
- **Приоритет:** P0 · **Тип:** Integration
- **Сценарий:** F-INC-05, F-ROU-08
- **Шаги:** voice-inbound → запись в call_flow_executions; затем voice-dial-action с тем же CallSid
- **Ожидание:** `advance()` читает current_node_id из call_flow_executions, переходит по событию
- **Файл:** `tests/services/callFlowRuntime.test.js`

---

## 2. Исполнение flow-нод (F-FLOW)

### TC-F017-010: Hours Check — рабочие часы → Business Hours branch
- **Приоритет:** P0 · **Тип:** Unit
- **Сценарий:** F-FLOW-01
- **Вход:** flow с Hours Check; время внутри расписания группы (timezone-aware)
- **Ожидание:** переход по edge с condExpr `isBusinessHours === true`
- **Файл:** `tests/services/callFlowRuntime.test.js`

### TC-F017-011: Hours Check — нерабочие часы → After Hours branch
- **Приоритет:** P0 · **Тип:** Unit
- **Сценарий:** F-FLOW-01
- **Вход:** время вне расписания
- **Ожидание:** переход по `isBusinessHours === false`
- **Файл:** `tests/services/callFlowRuntime.test.js`

### TC-F017-012: Hours Check учитывает timezone группы
- **Приоритет:** P1 · **Тип:** Unit
- **Сценарий:** F-FLOW-01, F-GRP-08
- **Вход:** группа timezone=America/Los_Angeles, серверное UTC, граница 09:00 local
- **Ожидание:** isBusinessHours вычислен по local-времени группы, не UTC
- **Файл:** `tests/services/callFlowRuntime.test.js`

### TC-F017-013: Queue рингует только available-агентов группы (Simultaneous)
- **Приоритет:** P0 · **Тип:** Integration
- **Сценарий:** F-FLOW-02, F-INC-06
- **Предусловие:** группа A,B,C; A available, B on_call, C offline
- **Ожидание:** TwiML `<Dial>` содержит Client только для A; B и C исключены
- **Файл:** `tests/services/callFlowRuntime.test.js`

### TC-F017-014: Queue таймаут → edge "Not answered / timeout"
- **Приоритет:** P0 · **Тип:** Integration
- **Сценарий:** F-FLOW-02
- **Шаги:** Queue с timeout_sec; dial-action со статусом no-answer
- **Ожидание:** advance переходит по event `queue.timeout queue.not_answered queue.failed`
- **Файл:** `tests/services/callFlowRuntime.test.js`

### TC-F017-015: Queue без available-агентов → сразу fallback
- **Приоритет:** P1 · **Тип:** Integration
- **Сценарий:** edge case "Группа без агентов"
- **Предусловие:** все агенты offline/on_call
- **Ожидание:** не рингует, сразу переход на voicemail edge
- **Файл:** `tests/services/callFlowRuntime.test.js`

### TC-F017-016: Voicemail нода → Record TwiML + статус voicemail_recorded
- **Приоритет:** P0 · **Тип:** Integration
- **Сценарий:** F-FLOW-03, F-INC-07
- **Ожидание:** TwiML `<Record>`; после записи call → voicemail_recorded; SSE агентам группы
- **Файл:** `tests/services/callFlowRuntime.test.js`

### TC-F017-017: Greeting нода → Play аудио
- **Приоритет:** P1 · **Тип:** Unit
- **Сценарий:** F-FLOW-04
- **Ожидание:** TwiML `<Play>` URL из Audio Library, переход к next
- **Файл:** `tests/services/callFlowRuntime.test.js`

### TC-F017-018: Transfer нода → Dial номер/SIP
- **Приоритет:** P1 · **Тип:** Unit
- **Сценарий:** F-FLOW-05
- **Ожидание:** TwiML `<Dial>` на указанный target
- **Файл:** `tests/services/callFlowRuntime.test.js`

### TC-F017-019: Hang Up нода → Say + Hangup
- **Приоритет:** P1 · **Тип:** Unit
- **Сценарий:** F-FLOW-06
- **Ожидание:** TwiML `<Say>?<Hangup>`
- **Файл:** `tests/services/callFlowRuntime.test.js`

### TC-F017-020: VAPI AI нода → SIP dial (reuse buildVapiSipTwiml)
- **Приоритет:** P1 · **Тип:** Integration
- **Сценарий:** F-FLOW-07
- **Ожидание:** TwiML SIP к VAPI; после — переход по vapi.completed/vapi.failed
- **Файл:** `tests/services/callFlowRuntime.test.js`

### TC-F017-021: Branch нода — кастомное условие
- **Приоритет:** P2 · **Тип:** Unit
- **Сценарий:** F-FLOW-08
- **Вход:** Branch с condExpr `callerNumber === '+1555...'`
- **Ожидание:** выбран правильный edge по результату выражения
- **Файл:** `tests/services/callFlowRuntime.test.js`

### TC-F017-022: Контекст вызова доступен в выражениях
- **Приоритет:** P2 · **Тип:** Unit
- **Сценарий:** F-FLOW-09
- **Ожидание:** groupName, calledNumber, callerNumber, isBusinessHours, callSid, queueWaitTime присутствуют в контексте
- **Файл:** `tests/services/callFlowRuntime.test.js`

### TC-F017-023: Стратегия Simultaneous единственная (нет Round Robin)
- **Приоритет:** P0 · **Тип:** Unit
- **Сценарий:** F-FLOW-10
- **Ожидание:** UI RING_STRATEGIES содержит только Simultaneous; миграция выставила strategy='Simultaneous' всем группам
- **Файл:** `tests/routes/userGroups.test.js`

---

## 3. Softphone: гейтинг и видимость (F-SP)

### TC-F017-030: GET /api/user-groups/my возвращает группы пользователя
- **Приоритет:** P0 · **Тип:** Integration
- **Сценарий:** F-GRP-10
- **Предусловие:** пользователь U в группах ug-1, ug-2
- **Ожидание:** ответ содержит ug-1, ug-2; группы других company — отсутствуют (изоляция)
- **Файл:** `tests/routes/userGroups.test.js`

### TC-F017-031: /api/user-groups/my без авторизации → 401
- **Приоритет:** P0 · **Тип:** Integration
- **Сценарий:** middleware
- **Ожидание:** 401
- **Файл:** `tests/routes/userGroups.test.js`

### TC-F017-032: /api/user-groups/my изоляция company
- **Приоритет:** P0 · **Тип:** Integration
- **Сценарий:** security
- **Предусловие:** группа company B
- **Ожидание:** пользователь company A не видит группы company B
- **Файл:** `tests/routes/userGroups.test.js`

### TC-F017-033: Пользователь не в группах → Softphone скрыт
- **Приоритет:** P0 · **Тип:** Unit (RTL)
- **Сценарий:** F-SP-01, F-SP-02
- **Предусловие:** /api/user-groups/my → []
- **Ожидание:** SoftPhoneHeaderButton не рендерится; Twilio Device не инициализирован
- **Файл:** `frontend` unit (SoftPhoneHeaderButton)

### TC-F017-034: Пользователь в группе → Softphone виден
- **Приоритет:** P0 · **Тип:** Unit (RTL)
- **Сценарий:** F-SP-01
- **Ожидание:** кнопка Softphone отображается
- **Файл:** `frontend` unit

### TC-F017-035: Caller ID picker — только номера групп пользователя
- **Приоритет:** P1 · **Тип:** Integration
- **Сценарий:** F-SP-04
- **Предусловие:** U в Sales(+01) и Support(+02); существует +03 чужой группы
- **Шаги:** GET /api/voice/blanc-numbers (as U)
- **Ожидание:** возвращены +01, +02 с group_name; +03 отсутствует
- **Файл:** `tests/routes/voice.test.js`

### TC-F017-036: Группы без номеров → picker скрыт, дефолтный caller ID
- **Приоритет:** P1 · **Тип:** Integration
- **Сценарий:** F-SP-05
- **Ожидание:** blanc-numbers пустой → исходящий с OUTBOUND_CALLER_ID
- **Файл:** `tests/routes/voice.test.js`

### TC-F017-037: Номер в picker подписан группой
- **Приоритет:** P1 · **Тип:** Integration
- **Сценарий:** F-SP-06
- **Ожидание:** каждый номер имеет group_name
- **Файл:** `tests/routes/voice.test.js`

---

## 4. Статус агента (F-SP-07..09, F-GRP-03)

### TC-F017-040: Активный звонок → статус on_call
- **Приоритет:** P1 · **Тип:** Unit
- **Сценарий:** F-SP-07
- **Ожидание:** agentPresence отмечает on_call при активном вызове
- **Файл:** `tests/services/agentPresence.test.js`

### TC-F017-041: Завершение звонка → статус available
- **Приоритет:** P1 · **Тип:** Unit
- **Сценарий:** F-SP-07, AC-05
- **Ожидание:** после hangup статус авто → available
- **Файл:** `tests/services/agentPresence.test.js`

### TC-F017-042: Softphone закрыт → offline
- **Приоритет:** P1 · **Тип:** Unit
- **Сценарий:** F-SP-07
- **Ожидание:** Device disconnect → offline
- **Файл:** `tests/services/agentPresence.test.js`

### TC-F017-043: Статус транслируется через SSE участникам группы
- **Приоритет:** P1 · **Тип:** Integration
- **Сценарий:** F-SP-08, F-GRP-03
- **Ожидание:** событие agent.status.changed с groupIds; страница User Groups обновляется
- **Файл:** `tests/services/agentPresence.test.js`

### TC-F017-044: on_call/offline агенты не получают новый звонок
- **Приоритет:** P0 · **Тип:** Integration
- **Сценарий:** F-SP-09
- **Ожидание:** Queue исключает не-available из Dial
- **Файл:** `tests/services/callFlowRuntime.test.js`

---

## 5. Управление группами (F-GRP)

### TC-F017-050: UserGroupDetailPage читает API (не mock)
- **Приоритет:** P0 · **Тип:** Unit (RTL)
- **Сценарий:** F-GRP-01
- **Ожидание:** компонент вызывает GET /api/user-groups/:id; нет импорта userGroupsMock
- **Файл:** `frontend` unit

### TC-F017-051: Достижимость группы (есть available-агент)
- **Приоритет:** P1 · **Тип:** Unit
- **Сценарий:** F-GRP-04
- **Ожидание:** хотя бы один available → "достижима"; иначе предупреждение
- **Файл:** `frontend` unit

### TC-F017-052: Phone Numbers показывает группу/Unassigned
- **Приоритет:** P2 · **Тип:** Unit (RTL)
- **Сценарий:** F-GRP-05
- **Ожидание:** badge группы или "Unassigned"
- **Файл:** `frontend` unit

### TC-F017-053: Состояние по расписанию "Open now/Closed"
- **Приоритет:** P2 · **Тип:** Unit
- **Сценарий:** F-GRP-09
- **Ожидание:** корректный расчёт по timezone группы
- **Файл:** `frontend` unit

---

## 6. Flow versioning (F-ROU-05/06/08)

### TC-F017-060: Save flow применяется сразу (нет publish)
- **Приоритет:** P0 · **Тип:** Integration
- **Сценарий:** F-ROU-06, AC-06
- **Шаги:** PUT flow graph; затем новый входящий
- **Ожидание:** звонок исполняется по сохранённой версии; нет шага публикации
- **Файл:** `tests/routes/userGroups.test.js`

### TC-F017-061: Активный звонок не ломается при правке flow
- **Приоритет:** P0 · **Тип:** Integration
- **Сценарий:** F-ROU-08, edge case
- **Шаги:** старт звонка → правка flow → dial-action
- **Ожидание:** advance использует зафиксированный execution, не новую версию
- **Файл:** `tests/services/callFlowRuntime.test.js`

### TC-F017-062: Группа без flow → skeleton по умолчанию
- **Приоритет:** P1 · **Тип:** Integration
- **Сценарий:** edge case "нет flow"
- **Ожидание:** ensureFlowForGroup создаёт skeleton; звонок исполняется
- **Файл:** `tests/routes/userGroups.test.js`

---

## 7. Операционная панель (F-OPS)

### TC-F017-070: Dashboard группирует активные звонки по группам
- **Приоритет:** P2 · **Тип:** E2E
- **Сценарий:** F-OPS-01
- **Файл:** e2e suite

### TC-F017-071: Transfer звонка на агента группы
- **Приоритет:** P2 · **Тип:** Integration
- **Сценарий:** F-OPS-02
- **Файл:** `tests/services/callFlowRuntime.test.js`

### TC-F017-072: Routing Logs фильтр по группе
- **Приоритет:** P3 · **Тип:** Integration
- **Сценарий:** F-OPS-03
- **Файл:** `tests/routes/routingLogs.test.js`

### TC-F017-073: Routing Logs показывает путь flow
- **Приоритет:** P3 · **Тип:** Integration
- **Сценарий:** F-OPS-04
- **Файл:** `tests/routes/routingLogs.test.js`

---

## 8. E2E приёмочные (из спецификации §11)

### TC-F017-080: AC-01 happy path — входящий → flow → агент принимает
- **Приоритет:** P0 · **Тип:** E2E
- **Файл:** e2e suite

### TC-F017-081: AC-02 агент занят → voicemail по таймауту
- **Приоритет:** P1 · **Тип:** E2E
- **Файл:** e2e suite

### TC-F017-082: AC-03 не в группе → нет Softphone
- **Приоритет:** P0 · **Тип:** E2E
- **Файл:** e2e suite

### TC-F017-083: AC-04 две группы → оба номера в picker
- **Приоритет:** P1 · **Тип:** E2E
- **Файл:** e2e suite

---

## 9. Дополнительные кейсы (закрытие пробелов трассируемости)

### TC-F017-038: Привязка номера обновляет Twilio webhook
- **Приоритет:** P1 · **Тип:** Integration
- **Сценарий:** F-INC-01
- **Моки:** getTwilioClient → mock incomingPhoneNumbers().update()
- **Шаги:** PUT /api/phone-numbers/:id/group `{ group_id: 'ug-1' }`
- **Ожидание:** вызван Twilio update с voiceUrl = `{baseUrl}/webhooks/twilio/voice-inbound`; при ошибке Twilio API — откат записи group_id (БД↔Twilio консистентны)
- **Файл:** `tests/routes/phoneNumbers.test.js`

### TC-F017-039: Inline-edit имени группы на detail-странице
- **Приоритет:** P2 · **Тип:** Unit (RTL)
- **Сценарий:** F-GRP-02
- **Шаги:** изменить имя инлайн → blur/save
- **Ожидание:** PUT /api/user-groups/:id без перезагрузки; add/remove членов и номеров работают инлайн
- **Файл:** `frontend` unit (UserGroupDetailPage)

### TC-F017-045: Detail-страница показывает дату последнего сохранения flow
- **Приоритет:** P2 · **Тип:** Unit (RTL)
- **Сценарий:** F-ROU-07
- **Ожидание:** отображается updated_at flow и сводка нод; НЕТ индикатора «неопубликованных изменений»
- **Файл:** `frontend` unit (UserGroupDetailPage)

---

## Матрица трассируемости: требование → тест-кейс

```yaml
traceability:
  F-ROU-01: [TC-F017-003]
  F-ROU-02: [TC-F017-002]
  F-ROU-03: [TC-F017-004, TC-F017-080]
  F-ROU-04: [TC-F017-005]
  F-ROU-05: [TC-F017-060]
  F-ROU-06: [TC-F017-060]
  F-ROU-07: [TC-F017-045]
  F-ROU-08: [TC-F017-061]
  F-FLOW-01: [TC-F017-010, TC-F017-011, TC-F017-012]
  F-FLOW-02: [TC-F017-013, TC-F017-014, TC-F017-015]
  F-FLOW-03: [TC-F017-016]
  F-FLOW-04: [TC-F017-017]
  F-FLOW-05: [TC-F017-018]
  F-FLOW-06: [TC-F017-019]
  F-FLOW-07: [TC-F017-020]
  F-FLOW-08: [TC-F017-021]
  F-FLOW-09: [TC-F017-022]
  F-FLOW-10: [TC-F017-023]
  F-SP-01: [TC-F017-033, TC-F017-034, TC-F017-082]
  F-SP-02: [TC-F017-033]
  F-SP-03: [TC-F017-033]
  F-SP-04: [TC-F017-035, TC-F017-083]
  F-SP-05: [TC-F017-036]
  F-SP-06: [TC-F017-037]
  F-SP-07: [TC-F017-040, TC-F017-041, TC-F017-042]
  F-SP-08: [TC-F017-043]
  F-SP-09: [TC-F017-044]
  F-INC-01: [TC-F017-038]
  F-INC-02: [TC-F017-001, TC-F017-004]
  F-INC-03: [TC-F017-001]
  F-INC-04: [TC-F017-004]
  F-INC-05: [TC-F017-006]
  F-INC-06: [TC-F017-013, TC-F017-044]
  F-INC-07: [TC-F017-016]
  F-GRP-01: [TC-F017-050]
  F-GRP-02: [TC-F017-039]
  F-GRP-03: [TC-F017-043]
  F-GRP-04: [TC-F017-051]
  F-GRP-05: [TC-F017-052]
  F-GRP-06: [TC-F017-002, TC-F017-052]
  F-GRP-07: [TC-F017-002]
  F-GRP-08: [TC-F017-012]
  F-GRP-09: [TC-F017-053]
  F-GRP-10: [TC-F017-030, TC-F017-031, TC-F017-032]
  F-OPS-01: [TC-F017-070]
  F-OPS-02: [TC-F017-071]
  F-OPS-03: [TC-F017-072]
  F-OPS-04: [TC-F017-073]
coverage: "48/48 требований покрыты"
```
