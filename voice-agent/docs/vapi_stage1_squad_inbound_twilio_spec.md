---
document:
  title: "VAPI Stage 1 — Blanc Vapi Agent Node via Twilio SIP"
  version: "2.0"
  last_updated: "2026-03-08"
  language: "ru"
  format: "YAML + Markdown"
  owner: "Robert"
  status: "draft-ready"
  stage: "Stage 1"
  objective: "Реализовать Vapi как переиспользуемую AI-ноду внутри групповых call flows в Blanc: входящий звонок приходит на номер группы в Twilio, попадает в flow этой группы в Blanc, а Vapi подключается по SIP как один из шагов flow и отвечает контролируемым приветствием."
  primary_stack:
    telephony_ingress: "Twilio"
    call_flow_owner: "Blanc"
    ai_voice_platform: "Vapi"
    transport_between_blanc_and_vapi: "Twilio <Dial><Sip> -> Vapi SIP URI"
    runtime_resolution: "Blanc runtime resolver via Vapi serverUrl / assistant-request"
    orchestration_entry_mode: "assistant-first"
    future_expansion: ["handoff", "transferCall", "specialized assistants", "optional static squads"]
    local_testing: ["Vapi CLI", "Twilio CLI", "ngrok or equivalent tunnel"]
  architecture_decision:
    selected: "Blanc-owned ingress + Twilio SIP bridge + Vapi Agent Node"
    rationale:
      - "Публичные номера и логика групп остаются в Blanc/Twilio, поэтому не нужно импортировать каждый DID в Vapi."
      - "Одна и та же Vapi-нода может использоваться в flows разных групп и автоматически получать runtime-контекст группы и звонка."
      - "Twilio умеет отправлять активный звонок на SIP endpoint через <Dial><Sip>, а Vapi умеет принимать SIP-вызовы через SIP phone number resource."
      - "Vapi для SIP поддерживает assistantId=null + serverUrl, то есть Blanc может динамически выбирать, какой assistant запускать на конкретный вызов."
      - "Для первого этапа надежнее использовать assistant-first ingress, потому что assistant-request в docs явно документирован через assistantId / assistant / destination."
  explicit_answers:
    do_we_need_specific_public_phone_number_in_vapi: "Нет. Публичные номера группы остаются в Twilio/Blanc."
    do_we_need_specific_vapi_endpoint: "Да. Нужен Vapi SIP endpoint (phone-number resource с sipUri), минимум один на среду."
    should_vapi_cli_be_the_node: "Нет. Нода в Blanc должна быть Vapi Agent Node. CLI используется только для provisioning, debugging и operations."
  non_goals_stage_1:
    - "Полная квалификация лида"
    - "Appointment scheduling"
    - "Сложная многошаговая оркестрация внутри Vapi"
    - "CRM/FSM updates из Vapi tools"
    - "Полноценный human warm transfer"
    - "Analytics, scorecards и production reporting"
  deliverable_of_this_stage:
    - "Любой публичный номер группы в Twilio продолжает входить в flow своей группы в Blanc"
    - "В flow можно добавить ноду Vapi Agent"
    - "Нода отправляет активный звонок из Twilio в Vapi по SIP"
    - "Blanc runtime resolver динамически задает assistant для конкретного звонка"
    - "Vapi assistant отвечает приветствием"
    - "После завершения разговора управление возвращается в Blanc flow через Twilio Dial action callback"
---

# 1. Главное изменение архитектуры

Предыдущая версия документа исходила из модели:

`Caller -> Twilio public number -> Vapi-owned phone number -> Vapi squad`

Для твоей платформы это **не лучший фундамент**, потому что у тебя уже есть собственная модель:

- в Blanc существуют **группы пользователей**;
- у группы есть **1 и более входящих номеров**;
- все номера группы входят в **flow этой группы**;
- внутри flow должны появляться разные ноды, включая AI.

Поэтому новая базовая модель должна быть такой:

`Caller -> Twilio public number -> Blanc group flow -> Vapi Agent Node -> Twilio SIP bridge -> Vapi assistant -> return / transfer`

То есть:

- **Blanc владеет call routing**;
- **Twilio владеет PSTN ingress**;
- **Vapi не владеет публичными номерами группы**, а выполняет роль AI execution layer;
- **Vapi CLI не является runtime-нодой**, а используется только для управления Vapi-ресурсами.

Это делает интеграцию совместимой с твоей текущей системой и не ломает существующую логику групп, номеров и маршрутизации.

---

# 2. Прямой ответ на вопрос: нужен ли конкретный номер телефона?

## 2.1. Публичный номер клиента / группы

**Нет, его не нужно задавать в Vapi как отдельный публичный phone number resource на каждый номер группы.**

Публичные номера остаются в Twilio и продолжают жить в модели Blanc:

```text
Group A:
  - +1 xxx xxx 1001
  - +1 xxx xxx 1002
  -> оба номера идут в flow Group A

Group B:
  - +1 xxx xxx 2001
  -> номер идет в flow Group B
```

Это правильно, потому что именно Blanc знает:

- к какой группе относится номер;
- какой flow сейчас активен;
- какая ветка сценария должна запускаться;
- когда нужно включить AI, а когда нет.

## 2.2. Нужен ли Vapi endpoint вообще?

**Да.** Хотя публичный PSTN-номер в Vapi не нужен, Vapi всё равно требует **конкретную SIP точку входа**.

Практически это означает:

- в Vapi создается **SIP phone number resource**;
- у него есть `sipUri` вида `sip:<name>@sip.vapi.ai`;
- Twilio будет направлять активный звонок на этот SIP URI;
- Vapi на этом URI поднимет нужного assistant.

Минимальная рекомендация для Stage 1:

- **1 SIP URI на среду** (`dev`, `uat`, `prod`).

Например:

```yaml
vapi_sip_ingress:
  dev:  "sip:blanc-ai-dev@sip.vapi.ai"
  uat:  "sip:blanc-ai-uat@sip.vapi.ai"
  prod: "sip:blanc-ai-prod@sip.vapi.ai"
```

Этого достаточно, чтобы одна и та же нода работала для разных групп и получала конкретные параметры уже из runtime-контекста звонка.

---

# 3. Почему Vapi Agent Node, а не “Vapi CLI Node”

`Vapi CLI` нужен, но это **не runtime-механизм обработки разговора**.

CLI в Vapi предназначен для:

- логина и переключения организаций;
- инициализации проекта;
- создания и обновления assistants;
- управления phone numbers;
- просмотра логов;
- локальной отладки webhook'ов.

Следовательно, правильное разделение обязанностей такое:

```yaml
blanc:
  runtime_node: "Vapi Agent Node"
  responsibility:
    - "вызвать Vapi из flow"
    - "передать runtime-контекст"
    - "обработать результат разговора"
    - "решить, что делать дальше в flow"

vapi_cli:
  role: "provisioning + debugging + operations"
  not_runtime: true
  responsibility:
    - "создать assistant"
    - "создать SIP phone number resource"
    - "обновить serverUrl"
    - "посмотреть logs"
    - "протестировать локальные webhooks"
```

Именно так нужно заложить интеграцию в архитектуре Blanc.

---

# 4. Целевая архитектура Stage 1

## 4.1. Базовый путь звонка

```text
Caller
  -> Twilio public phone number
  -> Twilio incoming webhook
  -> Blanc Group Flow
  -> Node: Vapi Agent
  -> Twilio <Dial><Sip>
  -> sip:blanc-ai-prod@sip.vapi.ai
  -> Vapi SIP phone number resource
  -> Blanc runtime resolver (assistant-request)
  -> Vapi assistant
  -> assistant speaks greeting
  -> assistant leg ends OR assistant transfers
  -> Twilio action callback returns control to Blanc
```

## 4.2. Что остается у Blanc

Blanc сохраняет контроль над:

- выбором group flow;
- branch logic до AI-ноды;
- branch logic после AI-ноды;
- вычислением transfer targets;
- политикой fallback;
- связью номера с группой;
- решением, запускать AI или нет.

## 4.3. Что отдаем Vapi

Vapi отвечает только за AI-часть:

- приветствие;
- голосовой диалог;
- follow-up questions;
- future handoff / transfer tools;
- structured extraction на следующих этапах.

---

# 5. Почему ingress на Stage 1 лучше строить через Assistant, а не сразу через Squad

Важно разделить **архитектурную абстракцию ноды** и **стартовый runtime-объект Vapi**.

## 5.1. Архитектурно нода должна быть универсальной

Нода в Blanc должна называться **`Vapi Agent`** и не зашиваться под `assistant` или `squad` на уровне UI-концепции.

Потому что позже она должна уметь:

- запускать простой assistant;
- запускать assistant, который затем handoff'ит в другого assistant;
- запускать fixed squad для специальных сценариев;
- пропускать AI и сразу переводить звонок на destination.

## 5.2. Но на ingress Stage 1 безопаснее выбрать assistant-first

Для SIP-входа Vapi явно документирует:

- `assistantId = null`;
- `serverUrl = https://your_server`;
- далее Vapi шлет `assistant-request`;
- сервер должен вернуть `assistantId`, transient `assistant` или `destination`.

Это явно документированный и надежный путь.

Поэтому на Stage 1 решение такое:

```yaml
entry_runtime_object:
  selected: "assistant"
  reason:
    - "assistant-request явно документирован через assistantId / assistant / destination"
    - "проще и надежнее для первого production-ready ingress"
    - "не мешает потом handoff'ить в других assistants или squads"
```

## 5.3. Как использовать squads позже

Squads остаются полезными, но **не как обязательный ingress Stage 1**.

Правильные варианты позже:

1. **Assistant-first + handoff**
   - entry assistant начинает разговор;
   - потом handoff в qualifier assistant;
   - потом handoff в scheduler assistant.

2. **Static squad by dedicated SIP endpoint**
   - для особой ноды можно завести отдельный SIP phone number resource;
   - задать ему фиксированный `squadId`;
   - запускать multi-agent orchestration сразу.

Это уже Stage 2+.

---

# 6. Контракт ноды `Vapi Agent` внутри Blanc

## 6.1. Что нода должна уметь концептуально

Нода должна быть переиспользуемой и не требовать ручного заполнения всех telephony-параметров для каждой группы.

Пользователь flow editor добавляет ноду в branch, а нода автоматически подхватывает:

- где мы сейчас находимся;
- какой это `groupId`;
- на какой `called number` пришел звонок;
- какой `flowId` и `nodeId` активны;
- куда возвращать управление;
- какие transfer destinations доступны.

## 6.2. Минимальный runtime input contract

```yaml
vapi_agent_node_runtime_input:
  call:
    parent_call_sid: "Twilio parent call SID"
    from_number: "caller E.164"
    to_number: "called E.164"
    direction: "inbound"

  blanc:
    company_id: "tenant/company id"
    group_id: "group id"
    group_name: "display name"
    flow_id: "current flow id"
    branch_id: "current branch id"
    node_id: "current node id"
    language_hint: "en | ru | auto"

  post_agent_policy:
    on_completed: "resume_flow"
    on_transfer: "leave_flow"
    on_error: "fallback_branch"
    on_timeout: "fallback_branch"

  transfer_context:
    allowed_targets:
      - "dispatcher"
      - "group main hunt"
      - "voicemail"
    default_target: "dispatcher"

  agent_profile:
    profile_id: "greeting-only-v1"
    first_message_style: "brief"
    script_locale: "en-US"
```

## 6.3. Node config в flow editor

```yaml
node_type: vapi_agent
node_config:
  enabled: true
  environment: prod
  transport: sip
  sip_ingress_alias: blanc-ai-prod
  runtime_resolution_mode: assistant-request
  assistant_profile_id: greeting_only_v1
  on_complete: resume_flow
  on_error: fallback_branch
  on_timeout: fallback_branch
  allow_immediate_transfer: false
```

## 6.4. Выходы ноды

```yaml
node_outputs:
  - completed
  - transferred
  - skipped
  - error
  - timeout
  - caller_hangup
```

---

# 7. Что нужно создать в Vapi

## 7.1. Persistent assistant для Stage 1

Минимально нужен **один persistent assistant на среду** для controlled greeting.

Пример логики:

- приветствует caller;
- коротко сообщает, что это appliance repair line;
- при Stage 1 не пытается полноценно вести booking;
- завершает разговор по сценарию или ждет дальнейшей логики, если ты так решишь.

## 7.2. SIP phone number resource

В Vapi создается SIP phone number resource с такими принципами:

```yaml
vapi_phone_number_resource:
  provider: vapi
  transport: sip
  assistantId: null
  serverUrl: "https://blanc.example.com/api/vapi/runtime"
  sipUri: "sip:blanc-ai-prod@sip.vapi.ai"
```

Ключевая идея:

- `assistantId` намеренно пустой;
- Blanc runtime resolver решает, какой assistant подставить на этот конкретный звонок.

## 7.3. Почему так лучше, чем фиксированный assistantId

Если зашить `assistantId` прямо в SIP resource, то:

- одна и та же нода перестает быть truly reusable;
- сложнее подменять profile по группе, языку, времени суток, бренду;
- сложнее делать controlled rollout версий ассистента.

Поэтому для Blanc правильнее иметь:

- один shared SIP ingress;
- динамический runtime-resolve ассистента.

---

# 8. Runtime resolver в Blanc

## 8.1. Назначение

Blanc должен поднять endpoint, который Vapi вызывает на событии `assistant-request`.

Этот endpoint отвечает за выбор:

- `assistantId`, если звонок должен идти в AI;
- `assistant`, если нужен transient runtime assistant;
- `destination`, если AI нужно пропустить и сразу перевести звонок.

## 8.2. Критичное ограничение по времени

Ответ на `assistant-request` должен быть **очень быстрым**.

Практическое правило:

- никаких тяжелых SQL-джойнов;
- никаких медленных внешних API;
- никаких зависимостей от нестабильных сервисов;
- profile mapping должен быть уже заранее подготовлен в памяти, кеше или очень быстрой таблице.

## 8.3. Что resolver должен получать из звонка

Основной источник истины — это runtime-контекст, который Blanc уже знает в момент входа в ноду.

Resolver должен уметь собрать:

```yaml
assistant_request_resolution_inputs:
  environment: prod
  company_id: abc_homes
  group_id: grp_001
  flow_id: flow_inbound_main
  node_id: node_vapi_greeting_01
  called_number: "+16175550123"
  caller_number: "+15085550111"
  language_hint: en
  after_ai_policy: resume_flow
  transfer_targets:
    dispatcher: "+16175550999"
    voicemail: "sip:vm-prod@pbx.example.com"
  assistant_profile_id: greeting_only_v1
```

## 8.4. Что resolver должен вернуть на Stage 1

Самый надежный вариант:

```json
{ "assistantId": "asst_prod_greeting_only_v1" }
```

Альтернативно, если нужен runtime-specific transient assistant:

```json
{
  "assistant": {
    "firstMessage": "Hello, thank you for calling ABC Homes Appliance Repair.",
    "model": {
      "provider": "openai",
      "model": "gpt-4o",
      "messages": [
        {
          "role": "system",
          "content": "You are the greeting assistant for ABC Homes Appliance Repair. Keep the greeting brief and professional."
        }
      ]
    }
  }
}
```

## 8.5. Когда разрешено вернуть destination вместо assistant

Например:

- группа выключила AI-ноду;
- сейчас after-hours и надо сразу в voicemail;
- runtime validation не прошла;
- AI degraded mode.

Тогда можно вернуть `destination` и вообще не запускать AI.

---

# 9. Как Twilio должен подключать Vapi как ноду

## 9.1. Общий принцип

Когда flow доходит до `Vapi Agent`, Blanc не должен “переводить ownership номера в Vapi”.

Вместо этого Blanc возвращает TwiML, которая **из активного звонка** отправляет вызов на SIP endpoint Vapi.

Основной примитив здесь — `Twilio <Dial><Sip>`.

## 9.2. Почему именно `<Dial><Sip>`

Потому что это дает 3 ключевых преимущества:

1. **Vapi становится обычной нодой в середине flow**, а не отдельной телефонной системой.
2. **Twilio сохраняет родительский вызов** и может вернуть управление обратно в Blanc после завершения SIP leg.
3. **В SIP URI можно передавать runtime metadata через `x-` headers**.

## 9.3. Что передавать в SIP headers

Через `x-` headers нужно передавать только то, что реально нужно на runtime-резолве.

Рекомендуемый минимум:

```yaml
sip_headers_to_vapi:
  x-blanc-company-id: "abc_homes"
  x-blanc-group-id: "grp_001"
  x-blanc-flow-id: "flow_inbound_main"
  x-blanc-node-id: "node_vapi_greeting_01"
  x-blanc-called-number: "+16175550123"
  x-blanc-language-hint: "en"
  x-blanc-assistant-profile: "greeting_only_v1"
  x-blanc-after-ai-policy: "resume_flow"
```

**Не передавать** туда все подряд. SIP headers — это transport metadata, а не бесконечный data bag.

## 9.4. Ограничения на headers

Практическое правило для ноды:

- headers должны быть короткими;
- не пихать transcript и большие JSON blobs;
- использовать short ids;
- длинные структуры хранить в Blanc cache и передавать только reference key.

Правильный вариант:

```yaml
header_strategy:
  use_short_ids: true
  send_runtime_context_key: true
  runtime_context_key_example: "ctx_01HV9Q9R4KQK6P"
  fetch_full_context_in_resolver: true
```

---

# 10. Как вернуть управление в Blanc после разговора агента

Это один из самых важных архитектурных моментов.

## 10.1. Базовый способ возврата

Twilio должен вызывать Vapi через `<Dial>` с `action` callback URL.

Когда SIP leg завершится, Twilio пришлет callback в Blanc, и Blanc решит:

- продолжить flow;
- пойти в fallback branch;
- завершить вызов;
- проиграть следующий шаг.

## 10.2. Рекомендуемая модель

```yaml
post_vapi_control:
  transport_owner: twilio
  callback_owner: blanc
  callback_type: dial_action
  result_router: blanc_flow_engine
```

## 10.3. Логика обработки результата

Например:

```yaml
dial_action_routing:
  if_dial_status_completed: "resume_flow_next_edge"
  if_dial_status_failed: "fallback_branch"
  if_dial_status_no_answer: "fallback_branch"
  if_dial_status_busy: "fallback_branch"
  if_parent_caller_hangup: "end"
```

Важно: `completed` в этом контексте означает, что SIP leg был установлен и завершился нормально, а не то, что лид уже квалифицирован.

## 10.4. Когда использовать прямой transfer вместо возврата в flow

Это уже не Stage 1 default path.

Но позже, если AI по ходу разговора должен отправить звонок дальше, Vapi может использовать:

- `transferCall` к phone number;
- `transferCall` к SIP destination;
- dynamic transfer через `transfer-destination-request`.

То есть есть два разных механизма:

1. **возврат управления в Blanc после завершения AI leg**;
2. **непосредственный live transfer из Vapi во время разговора**.

На Stage 1 основным должен быть **вариант 1**.

---

# 11. Рекомендуемая TwiML для ноды

## 11.1. Шаблон ответа от Blanc в момент входа в Vapi Agent Node

```xml
<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Dial action="https://blanc.example.com/api/twilio/vapi-agent-action?flowId=flow_inbound_main&amp;nodeId=node_vapi_greeting_01&amp;groupId=grp_001" method="POST" answerOnBridge="true">
    <Sip>
      sip:blanc-ai-prod@sip.vapi.ai?x-blanc-company-id=abc_homes&amp;x-blanc-group-id=grp_001&amp;x-blanc-flow-id=flow_inbound_main&amp;x-blanc-node-id=node_vapi_greeting_01&amp;x-blanc-called-number=%2B16175550123&amp;x-blanc-language-hint=en&amp;x-blanc-assistant-profile=greeting_only_v1&amp;x-blanc-after-ai-policy=resume_flow
    </Sip>
  </Dial>
</Response>
```

## 11.2. Что здесь важно

- `action` обязателен, если ты хочешь, чтобы Blanc **явно** получил управление после завершения SIP leg.
- `answerOnBridge="true"` обычно правильнее для этого кейса, чтобы caller не считался окончательно отвеченным до момента bridge.
- все runtime ids должны быть короткими и нормализованными.

## 11.3. Серверный шаблон построения TwiML

```yaml
twiml_builder_inputs:
  sip_uri: "sip:blanc-ai-prod@sip.vapi.ai"
  action_url: "/api/twilio/vapi-agent-action"
  action_query:
    flowId: "flow_inbound_main"
    nodeId: "node_vapi_greeting_01"
    groupId: "grp_001"
  sip_headers:
    x-blanc-company-id: "abc_homes"
    x-blanc-group-id: "grp_001"
    x-blanc-flow-id: "flow_inbound_main"
    x-blanc-node-id: "node_vapi_greeting_01"
    x-blanc-called-number: "+16175550123"
    x-blanc-language-hint: "en"
    x-blanc-assistant-profile: "greeting_only_v1"
    x-blanc-after-ai-policy: "resume_flow"
```

---

# 12. Blanc backend endpoints, которые нужны для Stage 1

## 12.1. Endpoint 1 — Twilio inbound webhook

Назначение:

- принять входящий звонок;
- определить группу по номеру;
- запустить group flow;
- дойти до Vapi Agent Node.

Это у тебя уже концептуально есть.

## 12.2. Endpoint 2 — Vapi runtime resolver

Пример:

```yaml
endpoint: /api/vapi/runtime
purpose: "обработать assistant-request и вернуть assistantId / assistant / destination"
requirements:
  - "быстрый ответ"
  - "идемпотентность"
  - "tenant isolation"
  - "валидация runtime context"
```

## 12.3. Endpoint 3 — Twilio Dial action callback

Пример:

```yaml
endpoint: /api/twilio/vapi-agent-action
purpose: "получить результат завершившегося SIP leg и продолжить flow"
reads:
  - DialCallStatus
  - DialCallSid
  - DialBridged
  - flowId
  - nodeId
  - groupId
```

## 12.4. Endpoint 4 — optional Vapi status/end-of-call events

Не обязателен для Stage 1, но полезен почти сразу.

Назначение:

- получить `status-update`;
- получить `end-of-call-report`;
- сохранять transcript/recording metadata;
- готовить future analytics.

---

# 13. Vapi CLI: как его использовать в этой архитектуре

## 13.1. Роль Vapi CLI

Vapi CLI нужен для:

- входа в аккаунт;
- инициализации проекта;
- создания assistants;
- управления SIP phone numbers;
- просмотра логов;
- локальной отладки webhook forwarding.

## 13.2. Основные команды, которые реально нужны на Stage 1

```bash
vapi login
vapi init
vapi assistant list
vapi assistant create
vapi assistant get <assistant-id>
vapi assistant update <assistant-id>
vapi phone list
vapi phone create
vapi phone update <phone-number-id>
vapi logs list
vapi logs webhooks
vapi auth status
vapi auth switch production
```

## 13.3. Практическая роль `vapi init`

`vapi init` полезен не для самой телефонии, а для того, чтобы:

- быстро вставить Vapi в существующий репозиторий;
- получить boilerplate webhook handling;
- держать Vapi-related config рядом с кодом Blanc интеграции.

## 13.4. Локальная отладка

`vapi listen` полезен, но важно помнить:

- он **не выдает публичный URL**;
- нужен отдельный tunnel, например `ngrok`;
- в локальном режиме ты прокидываешь webhooks в локальный Blanc backend.

Рекомендуемый паттерн:

```bash
# Terminal 1
ngrok http 3000

# Terminal 2
vapi listen --forward-to localhost:3000/api/vapi/runtime
```

---

# 14. Twilio CLI: как он используется в этой архитектуре

## 14.1. Роль Twilio CLI

Twilio CLI нужен для операционного контура вокруг публичных номеров и голосовых маршрутов.

Он не заменяет Blanc flow engine, но полезен для:

- профилей по средам;
- inventory номеров;
- аудита конфигурации номера;
- обновления voice webhook;
- проверки debugger logs.

## 14.2. Команды, которые реально стоит держать в runbook

```bash
twilio login
twilio profiles:use dev
twilio phone-numbers:list
twilio phone-numbers:update <PHONE-NUMBER>
twilio debugger:logs:list --limit 20
twilio debugger:logs:list --streaming
```

## 14.3. Почему профили обязательны

Потому что у тебя должны быть разделены как минимум:

- `dev`
- `uat`
- `prod`

Иначе одна ошибка оператора легко перекинет боевой номер на тестовый endpoint.

---

# 15. Стратегия окружений

## 15.1. Общий принцип

Изоляция сред должна быть одновременно в:

- Blanc;
- Twilio;
- Vapi.

## 15.2. Минимальная схема

```yaml
environments:
  dev:
    blanc_base_url: "https://dev-blanc.example.com"
    twilio_profile: "abc-dev"
    vapi_org: "abc-dev"
    vapi_sip_uri: "sip:blanc-ai-dev@sip.vapi.ai"
    assistant_id_greeting: "asst_dev_greeting_only_v1"

  uat:
    blanc_base_url: "https://uat-blanc.example.com"
    twilio_profile: "abc-uat"
    vapi_org: "abc-uat"
    vapi_sip_uri: "sip:blanc-ai-uat@sip.vapi.ai"
    assistant_id_greeting: "asst_uat_greeting_only_v1"

  prod:
    blanc_base_url: "https://blanc.example.com"
    twilio_profile: "abc-prod"
    vapi_org: "abc-prod"
    vapi_sip_uri: "sip:blanc-ai-prod@sip.vapi.ai"
    assistant_id_greeting: "asst_prod_greeting_only_v1"
```

## 15.3. Предпочтительная изоляция Twilio

Лучше всего:

- отдельный subaccount под каждую среду;
- отдельные номера;
- отдельные CLI profiles.

---

# 16. Repo / config-as-code структура

```text
voice-agent/
  docs/
    vapi_stage1_squad_inbound_twilio_spec.md
    runbook_vapi_cli.md
    runbook_twilio_cli.md
    runbook_vapi_agent_node.md
    runbook_incident_vapi_sip.md

  config/
    environments/
      dev.yaml
      uat.yaml
      prod.yaml

    blanc/
      nodes/
        vapi_agent.schema.yaml
        vapi_agent.defaults.yaml
      flows/
        examples/
          inbound_group_flow_with_vapi_node.yaml

    vapi/
      assistants/
        greeting_only_v1.yaml
      sip_ingress/
        dev.yaml
        uat.yaml
        prod.yaml

    twilio/
      profiles/
        dev.example.yaml
        uat.example.yaml
        prod.example.yaml
      numbers/
        public_did_inventory.yaml

  services/
    blanc-call-runtime/
      src/
        handlers/
          twilioInbound.ts
          twilioVapiAgentAction.ts
          vapiAssistantRequest.ts
          vapiStatusUpdate.ts
        lib/
          buildVapiSipTwiml.ts
          resolveAssistantForCall.ts
          flowResumeRouter.ts

  scripts/
    vapi/
      create-assistant.sh
      update-assistant.sh
      create-sip-ingress.sh
    twilio/
      list-numbers.sh
      update-voice-url.sh
      tail-debugger.sh
```

---

# 17. Минимальный assistant для Stage 1

На первом этапе не нужно строить гигантский prompt.

Правильнее иметь узкий assistant:

```yaml
assistant_profile:
  name: greeting_only_v1
  purpose: "коротко ответить на вызов и произнести controlled greeting"
  rules:
    - "не обещать booking"
    - "не собирать длинную квалификацию"
    - "не импровизировать с ценами и условиями"
    - "если нет дальнейшей инструкции, завершить по короткому сценарию"
```

Пример стартового system intent:

```text
You are the inbound greeting assistant for an appliance repair company.
Your only job in Stage 1 is to greet the caller briefly and professionally.
Do not attempt full troubleshooting, scheduling, pricing, or qualification unless explicitly instructed by tools or follow-up stages.
Keep the greeting concise, natural, and business-like.
```

Пример `firstMessage`:

```text
Hello, thank you for calling ABC Homes Appliance Repair. How can I help you today?
```

Если захочешь, на следующем шаге можно сделать отдельный stage2-документ уже для `area / unit / issue` extraction.

---

# 18. Пошаговый план внедрения Stage 1

## Step 1 — определить контракт ноды в Blanc

Нужно формально зафиксировать:

- node inputs;
- node outputs;
- post-AI routing;
- какие поля подставляются автоматически;
- какие поля пользователь может настраивать вручную.

## Step 2 — создать persistent assistant в Vapi

Создать `greeting_only_v1` на каждую среду.

## Step 3 — создать Vapi SIP ingress

Создать по одному SIP phone number resource на среду.

Требования:

- `sipUri` фиксирован на среду;
- `assistantId = null`;
- `serverUrl` указывает на Blanc runtime resolver.

## Step 4 — реализовать `/api/vapi/runtime`

Этот endpoint должен:

- валидировать контекст;
- находить profile ассистента;
- быстро возвращать `assistantId`.

## Step 5 — реализовать TwiML builder для ноды

Flow engine в Blanc должен уметь вернуть `<Dial><Sip>` TwiML с:

- нужным `action` callback;
- нужным SIP URI;
- нужными `x-` headers.

## Step 6 — реализовать `/api/twilio/vapi-agent-action`

Этот endpoint должен:

- анализировать `DialCallStatus`;
- обновлять execution state flow;
- продолжать flow по нужной ветке.

## Step 7 — добавить Vapi Agent Node в flow editor

UI и backend должны считать эту ноду стандартным типом шага.

## Step 8 — подключить CLI runbooks

Подготовить:

- Vapi CLI runbook;
- Twilio CLI runbook;
- incident runbook на случай падения SIP маршрута.

## Step 9 — локальное тестирование

Проверить:

- `ngrok` + `vapi listen`;
- test inbound through Twilio sandbox/test number;
- action callback;
- resume flow.

## Step 10 — UAT и production rollout

Сначала:

- одна тестовая группа;
- один тестовый branch;
- минимальный greeting-only scenario.

Потом масштабировать на остальные группы.

---

# 19. Acceptance criteria для Stage 1

```yaml
acceptance_criteria:
  - "Любой входящий звонок на номер группы по-прежнему попадает в flow своей группы в Blanc"
  - "В flow можно вставить Vapi Agent Node без ручной привязки публичного номера в Vapi"
  - "Нода строит Twilio <Dial><Sip> и отправляет звонок на Vapi SIP URI"
  - "Blanc runtime resolver получает assistant-request и возвращает assistantId меньше чем за SLA окна"
  - "Vapi assistant отвечает controlled greeting"
  - "После завершения SIP leg Twilio вызывает action callback в Blanc"
  - "Blanc продолжает flow по result-based routing"
  - "Есть отдельные dev/uat/prod конфиги"
  - "Есть Vapi CLI и Twilio CLI runbooks"
```

---

# 20. Failure modes и как их проектно закрыть

## 20.1. Медленный assistant-request

Риск:

- Vapi не дождется ответа runtime resolver.

Защита:

- кэш профилей;
- короткие lookup path;
- отсутствие тяжелых зависимостей;
- отдельный быстрый runtime service.

## 20.2. Неправильные SIP headers

Риск:

- resolver не поймет, какую группу/ветку обрабатывать.

Защита:

- строгая schema validation;
- versioned header names;
- runtime context key как fallback.

## 20.3. Нет управления после завершения AI leg

Риск:

- flow не продолжится.

Защита:

- обязательный `action` callback на `<Dial>`;
- unit/integration tests на post-AI routing.

## 20.4. Config drift между средами

Риск:

- dev/uat/prod ведут себя по-разному.

Защита:

- config-as-code;
- CLI runbooks;
- отдельные профили/организации/номера.

## 20.5. Попытка использовать Vapi как владельца публичной телефонии группы

Риск:

- дублирование routing logic;
- потеря контроля flow в Blanc;
- лишняя сложность.

Защита:

- публичные номера группы остаются в Twilio/Blanc;
- Vapi используется только как AI execution node.

---

# 21. Что делать на Stage 2

После того как Stage 1 стабильно работает, следующий шаг должен быть таким:

```yaml
stage_2:
  objective: "добавить controlled qualification после greeting"
  extraction:
    - area
    - unit
    - issue
  recommended_shape:
    - "entry assistant"
    - "handoff to qualifier assistant OR qualifier logic in same assistant"
  outputs_to_blanc:
    - is_target_lead
    - area
    - unit
    - issue
    - confidence
```

Только после этого имеет смысл переходить к:

- appointment scheduling;
- calendar checks;
- transfer to human dispatch;
- squad-level orchestration.

---

# 22. Финальное архитектурное решение Stage 1

```yaml
final_decision:
  public_numbers_owner: "Twilio / Blanc"
  group_flow_owner: "Blanc"
  ai_execution_owner: "Vapi"
  transport_from_flow_to_ai: "Twilio <Dial><Sip>"
  vapi_ingress_type: "SIP phone number resource"
  vapi_runtime_resolution: "assistant-request -> Blanc resolver"
  stage_1_entry_object: "assistant"
  squads_usage_now: "not required at ingress"
  squads_usage_later: "allowed via handoff or dedicated static squad ingress"
  post_ai_control: "Twilio Dial action callback -> Blanc flow router"
```

Итоговая формула интеграции:

**Не `Vapi owns inbound numbers`, а `Blanc owns the call flow, Vapi is a pluggable AI node inside it`.**
