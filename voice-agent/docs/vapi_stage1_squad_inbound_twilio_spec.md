---
document:
  title: "Blanc Vapi Agent Node via Twilio SIP"
  version: "3.0"
  last_updated: "2026-03-10"
  language: "ru"
  format: "YAML + Markdown"
  owner: "Robert"
  status: "ready-for-implementation"
  scope: "Stage 1 foundation + Node/UI spec"
  objective: "Сделать VAPI AI Agent переиспользуемой нодой в редакторе call flow Blanc, чтобы её можно было вставлять в SCXML-граф входящего звонка и запускать AI-разговор через Twilio SIP без переноса ownership публичных номеров из Twilio/Blanc в Vapi."
  key_decisions:
    runtime_owner: "Blanc"
    pstn_ingress_owner: "Twilio"
    ai_runtime: "Vapi"
    transport: "Twilio <Dial><Sip> -> Vapi SIP URI"
    entry_runtime_mode: "assistant-first dynamic resolution"
    resource_strategy:
      tenant_level:
        - "1 Vapi provider connection per tenant per environment"
        - "1 Vapi SIP phone-number ingress per tenant per environment"
        - "1 serverUrl binding for assistant-request per tenant per environment"
        - "optional base assistant profile(s) per tenant"
      node_level:
        - "Flow node references tenant-level Vapi connection"
        - "Flow node defines runtime behavior, greeting profile, post-agent routing and variable mapping"
    non_goals:
      - "полная квалификация лида"
      - "appointment scheduling"
      - "multi-assistant orchestration как обязательная часть Stage 1"
      - "owning all inbound DIDs inside Vapi"
  architecture:
    inbound_path: "Caller -> Twilio DID -> Blanc inbound webhook -> Blanc SCXML flow -> Vapi Agent Node -> Twilio <Dial><Sip> -> Vapi SIP ingress -> Blanc assistant-request resolver -> Vapi assistant -> Twilio action callback -> Blanc continues flow"
    why_not_vapi_owned_numbers:
      - "У одной группы может быть несколько DID, и все они уже привязаны к одному group flow в Blanc."
      - "Если перенести inbound ownership в Vapi, Blanc потеряет контроль над базовой маршрутизацией групп."
      - "SIP bridge позволяет использовать Vapi как ноду, а не как отдельную телефонную платформу."
  deliverables:
    - "Новый kind ноды: vapi_agent"
    - "Node config schema"
    - "Tenant-level UI flow подключения Vapi"
    - "SCXML insertion pattern"
    - "Runtime event contract"
    - "Fallback / observability / security requirements"
---

# 1. Главная идея

`Vapi Agent` в Blanc — это **не отдельный телефонный номер** и **не CLI-объект**, а **Flow Node Kind**, который можно вставить в редактор call flow между существующими состояниями.

То есть цель такая:

- номер по-прежнему приходит в Twilio;
- Blanc по номеру определяет группу и запускает её SCXML flow;
- в графе есть нода `Vapi Agent`;
- когда выполнение доходит до этой ноды, Blanc даёт Twilio команду отправить звонок в Vapi по SIP;
- Vapi поднимает AI-ассистента;
- после завершения AI-шага Blanc получает callback и продолжает flow по transition rules.

Это правильная модель, потому что она сохраняет:

- текущую модель `Group -> [1..N numbers] -> Flow`;
- существующий редактор call flow;
- контроль над branch-логикой в Blanc;
- возможность использовать Vapi только там, где нода реально нужна.

---

# 2. Прямой ответ на твой вопрос про номер телефона

## 2.1. Нужно ли задавать конкретный публичный номер в Vapi?

**Нет.**

Публичные входящие номера группы должны остаться в Twilio/Blanc.

Пример:

```yaml
groups:
  sales_boston:
    dids:
      - "+16170000001"
      - "+16170000002"
    flow_id: "flow_sales_boston"

  service_ri:
    dids:
      - "+14010000001"
    flow_id: "flow_service_ri"
```

Оба DID группы продолжают входить в один и тот же flow, и только внутри flow может быть вставлена нода `Vapi Agent`.

## 2.2. Нужен ли вообще Vapi phone-number resource?

**Да, но не как публичный DID.**

Нужен **SIP ingress resource** в Vapi, у которого есть `sipUri`. Именно на него Twilio будет отправлять активный call leg через `<Dial><Sip>`. Vapi docs для SIP прямо описывают SIP phone number resource и режим `assistantId = null + serverUrl`, когда ассистент выбирается динамически на каждый звонок. citeturn0search0turn1search1turn1search7

Правильная единица здесь — не "номер клиента", а:

```yaml
vapi_connection:
  tenant_id: "tenant_abc"
  environment: "prod"
  sip_ingress_uri: "sip:tenant-abc-prod@sip.vapi.ai"
```

---

# 3. Что именно должно появиться в Blanc

Нужно добавить **новый node kind**:

```yaml
blanc_node_kind:
  id: "vapi_agent"
  category: "ai"
  label: "VAPI AI Agent"
  runtime_type: "bridge"
  terminal: false
  supports_insert_between: true
  supports_branching: true
```

## 3.1. Смысл ноды

Нода:

- получает runtime context текущего звонка;
- выбирает tenant-level Vapi connection;
- формирует SIP dial leg из Twilio в Vapi;
- передаёт контекст группы и звонка;
- ожидает завершения AI leg;
- переводит исполнение flow на одну из исходящих transition.

---

# 4. Где эта нода может стоять в SCXML

На твоём skeleton v2 нода должна поддерживать вставку **между states** на insertable edges.

Для примера: если ты хочешь, чтобы в рабочие часы звонок сначала попадал к AI, а уже потом в группу операторов, то ветка `Business Hours` меняется так:

```xml
<state
  id="sk-hours-check"
  blanc:kind="branch"
  blanc:label="Hours Check"
  blanc:system="true"
  blanc:immutable="true"
  blanc:deletable="false"
>
  <transition
    cond="isBusinessHours === true"
    target="node-vapi-agent-1"
    blanc:system="true"
    blanc:immutable="true"
    blanc:deletable="false"
    blanc:edgeLabel="Business Hours"
    blanc:branchKey="business_hours"
    blanc:insertable="true"
    blanc:insertMode="between"
  />

  <transition
    cond="isBusinessHours === false"
    target="sk-vm-after-hours"
    blanc:system="true"
    blanc:immutable="true"
    blanc:deletable="false"
    blanc:edgeLabel="After Hours"
    blanc:branchKey="after_hours"
    blanc:insertable="true"
    blanc:insertMode="between"
  />
</state>

<state
  id="node-vapi-agent-1"
  blanc:kind="vapi_agent"
  blanc:label="AI Greeting"
  blanc:provider="vapi"
  blanc:configRef="call_flow_node_configs/node-vapi-agent-1"
>
  <transition event="vapi.completed" target="sk-current-group" blanc:edgeRole="success" blanc:edgeLabel="Continue" />
  <transition event="vapi.transferred" target="sk-done-routed" blanc:edgeRole="success" blanc:hidden="true" />
  <transition event="vapi.no_target vapi.failed vapi.timeout" target="sk-vm-business-hours" blanc:edgeRole="fallback" blanc:edgeLabel="Fallback" />
</state>
```

То есть нода должна работать как обычный state со своими runtime events.

---

# 5. Какие конфигурации должны быть указаны в ноде

Ниже — **обязательная** конфигурационная модель ноды.

## 5.1. Минимальный Node Config Schema

```yaml
vapi_agent_node_config:
  provider_connection_id: "vapi_conn_tenant_abc_prod"
  enabled: true
  mode: "bridge"

  assistant_resolution:
    strategy: "dynamic_assistant_request"
    assistant_profile_id: "lead_greeter_v1"
    allow_transient_assistant: true
    static_assistant_id: null
    static_squad_id: null

  call_behavior:
    answer_strategy: "answer_on_bridge"
    max_duration_seconds: 180
    end_call_on_node_completion: false
    allow_barge_in: true
    timeout_seconds: 45

  greeting:
    first_message_mode: "exact"
    first_message_text: "Thank you for calling ABC Homes. How can I help you today?"
    locale: "en-US"
    voice_profile_id: "default_en_us_voice"

  context_mapping:
    include_called_number: true
    include_caller_number: true
    include_group_id: true
    include_group_name: true
    include_business_hours_flag: true
    include_flow_id: true
    include_node_id: true
    include_transfer_targets: true
    include_custom_vars:
      - key: "brand_name"
        value_expr: "tenant.brand_name"
      - key: "service_area_summary"
        value_expr: "group.service_area_summary"

  post_agent_routing:
    on_completed: "continue_to_next_node"
    on_transferred: "mark_done"
    on_failed: "fallback_transition"
    on_timeout: "fallback_transition"
    on_no_target: "fallback_transition"
    fallback_target_mode: "graph_transition"

  transfer_policy:
    allow_transfer_from_assistant: true
    allowed_destinations_source: "group_runtime_targets"
    allow_return_control_to_blanc: true

  observability:
    store_transcript: true
    store_summary: true
    store_recording_reference: true
    emit_timeline_events: true
    debug_mode: false

  security:
    require_signed_callbacks: true
    mask_sensitive_headers: true
    tenant_scope_enforced: true
```

## 5.2. Что означает каждый блок

### `provider_connection_id`
Ссылка на tenant-level подключение к Vapi. Нода **не должна** хранить API key внутри себя.

### `assistant_resolution`
Определяет, как выбрать runtime-ассистента:
- `dynamic_assistant_request` — рекомендуемый режим;
- `static_assistant_id` — допустимый fallback/упрощённый режим;
- `static_squad_id` — можно оставить как future-ready, но не делать основным для Stage 1.

Vapi server events docs подтверждают, что `assistant-request` может вернуть `assistantId`, transient `assistant`, `squadId`, `squad` или `destination`, а если вернётся `destination`, то assistant/squad игнорируются. Ответ надо дать в пределах примерно 7.5 секунд. citeturn1search2turn0search2turn0search5

### `call_behavior`
Управляет тем, как Twilio/Vapi должны вести себя как bridge leg. Для входящего звонка через `<Dial>` у Twilio есть `answerOnBridge`, и если `<Dial>` стоит первым verb, входящий абонент слышит ringing до момента ответа на другом конце. citeturn2search0turn2search1

### `greeting`
Stage 1 должен быть максимально контролируемым. Поэтому тут лучше поддержать `first_message_mode = exact`, а не свободную генерацию для первого приветствия.

### `context_mapping`
Определяет, какие данные Blanc должен передавать в Vapi через SIP headers и/или server-side resolver.

### `post_agent_routing`
Самый важный блок для flow editor. Именно он решает, какая transition будет использована после завершения AI leg.

### `transfer_policy`
Определяет, может ли ассистент инициировать перевод, и откуда брать разрешённые destinations.

### `observability`
Без этого внедрение AI в телефонию быстро становится неуправляемым.

---

# 6. Какие поля должны быть видны в UI ноды

В inspector panel для `Vapi Agent` рекомендую сделать такие секции.

## 6.1. Section: General

```yaml
fields:
  - key: label
    type: text
    required: true
  - key: enabled
    type: toggle
    default: true
  - key: description
    type: textarea
    required: false
```

## 6.2. Section: Provider

```yaml
fields:
  - key: provider_connection_id
    type: select
    source: tenant_vapi_connections
    required: true
  - key: assistant_profile_id
    type: select
    source: tenant_vapi_assistant_profiles
    required: true
  - key: assistant_resolution.strategy
    type: select
    options:
      - dynamic_assistant_request
      - static_assistant
      - static_squad
    default: dynamic_assistant_request
```

## 6.3. Section: Greeting

```yaml
fields:
  - key: greeting.first_message_mode
    type: select
    options: [exact, prompt_template]
    default: exact
  - key: greeting.first_message_text
    type: textarea
    required_if:
      greeting.first_message_mode: exact
  - key: greeting.locale
    type: select
    options: [en-US, es-US]
    default: en-US
  - key: greeting.voice_profile_id
    type: select
    source: tenant_vapi_voice_profiles
```

## 6.4. Section: Call Routing

```yaml
fields:
  - key: post_agent_routing.on_completed
    type: select
    options:
      - continue_to_next_node
      - transfer_to_group_queue
      - transfer_to_number
      - go_to_voicemail
      - end_flow
    default: continue_to_next_node

  - key: post_agent_routing.on_failed
    type: select
    options:
      - fallback_transition
      - transfer_to_group_queue
      - go_to_voicemail
      - end_flow

  - key: transfer_policy.allow_transfer_from_assistant
    type: toggle
    default: true
```

## 6.5. Section: Variables / Context

```yaml
fields:
  - key: context_mapping.include_group_name
    type: toggle
    default: true
  - key: context_mapping.include_called_number
    type: toggle
    default: true
  - key: context_mapping.include_transfer_targets
    type: toggle
    default: true
  - key: context_mapping.custom_vars
    type: key_value_expression_list
```

## 6.6. Section: Reliability

```yaml
fields:
  - key: call_behavior.timeout_seconds
    type: number
    default: 45
  - key: call_behavior.max_duration_seconds
    type: number
    default: 180
  - key: observability.debug_mode
    type: toggle
    default: false
```

---

# 7. Какие ресурсы должны создаваться на tenant-level через UI

Ты предложил правильное место:

`http://localhost:3001/settings/telephony/provider-settings`

Туда надо добавить отдельный блок:

```yaml
settings_block:
  id: "vapi_ai"
  title: "VAPI AI"
  cta_label: "Подключить VAPI AI"
  visibility: "tenant_admin_only"
```

## 7.1. Что должно происходить после нажатия кнопки

Не просто "сохранить API key", а пройти **provisioning flow**.

### Шаг 1. Создать provider connection record в Blanc

```yaml
provider_connection:
  id: "vapi_conn_tenant_abc_prod"
  tenant_id: "tenant_abc"
  provider: "vapi"
  environment: "prod"
  status: "connecting"
```

### Шаг 2. Запросить и сохранить Vapi credentials

Минимум:

```yaml
credentials:
  private_api_key: "encrypted"
  public_api_key: "optional"
```

### Шаг 3. Создать или зарегистрировать Vapi SIP ingress для tenant

Рекомендуемая стратегия Stage 1:

- **один SIP ingress на tenant + environment**;
- не делать отдельный SIP resource на каждую ноду;
- не делать отдельный SIP resource на каждый DID;
- не делать отдельный SIP resource на каждый group flow.

```yaml
tenant_vapi_ingress:
  tenant_id: "tenant_abc"
  environment: "prod"
  phone_number_resource_id: "vapi_phone_xxx"
  sip_uri: "sip:tenant-abc-prod@sip.vapi.ai"
```

### Шаг 4. Прописать `serverUrl` для assistant-request

На стороне Blanc должен существовать endpoint вида:

```yaml
server_url:
  assistant_request: "https://api.blanc.app/v1/telephony/vapi/assistant-request"
```

Vapi docs прямо указывают, что server URL можно вешать на phone number и использовать для `assistant-request`. citeturn0search4turn0search15turn1search1

### Шаг 5. Создать базовый assistant profile namespace

Даже если Stage 1 ограничен greeting-only, tenant-level integration должен иметь хотя бы один профиль:

```yaml
assistant_profile:
  id: "lead_greeter_v1"
  tenant_id: "tenant_abc"
  provider_connection_id: "vapi_conn_tenant_abc_prod"
  purpose: "entry_greeting"
```

### Шаг 6. Выполнить smoke test

UI должен уметь нажать `Test Connection` и проверить:
- credentials валидны;
- SIP ingress существует;
- serverUrl reachable;
- assistant-request signing/authorization работает;
- базовый assistant profile доступен.

### Шаг 7. Перевести connection в active

```yaml
provider_connection:
  status: "active"
```

---

# 8. Что должно храниться в базе Blanc

## 8.1. Таблица provider_connections

```yaml
provider_connections:
  - id
  - tenant_id
  - provider
  - environment
  - status
  - encrypted_credentials_json
  - created_at
  - updated_at
```

## 8.2. Таблица vapi_tenant_resources

```yaml
vapi_tenant_resources:
  - id
  - tenant_id
  - provider_connection_id
  - environment
  - vapi_phone_number_id
  - sip_uri
  - server_url
  - assistant_request_secret
  - is_active
  - created_at
  - updated_at
```

## 8.3. Таблица vapi_assistant_profiles

```yaml
vapi_assistant_profiles:
  - id
  - tenant_id
  - provider_connection_id
  - slug
  - purpose
  - base_config_json
  - version
  - is_active
  - created_at
  - updated_at
```

## 8.4. Таблица call_flow_node_configs

```yaml
call_flow_node_configs:
  - id
  - tenant_id
  - flow_id
  - node_id
  - node_kind
  - config_json
  - version
  - is_active
  - created_at
  - updated_at
```

## 8.5. Таблица call_ai_runs

```yaml
call_ai_runs:
  - id
  - tenant_id
  - call_id
  - flow_id
  - node_id
  - provider
  - provider_connection_id
  - provider_call_id
  - provider_assistant_id
  - status
  - started_at
  - ended_at
  - transcript_ref
  - summary_ref
  - recording_ref
  - metadata_json
```

---

# 9. Как должен работать runtime ноды

## 9.1. Шаги runtime

```yaml
runtime_sequence:
  - "Blanc executes current SCXML state = vapi_agent"
  - "Blanc loads node config"
  - "Blanc resolves provider_connection_id for tenant/environment"
  - "Blanc builds runtime context packet"
  - "Blanc returns TwiML with <Dial><Sip> to Vapi SIP ingress"
  - "Twilio initiates child leg to SIP URI"
  - "Vapi receives SIP INVITE"
  - "Vapi calls Blanc serverUrl with assistant-request"
  - "Blanc resolves runtime assistant configuration"
  - "Vapi runs assistant"
  - "assistant ends call leg or transfers"
  - "Twilio posts action callback to Blanc"
  - "Blanc emits vapi.completed / vapi.failed / vapi.transferred / vapi.timeout"
  - "SCXML engine follows transition"
```

## 9.2. Почему тут нужен `assistant-request`

Потому что одна и та же tenant-level SIP ingress точка должна уметь обслуживать:
- разные группы;
- разные flows;
- разные ноды;
- разные greeting profiles.

Это лучше решать на runtime, а не создавать отдельный Vapi resource на каждую комбинацию.

---

# 10. Какие данные Blanc должен передавать в Vapi

Минимальный runtime payload:

```yaml
runtime_context:
  tenant:
    id: "tenant_abc"
    company_name: "ABC Homes"
  group:
    id: "group_current"
    name: "Current Group"
  flow:
    id: "flow_123"
    node_id: "node-vapi-agent-1"
  call:
    blanc_call_id: "call_123"
    from: "+15085551212"
    to: "+16175550000"
    direction: "inbound"
    is_business_hours: true
  routing:
    transfer_targets:
      - type: "group_queue"
        group_ref: "group.current"
      - type: "number"
        value: "+16175550111"
  profile:
    assistant_profile_id: "lead_greeter_v1"
```

## 10.1. Через что передавать эти данные

Практически нужно поддержать **два канала** одновременно:

1. **SIP headers** — для быстрой корреляции на SIP leg;
2. **server-side lookup** — по call correlation id.

Twilio поддерживает передачу SIP URI headers через `<Sip>`, а `X-` headers может прокидывать в callback/runtime context. citeturn0search3turn2search4turn2search11

Рекомендуемые `X-headers`:

```yaml
sip_headers:
  X-Blanc-Tenant-Id: "tenant_abc"
  X-Blanc-Flow-Id: "flow_123"
  X-Blanc-Node-Id: "node-vapi-agent-1"
  X-Blanc-Call-Id: "call_123"
  X-Blanc-Group-Id: "group_current"
  X-Blanc-Called-Number: "+16175550000"
```

Не передавать в SIP headers ничего лишнего или чувствительного.

---

# 11. Какой TwiML должен генерировать Blanc

Базовый паттерн:

```xml
<Response>
  <Dial answerOnBridge="true" action="https://api.blanc.app/v1/telephony/twilio/vapi-action" method="POST">
    <Sip>
      sip:tenant-abc-prod@sip.vapi.ai?X-Blanc-Call-Id=call_123&amp;X-Blanc-Flow-Id=flow_123&amp;X-Blanc-Node-Id=node-vapi-agent-1
    </Sip>
  </Dial>
</Response>
```

Почему так:
- Twilio `<Dial><Sip>` умеет направить текущий звонок на SIP endpoint. citeturn0search3turn2search1
- `action` на `<Dial>` позволяет Blanc получить callback после завершения dial leg и продолжить graph execution. citeturn2search5turn2search0

---

# 12. Какие SCXML events должна эмитить нода

Нужен стабильный runtime contract.

```yaml
vapi_node_events:
  - event: "vapi.completed"
    meaning: "AI leg завершился штатно без transfer"

  - event: "vapi.transferred"
    meaning: "AI инициировал transfer / handoff / destination routing"

  - event: "vapi.timeout"
    meaning: "AI node превысила допустимое время ожидания или runtime budget"

  - event: "vapi.failed"
    meaning: "ошибка bridge/SIP/Vapi callback/runtime"

  - event: "vapi.no_target"
    meaning: "не удалось вычислить assistant/destination или node misconfigured"
```

Для редактора этого достаточно.

---

# 13. Как должна работать логика переходов после ноды

Минимально поддержать 3 режима:

## 13.1. Continue

После приветствия AI нода заканчивается и управление идёт в следующий state.

Типичный кейс:

`AI Greeting -> Current Group Queue`

## 13.2. Transfer and finish

AI сам перевёл звонок на destination, и текущий flow можно считать успешно завершённым.

Типичный кейс:

`AI Qualifier -> Human Queue -> Done`

## 13.3. Fallback

Если Vapi недоступен или resolver не сработал, управление идёт по fallback edge:

`Vapi Agent -> Voicemail` или `Vapi Agent -> Current Group Queue`

---

# 14. Как должна работать кнопка “Подключить VAPI AI” в UI

## 14.1. UX-логика

```yaml
ui_flow:
  step_1: "Нажать Подключить VAPI AI"
  step_2: "Ввести/подтвердить credentials"
  step_3: "Выбрать environment"
  step_4: "Создать tenant-level SIP ingress"
  step_5: "Настроить Blanc serverUrl для assistant-request"
  step_6: "Создать базовый assistant profile"
  step_7: "Пройти smoke test"
  step_8: "Сохранить connection как active"
```

## 14.2. Какие поля должны быть в модалке подключения

```yaml
connect_vapi_modal:
  fields:
    - key: environment
      type: select
      options: [dev, uat, prod]
      required: true

    - key: private_api_key
      type: password
      required: true

    - key: create_sip_ingress
      type: toggle
      default: true

    - key: custom_server_url
      type: text
      required: false

    - key: default_company_name
      type: text
      default_expr: "tenant.company_name"
```

## 14.3. Что должен показать UI после успеха

```yaml
connection_summary:
  provider_connection_id: "vapi_conn_tenant_abc_prod"
  environment: "prod"
  sip_uri: "sip:tenant-abc-prod@sip.vapi.ai"
  server_url: "https://api.blanc.app/v1/telephony/vapi/assistant-request"
  status: "active"
```

---

# 15. Почему лучше делать один SIP ingress на tenant/environment, а не на каждую ноду

Потому что иначе появится ненужное разрастание сущностей:

- 20 групп
- 4 AI ноды в разных flow
- 3 среды
- десятки и сотни SIP resources без реальной пользы

Правильнее:

```yaml
resource_model:
  tenant_environment_connection:
    count: 1
  assistant_profiles:
    count: many
  flow_nodes:
    count: many
```

То есть:
- **SIP ingress общий**;
- **логика разная через resolver**;
- **flow behavior разный на уровне node config**.

---

# 16. Что делать через UI, а что через CLI

## 16.1. Через UI

Обязательно:
- подключение Vapi к tenant;
- создание tenant-level connection;
- создание/проверка SIP ingress;
- привязка node к provider connection;
- настройка greeting и routing;
- тест connection;
- просмотр базового статуса.

## 16.2. Через Vapi CLI

Полезно для devops и debugging, но не как основной продуктовый UX:
- посмотреть assistants;
- посмотреть phone numbers;
- обновить phone/server settings;
- слушать webhooks локально;
- отлаживать проект локально. Vapi CLI docs прямо позиционируют CLI как инструмент для управления assistants, phone numbers, calls, logs, webhooks и local development. citeturn1search4turn0search7

Итог: **продуктовый путь должен быть через UI**, CLI — для инженерной эксплуатации.

---

# 17. Обязательные разделы, которые легко упустить

## 17.1. Корреляция вызовов

Нужен явный `blanc_call_id`, который проходит через:
- incoming Twilio webhook;
- SCXML runtime;
- SIP bridge;
- Vapi call/session correlation;
- action callback;
- timeline/events storage.

Без этого потом нельзя нормально собирать трассировку.

## 17.2. Timeout budget

Нельзя ждать Vapi resolver бесконечно. У `assistant-request` у Vapi жёсткое короткое окно ответа; если не уложиться, звонок сломается. Поэтому resolver должен быть очень лёгким и не зависеть от тяжёлых запросов. citeturn1search2turn0search5

## 17.3. Fallback без AI

Нода обязана иметь безопасный путь, если:
- Vapi не отвечает;
- resolver упал;
- конфиг ноды битый;
- SIP ingress недоступен.

## 17.4. Ограничение на transfer destinations

Нельзя позволять assistant переводить куда угодно. Нужен whitelist destinations из group runtime policy.

## 17.5. Версионирование assistant profiles

Промпты и voice-config будут меняться. Значит profile должен иметь `version`, а нода должна ссылаться либо на pinned version, либо на active alias.

## 17.6. Наблюдаемость

Минимум нужно хранить:
- node entered;
- SIP dial started;
- Vapi assistant requested;
- assistant resolved;
- AI leg ended;
- action callback received;
- emitted SCXML event.

## 17.7. Tenant isolation

Нода одной компании не должна иметь доступа к Vapi ресурсам другой. Это нужно enforce и в базе, и в resolver endpoint.

## 17.8. Test mode

Нужен способ включить тестовую ноду/flow без затрагивания production numbers.

---

# 18. Рекомендуемая минимальная реализация Stage 1

```yaml
stage_1_recommended_scope:
  tenant_settings_ui:
    - "Connect VAPI AI"
    - "Create tenant connection"
    - "Create tenant SIP ingress"
    - "Store server URL"
    - "Create one assistant profile"

  flow_editor:
    - "New node kind: vapi_agent"
    - "Inspector form for node config"
    - "Transitions for success/fallback"

  runtime:
    - "Generate <Dial><Sip> TwiML"
    - "Implement assistant-request resolver"
    - "Implement Twilio action callback"
    - "Emit SCXML events"

  storage:
    - "Persist node config"
    - "Persist provider connection"
    - "Persist AI run trace"

  fallback:
    - "If AI unavailable -> continue to queue or voicemail"
```

---

# 19. Рекомендуемый дефолт для самого первого рабочего кейса

Если цель первого рабочего кейса — просто дать AI-приветствие перед очередью группы, то дефолтная вставка должна быть такой:

```yaml
default_behavior:
  location_in_graph: "between business_hours edge and current_group"
  greeting: "Thank you for calling ABC Homes. Please hold while I connect you."
  on_completed: "continue_to_next_node"
  next_node: "sk-current-group"
  on_failed: "fallback_transition"
  fallback_target: "sk-vm-business-hours"
```

Это самый безопасный старт:
- AI не ломает общую маршрутизацию;
- AI добавляет ценность уже на первом этапе;
- дальше можно постепенно включать qualification.

---

# 20. Итоговое архитектурное решение

## Принять

```yaml
accepted_architecture:
  node_model: "Vapi Agent Node"
  public_number_owner: "Twilio/Blanc"
  ai_transport: "Twilio Dial Sip -> Vapi SIP ingress"
  resource_scope: "one Vapi connection + one SIP ingress per tenant/environment"
  runtime_selection: "assistant-request resolver in Blanc"
  editor_behavior: "insertable non-terminal node with success/fallback transitions"
```

## Не принимать

```yaml
rejected_architecture:
  - "делать Vapi CLI самостоятельной runtime-нодой"
  - "создавать отдельный публичный Vapi number на каждый group DID"
  - "создавать отдельный SIP ingress на каждую flow node"
  - "зашивать все маршруты внутрь Vapi без возврата контроля в Blanc"
```

---

# 21. Источники

- Vapi CLI
- Vapi SIP introduction
- Vapi server URL / events
- Vapi phone number update / SIP dynamic assistant resolution
- Twilio TwiML `<Dial>`
- Twilio TwiML `<Sip>`
- Twilio SIP and TwiML interaction

