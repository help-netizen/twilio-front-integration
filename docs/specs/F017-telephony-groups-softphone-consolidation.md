---
document:
  id: "F017"
  title: "Согласованность Softphone и User Groups — единая система управления звонками"
  version: "1.0"
  last_updated: "2026-06-05"
  language: "ru"
  format: "YAML + Markdown"
  owner: "Robert"
  status: "ready-for-planning"
  scope: "functional-requirements-only"
  objective: >
    Связать две независимо работающие подсистемы — Softphone и User Groups — в единую
    систему маршрутизации звонков, где группа является единицей маршрутизации: номер
    принадлежит группе, у группы есть call flow и агенты, входящий звонок исполняет
    flow группы и рингует только её агентов, а Softphone видит только номера и звонки
    своих групп.

  key_decisions:
    multi_group_membership: "Агент может состоять в нескольких группах одновременно и получает звонки из всех своих групп"
    agent_availability: "Только автоматическая: on_call = активный звонок, available = нет звонка, offline = Softphone закрыт"
    flow_execution: "Приоритет №1 — call flow реально исполняется при входящем звонке как конечный автомат"
    ring_strategy: "Только Simultaneous (одновременный звонок всем доступным агентам группы). Round Robin / Most Idle / Sequential / Weighted убираются из UI и функционала"
    flow_versioning: "Без draft/published. Одна актуальная версия flow на группу; сохранение = немедленное применение"

  current_state_problems:
    - "Softphone показывается всем с phone_calls_allowed=true, без учёта групп"
    - "Входящий звонок рингует ВСЕХ разрешённых пользователей, игнорируя группу/flow/расписание/стратегию"
    - "Caller ID picker показывает все client-номера без фильтрации по группам пользователя"
    - "Flow Builder строит SCXML-граф, но он не исполняется при реальных звонках"
    - "UserGroupDetailPage читает mock-данные (userGroupsMock.ts), а не API"
    - "Доступность агента не синхронизирована с реальным статусом звонка"
    - "Ring Strategy хранится в БД, но не исполняется"

  non_goals:
    - "hold / swap / conference"
    - "многоуровневый IVR за пределами нод текущего Flow Builder"
    - "биллинг и тарификация звонков"
    - "UI управления записями звонков"
    - "RBAC на уровне групп (кто может редактировать какую группу)"
    - "версионирование и снимки flow"

  affected_modules:
    backend:
      - "backend/src/routes/userGroups.js"
      - "backend/src/routes/voice.js (blanc-numbers → фильтр по группам)"
      - "backend/src/webhooks/twilioWebhooks.js (handleVoiceInbound → исполнение flow)"
      - "backend/src/services/* (новый сервис исполнения flow)"
      - "backend/db/migrations/* (group_id в phone_number_settings, call_flow_executions)"
      - "src/server.js (mount новых routes)"
    frontend:
      - "frontend/src/components/softphone/useSoftPhoneWidget.ts"
      - "frontend/src/components/layout/SoftPhoneHeaderButton.tsx"
      - "frontend/src/pages/telephony/UserGroupsPage.tsx"
      - "frontend/src/pages/telephony/UserGroupDetailPage.tsx (убрать mock)"
      - "frontend/src/pages/telephony/PhoneNumbersPage.tsx"
      - "frontend/src/pages/telephony/CallFlowBuilderPage.tsx"
      - "frontend/src/pages/telephony/OperationsDashboardPage.tsx"
    integrations:
      - "Twilio Voice (inbound webhook, Dial, Record)"
      - "VAPI (SIP transfer node — уже реализован buildVapiSipTwiml)"

  protected_code:
    - "frontend/src/lib/authedFetch.ts"
    - "frontend/src/hooks/useRealtimeEvents.ts"
    - "src/server.js core middleware (изменения только mount-only)"
---

# F017 — Согласованность Softphone и User Groups

## Обзор

Группа (User Group) становится центральной единицей маршрутизации. Связь:

```
Телефонный номер ──(1:1)──▶ Группа ──▶ Call Flow (1 актуальная версия)
                                  │
                                  └──▶ Агенты (M:N, агент может быть в нескольких группах)

Входящий звонок на номер
  → определяется группа номера
  → исполняется flow группы (Hours Check → Queue → Voicemail / custom nodes)
  → нода Queue рингует ОДНОВРЕМЕННО доступных агентов группы
```

Принятые продуктовые решения зафиксированы в `document.key_decisions` выше.

---

## 1. Группы как единица маршрутизации

### 1.1 Модель «номер → группа → flow → агенты»

```yaml
requirements:
  - id: F-ROU-01
    priority: P1
    statement: "Каждый телефонный номер привязан ровно к одной группе. Номер без группы — сиротский, входящие на него не обрабатываются (voicemail/reject)."
  - id: F-ROU-02
    priority: P1
    statement: "Номер нельзя привязать к двум группам. При попытке добавить уже закреплённый номер в другую группу — предупреждение с предложением открепить."
  - id: F-ROU-03
    priority: P0
    statement: "При входящем звонке на номер система определяет его группу, берёт текущий flow группы и исполняет его как конечный автомат."
  - id: F-ROU-04
    priority: P1
    statement: "Если у номера нет группы — звонок уходит на voicemail с дефолтным сообщением."
```

### 1.2 Единственная актуальная версия flow (без draft/published)

```yaml
requirements:
  - id: F-ROU-05
    priority: P0
    statement: "У группы ровно один flow — всегда актуальный. Нет статусов draft/published, нет снимков версий, нет отдельного действия публикации."
  - id: F-ROU-06
    priority: P0
    statement: "Кнопка Save в Flow Builder немедленно делает сохранённый flow активным для входящих звонков группы. Следующий звонок исполняется по сохранённой версии."
  - id: F-ROU-07
    priority: P2
    statement: "На странице группы отображается дата последнего сохранения flow и сводка нод. Индикаторов «неопубликованных изменений» не существует."
  - id: F-ROU-08
    priority: P0
    statement: "Запущенный звонок дорабатывает по версии flow, зафиксированной на момент старта (через call_flow_executions). Правка flow в процессе чужого звонка его не ломает."

implementation_notes:
  - "Таблица call_flows: одна строка на группу (graph_json + updated_at), без колонки status и без версионных снимков."
  - "ensureFlowForGroup (уже в userGroups.js) остаётся: нет flow — создаётся skeleton; есть — отдаётся он."
  - "Кнопка Publish не добавляется. Остаётся существующая Save."
```

---

## 2. Исполнение Call Flow (приоритет №1)

### 2.1 Skeleton-ноды должны реально работать

```yaml
requirements:
  - id: F-FLOW-01
    priority: P0
    node: "Hours Check (branch)"
    statement: "Проверяет текущее время по расписанию группы (с учётом timezone) и переключает переходы Business Hours / After Hours."
  - id: F-FLOW-02
    priority: P0
    node: "Queue"
    statement: >
      Рингует ОДНОВРЕМЕННО всех доступных агентов группы (стратегия Simultaneous —
      единственная). Таймаут берётся из config ноды (timeout_sec). Если все заняты /
      никто не ответил за таймаут — переход по edge 'Not answered / timeout'.
  - id: F-FLOW-03
    priority: P0
    node: "Voicemail"
    statement: "Проигрывает TTS-приветствие, принимает запись звонящего. После записи — статус voicemail_recorded."
  - id: F-FLOW-04
    priority: P1
    node: "Greeting (play audio)"
    statement: "Воспроизводит аудиофайл из Audio Library и переходит к следующей ноде."
  - id: F-FLOW-05
    priority: P1
    node: "Transfer"
    statement: "Переводит звонок на указанный номер/SIP."
  - id: F-FLOW-06
    priority: P1
    node: "Hang Up"
    statement: "Завершает звонок с опциональным TTS-сообщением."
  - id: F-FLOW-07
    priority: P1
    node: "VAPI AI Agent"
    statement: >
      Передаёт звонок в VAPI через SIP (buildVapiSipTwiml уже реализован). Продолжает
      flow после AI-сессии в зависимости от результата (vapi.completed / vapi.failed).
```

### 2.2 Branch-ноды и контекст вызова

```yaml
requirements:
  - id: F-FLOW-08
    priority: P2
    node: "Branch"
    statement: >
      Поддерживает условные переходы. В инспекторе — JS-выражение или выбор системной
      переменной (isBusinessHours, callerNumber, queueWaitTime).
  - id: F-FLOW-09
    priority: P2
    statement: "При исполнении flow доступен контекст вызова."
    context_variables:
      groupName: "название группы"
      calledNumber: "номер, на который звонят (E.164)"
      callerNumber: "номер звонящего (E.164)"
      isBusinessHours: "boolean — текущее время в рамках расписания группы"
      callSid: "Twilio CallSid"
      queueWaitTime: "время ожидания в очереди, сек"
```

### 2.3 Стратегия дозвона

```yaml
requirements:
  - id: F-FLOW-10
    priority: P0
    statement: >
      Единственная стратегия дозвона — Simultaneous. Опции Round Robin / Most Idle /
      Sequential / Weighted убираются из UI группы (UserGroupsPage RING_STRATEGIES) и
      из логики. Поле strategy в модели группы либо удаляется, либо фиксируется на
      'Simultaneous'.
```

---

## 3. Softphone: доступность и видимость

### 3.1 Гейтинг по группам

```yaml
requirements:
  - id: F-SP-01
    priority: P0
    statement: "Кнопка Softphone в хедере отображается ТОЛЬКО если пользователь — участник хотя бы одной группы."
  - id: F-SP-02
    priority: P0
    statement: >
      При открытии Softphone проверяется членство. Нет групп — Twilio Device не
      инициализируется, показывается заглушка: 'You are not assigned to any group.
      Ask your administrator.'
  - id: F-SP-03
    priority: P0
    statement: "Twilio Device (useTwilioDevice) инициализируется только для пользователей в группах."
```

### 3.2 Caller ID — только номера групп пользователя

```yaml
requirements:
  - id: F-SP-04
    priority: P1
    statement: >
      В dropdown 'Call from:' — ТОЛЬКО номера, привязанные к группам пользователя.
      Пользователь в двух группах видит номера обеих.
  - id: F-SP-05
    priority: P1
    statement: "Если у групп пользователя нет номеров — Caller ID picker скрыт, исходящий идёт с дефолтного номера компании (OUTBOUND_CALLER_ID)."
  - id: F-SP-06
    priority: P1
    statement: "Рядом с номером в dropdown отображается его группа (например '+1 617-555-0101 · Sales')."
```

### 3.3 Статус агента (автоматический)

```yaml
requirements:
  - id: F-SP-07
    priority: P1
    statement: "Статус агента только автоматический."
    states:
      available: "нет активного звонка в Softphone"
      on_call: "есть активный звонок"
      offline: "Softphone закрыт / Twilio Device не подключён"
  - id: F-SP-08
    priority: P1
    statement: "Статус передаётся через SSE участникам его групп. Страница User Groups обновляется в реальном времени."
  - id: F-SP-09
    priority: P1
    statement: "Агенты со статусом offline или on_call не получают новый входящий вызов из очереди."
```

---

## 4. Входящая маршрутизация через группы

```yaml
requirements:
  - id: F-INC-01
    priority: P1
    statement: "При сохранении привязки номера к группе система обновляет Twilio webhook номера на /webhooks/twilio/voice-inbound."
  - id: F-INC-02
    priority: P0
    statement: "phone_number_settings хранит group_id как ссылку на группу. Webhook handler читает group_id для определения группы, flow и агентов."
  - id: F-INC-03
    priority: P0
    statement: >
      routing_mode='client' устанавливается автоматически для номеров с группой. Ручное
      управление routing_mode из UI убирается — оно имплицитное следствие наличия группы.
  - id: F-INC-04
    priority: P0
    statement: >
      При входящем звонке: (1) определяется группа по номеру, (2) берётся текущий
      сохранённый flow группы, (3) исполняется start → hours_check → …, (4) каждый шаг
      генерирует TwiML.
  - id: F-INC-05
    priority: P0
    statement: "Состояние исполнения flow хранится в БД (call_flow_executions) для resume после Twilio callback'ов."
  - id: F-INC-06
    priority: P0
    statement: >
      Нода Queue рингует ТОЛЬКО агентов данной группы со статусом available. Это главное
      отличие от текущего поведения (рингуются все с phone_calls_allowed).
  - id: F-INC-07
    priority: P1
    statement: "После приёма voicemail-записи: запись сохраняется, call в inbox → voicemail_recorded, SSE-уведомление агентам группы."
```

---

## 5. Управление группами: недостающий функционал

### 5.1 Перевод detail-страницы на реальное API

```yaml
requirements:
  - id: F-GRP-01
    priority: P0
    statement: "UserGroupDetailPage читает из GET /api/user-groups/:id. Mock (userGroupsMock.ts) полностью убирается."
  - id: F-GRP-02
    priority: P1
    statement: "На detail-странице работают inline-edit имени и добавление/удаление членов и номеров без перезагрузки."
```

### 5.2 Real-time статус агентов группы

```yaml
requirements:
  - id: F-GRP-03
    priority: P1
    statement: "Статус каждого агента (available/on_call/offline) обновляется через SSE без перезагрузки — в списке групп и на detail-странице."
  - id: F-GRP-04
    priority: P1
    statement: >
      Индикатор достижимости группы: хотя бы один агент available — группа 'достижима';
      иначе предупреждение 'звонки уйдут на voicemail'.
```

### 5.3 Привязка номеров к группам

```yaml
requirements:
  - id: F-GRP-05
    priority: P2
    statement: "На странице Phone Numbers отображается группа каждого номера; не привязан — badge 'Unassigned'."
  - id: F-GRP-06
    priority: P2
    statement: "Привязать/отвязать номер от группы можно прямо со страницы Phone Numbers."
  - id: F-GRP-07
    priority: P2
    statement: "Один номер — одна группа. При привязке занятого: 'This number is already assigned to [Group]. Move it?' с подтверждением."
```

### 5.4 Расписание и timezone

```yaml
requirements:
  - id: F-GRP-08
    priority: P2
    statement: "Timezone группы используется при вычислении isBusinessHours. Не задан — берётся timezone компании."
  - id: F-GRP-09
    priority: P2
    statement: "На странице группы — визуализация состояния по расписанию: 'Open now' / 'Closed — opens Mon 9:00'."
```

### 5.5 Мои группы

```yaml
requirements:
  - id: F-GRP-10
    priority: P0
    statement: >
      GET /api/user-groups/my — группы текущего авторизованного пользователя. Используется
      Softphone для видимости (F-SP-01) и набора номеров (F-SP-04).
```

---

## 6. Операционная панель

```yaml
requirements:
  - id: F-OPS-01
    priority: P2
    statement: "В Operations Dashboard активные звонки группируются по группам: кто разговаривает, что в очереди, сколько ждут."
  - id: F-OPS-02
    priority: P2
    statement: "Для активного звонка — кнопка Transfer на другого агента группы (cold transfer через Twilio)."
  - id: F-OPS-03
    priority: P3
    statement: "Routing Logs фильтруются по группе."
  - id: F-OPS-04
    priority: P3
    statement: "В Routing Logs отображается путь исполнения flow (Hours Check → Queue → Voicemail)."
```

---

## 7. API-контракты (новые / изменяемые)

```yaml
api:
  - method: GET
    path: /api/user-groups/my
    auth: "authenticate + requireCompanyAccess"
    returns: "группы текущего пользователя (company_id из req.companyFilter)"
    new: true
  - method: GET
    path: /api/voice/blanc-numbers
    change: "фильтровать номера по группам текущего пользователя, добавить group_name к каждому номеру"
  - method: PUT
    path: /api/phone-numbers/:id/group
    auth: "authenticate + requireCompanyAccess"
    body: "{ group_id: string | null }"
    behavior: "привязка/отвязка; при занятом номере → 409 с именем текущей группы"
    new: true
  - method: GET
    path: /api/user-groups/:id
    change: "уже существует; UserGroupDetailPage переключается с mock на него (F-GRP-01)"
  - method: POST
    path: /webhooks/twilio/voice-inbound
    change: "handleVoiceInbound: вместо рассылки всем — определить группу → исполнить flow → ringать агентов группы"
sse_events:
  - "agent.status.changed — { userId, groupIds[], status }"
  - "group.call.queued / group.call.accepted / group.call.ended — синхронизация очереди группы"
```

---

## 8. Изменения схемы БД

```yaml
db_changes:
  phone_number_settings:
    add_column: "group_id TEXT REFERENCES user_groups(id) — привязка номера к группе"
    note: "routing_mode становится производным от наличия group_id (F-INC-03)"
  call_flows:
    note: "одна строка на группу, без status и версионных снимков (F-ROU-05)"
  call_flow_executions:
    new_table: true
    purpose: "состояние исполнения flow для resume между Twilio callback'ами (F-INC-05)"
    fields: "id, call_sid, group_id, flow_id, current_node_id, context_json, status, created_at, updated_at"
  user_groups:
    note: "поле strategy удаляется или фиксируется 'Simultaneous' (F-FLOW-10)"
  isolation: "Все запросы фильтруются по company_id (req.companyFilter?.company_id). Кросс-компанийные утечки запрещены."
```

---

## 9. Приоритизация

```yaml
priorities:
  P0_blocking:
    description: "Разблокируют связку групп, flow и softphone"
    items: [F-ROU-03, F-ROU-05, F-ROU-06, F-ROU-08, F-FLOW-01, F-FLOW-02, F-FLOW-03, F-FLOW-10, F-INC-02, F-INC-03, F-INC-04, F-INC-05, F-INC-06, F-SP-01, F-SP-02, F-SP-03, F-GRP-01, F-GRP-10]
  P1_connecting:
    description: "Связывают данные и UX"
    items: [F-ROU-01, F-ROU-02, F-ROU-04, F-FLOW-04, F-FLOW-05, F-FLOW-06, F-FLOW-07, F-SP-04, F-SP-05, F-SP-06, F-SP-07, F-SP-08, F-SP-09, F-INC-01, F-INC-07, F-GRP-02, F-GRP-03, F-GRP-04]
  P2_operational:
    description: "Операционное управление и детализация"
    items: [F-ROU-07, F-FLOW-08, F-FLOW-09, F-GRP-05, F-GRP-06, F-GRP-07, F-GRP-08, F-GRP-09, F-OPS-01, F-OPS-02]
  P3_analytics:
    items: [F-OPS-03, F-OPS-04]
```

---

## 10. Граничные состояния

```yaml
edge_cases:
  - case: "Агент в группе без номеров"
    behavior: "Может принимать входящие (если в группе с номерами есть); исходящие — с дефолтного номера компании."
  - case: "Группа без агентов"
    behavior: "Звонок сразу на voicemail при достижении ноды Queue."
  - case: "Все агенты группы на звонке"
    behavior: "Входящий ждёт в очереди до timeout; после — переход по flow (voicemail / следующая нода)."
  - case: "У группы нет сохранённого flow"
    behavior: "Применяется skeleton flow по умолчанию (hours check → queue → voicemail), автосоздаётся через ensureFlowForGroup. Состояния 'нет активной версии' не существует."
  - case: "Агент добавлен в группу во время активного звонка"
    behavior: "Новый звонок не придёт пока on_call; после завершения — по обычным правилам."
  - case: "Номер удалён из Twilio, но остался в группе"
    behavior: "Webhook упадёт 404. Система мониторит orphaned-номера и показывает предупреждение на странице группы."
  - case: "Flow отредактирован во время чужого активного звонка"
    behavior: "Активный звонок дорабатывает по зафиксированной версии (call_flow_executions); новые звонки — по новой (F-ROU-08)."
```

---

## 11. Критерии приёмки

```yaml
acceptance:
  - id: AC-01
    given: "Номер N привязан к группе G с опубликованным skeleton flow и одним available-агентом A"
    when: "Входящий звонок на N в рабочие часы группы"
    then: "Flow исполняется: Hours Check → Business Hours → Queue; рингует только A; A принимает звонок"
  - id: AC-02
    given: "Тот же номер N, агент A занят (on_call)"
    when: "Новый входящий на N"
    then: "A не получает рингтон; по таймауту Queue — переход на Voicemail"
  - id: AC-03
    given: "Пользователь U не состоит ни в одной группе"
    when: "U открывает приложение"
    then: "Кнопка Softphone не отображается; Twilio Device не инициализируется"
  - id: AC-04
    given: "Пользователь U в группах Sales (номер +1..01) и Support (номер +1..02)"
    when: "U открывает Softphone Caller ID picker"
    then: "В списке оба номера с подписями групп; номеров других групп нет"
  - id: AC-05
    given: "Агент завершил звонок"
    when: "Звонок окончен"
    then: "Статус агента автоматически → available; SSE обновляет страницу User Groups без перезагрузки"
  - id: AC-06
    given: "Админ редактирует flow группы и нажимает Save"
    when: "Следующий входящий звонок"
    then: "Звонок исполняется по только что сохранённой версии; никакого шага публикации не требуется"
  - id: AC-07
    given: "Номер уже привязан к группе Sales"
    when: "Админ пытается добавить его в Support"
    then: "Предупреждение 'already assigned to Sales. Move it?' с подтверждением; без подтверждения привязка не меняется"
```

---

## Ожидаемый результат

После реализации требований:

- **Softphone** виден только участникам групп, набирает только из номеров своих групп, статус агента синхронизирован с реальным звонком.
- **User Groups** — полноценная система: реальное API (без mock), real-time статусы, привязка номеров 1:1, расписание с timezone.
- **Call Flow** реально исполняется при входящем звонке: расписание → очередь группы → voicemail, плюс кастомные ноды (Transfer, VAPI AI, Branch).
- **Маршрутизация** идёт через группу: номер → группа → flow → доступные агенты, вместо текущей рассылки всем.
- **Flow** редактируется в одной актуальной версии и применяется сразу при сохранении.
