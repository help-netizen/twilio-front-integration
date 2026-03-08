---
document:
  title: "VAPI Stage 1 — Inbound AI Agent on Twilio Number (Squad-first, updated with Twilio CLI)"
  version: "1.1"
  last_updated: "2026-03-07"
  language: "ru"
  format: "YAML + Markdown"
  owner: "Robert"
  status: "draft-ready"
  stage: "Stage 1"
  objective: "Развернуть входящего AI-агента на базе Vapi, который отвечает приветствием на входящий звонок, поступающий на конкретный номер в Twilio."
  primary_stack:
    telephony: "Twilio"
    ai_voice_platform: "Vapi"
    call_entry_pattern: "Twilio number imported into Vapi"
    orchestration: "Squad"
    initial_conversation_shape: "single-entry greeter assistant inside squad"
    local_testing: ["Vapi CLI", "Twilio CLI", "ngrok or equivalent tunnel"]
  architecture_decision:
    selected: "Squad-first"
    rationale:
      - "Даёт максимальный запас по управляемости conversation flow без привязки к устаревающим Workflows."
      - "Позволяет начать с одного entry-assistant, но без переезда на другую модель, когда появятся qualifier / scheduler / transfer-to-human."
      - "Позволяет держать ассистентов узкими и специализированными, вместо одного перегруженного prompt."
  non_goals_stage_1:
    - "Полная квалификация лида"
    - "Appointment scheduling logic"
    - "CRM/FSM integration"
    - "Calendar booking"
    - "Human handoff policy"
    - "Production-grade reporting and analytics"
  deliverable_of_this_stage:
    - "Twilio number принимает входящий вызов"
    - "Vapi отвечает на звонок"
    - "Запускается Squad"
    - "Первый assistant произносит контролируемое приветствие"
    - "Есть DEV/UAT/PROD контур и CLI-runbooks"
---

# 1. Что именно строим на Stage 1

На этом этапе строится **не весь лид-процесс**, а **надежный входной контур**:

`Caller -> Twilio Number -> Vapi Phone Number -> Squad -> Entry Greeter Assistant -> Greeting`

Итог Stage 1 считается успешным, если:

1. На конкретный номер в Twilio можно позвонить.
2. Входящий звонок уходит в Vapi.
3. Vapi поднимает заранее подготовленный `Squad`.
4. Первый assistant в squad отвечает приветствием.
5. Управление номером, webhook-диагностикой и аварийным переключением возможно через CLI, а не только через UI.

---

# 2. Почему здесь выбран Squad, а не single Assistant

Для твоей цели — **максимально детально контролировать сценарий разговора** — правильнее сразу закладывать **Squad-first** модель.

Практический смысл:

- На Stage 1 squad может содержать **ровно одного** `entry_greeter` assistant.
- На Stage 2 в этот же squad можно добавить `lead_qualifier`.
- На Stage 3 — `scheduler`.
- На Stage 4 — `human_transfer_router`.

То есть номер, telephony-контур, naming, среды, runbooks и testing-каркас не придётся переделывать.

**Решение:**
- использовать **Squad как верхний контейнер orchestration**;
- на Stage 1 запускать в squad только один entry-assistant;
- не использовать Workflows как базовую архитектуру;
- не строить один длинный monolithic assistant prompt на все кейсы сразу.

---

# 3. Ключевое обновление этой версии: роль Twilio CLI

В предыдущей версии Twilio рассматривался в основном как провайдер номера.

После изучения возможностей **Twilio CLI** его нужно считать отдельным операционным слоем.

## 3.1. Зачем Twilio CLI нужен в этом проекте

Twilio CLI нужен не только для “посмотреть номер”. Он покрывает 5 важных задач:

1. **Изоляция сред**
   - отдельные `profiles` под `dev / uat / prod`;
   - при необходимости отдельные Twilio subaccounts на каждую среду.

2. **Инвентаризация телефонии**
   - быстрое получение списка номеров;
   - проверка friendly name;
   - проверка того, куда сейчас указывает voice webhook.

3. **Операционное управление inbound routing**
   - обновление `voice-url` номера из CLI;
   - аварийное переключение номера на fallback endpoint;
   - временное переключение номера на диагностический voice endpoint.

4. **Диагностика продакшн-инцидентов**
   - `debugger:logs:list`;
   - `--streaming` для живого просмотра ошибок.

5. **Локальная и предрелизная отладка**
   - быстрый пересет voice webhook на tunnel URL;
   - проверка маршрута без захода в Twilio Console.

## 3.2. Как правильно использовать Twilio CLI в этой архитектуре

**Важно:** если номер импортирован в Vapi и Vapi управляет inbound voice path, то **Twilio CLI должен использоваться как операционный и диагностический инструмент**, а не как постоянный второй источник конфигурации.

То есть правило такое:

- **нормальный режим**: номер импортирован в Vapi, inbound вызовы идут через Vapi;
- **Twilio CLI используется для**:
  - аудита;
  - проверки текущего состояния;
  - локальной отладки;
  - break-glass сценариев;
  - rollback/fallback на случай проблем с Vapi или backend.

Иначе получится config drift: UI/CLI/Twilio/Vapi будут перетирать друг друга.

---

# 4. Целевая архитектура Stage 1

## 4.1. Базовый продакшн-путь

```text
Caller
  -> Twilio PSTN Number
  -> Twilio inbound voice webhook
  -> Vapi-managed phone number integration
  -> Vapi phone number config
  -> squadId = appliance_inbound_entry
  -> squad member #1 = entry_greeter
  -> entry_greeter speaks greeting
```

## 4.2. Что должно быть создано

### В Twilio
- входящий номер с voice capability;
- отдельный профиль CLI для соответствующей среды;
- при необходимости отдельный subaccount под среду.

### В Vapi
- 1 phone number resource, связанный с импортированным Twilio номером;
- 1 squad: `appliance_inbound_entry`;
- 1 assistant внутри squad: `entry_greeter`;
- при необходимости server URL, но **не обязательно** для Stage 1.

### В нашем репозитории
- YAML-конфиги окружений;
- Markdown-runbooks;
- secrets map;
- test plan;
- rollback инструкции.

---

# 5. Стратегия сред: DEV / UAT / PROD

## 5.1. Vapi

Для Vapi нужно придерживаться реальной environment isolation:

- `acme-dev`
- `acme-uat`
- `acme-prod`

## 5.2. Twilio

Рекомендуемая схема:

### Вариант A — предпочтительный
- отдельный Twilio subaccount на каждую среду;
- отдельный номер на каждую среду;
- отдельный CLI profile на каждую среду.

### Вариант B — компромиссный
- один master account;
- разные номера на разные среды;
- разные CLI profiles и строгая naming discipline.

Для production голосового агента вариант A лучше, потому что уменьшает риск случайного обновления webhook у боевого номера.

## 5.3. Naming convention

```yaml
environments:
  dev:
    twilio_profile: "abc-dev"
    twilio_account_scope: "subaccount or isolated profile"
    vapi_org: "abc-dev"
    phone_alias: "appliance-inbound-dev"
    squad_slug: "appliance_inbound_entry_dev"
    assistant_slug: "entry_greeter_dev"

  uat:
    twilio_profile: "abc-uat"
    twilio_account_scope: "subaccount or isolated profile"
    vapi_org: "abc-uat"
    phone_alias: "appliance-inbound-uat"
    squad_slug: "appliance_inbound_entry_uat"
    assistant_slug: "entry_greeter_uat"

  prod:
    twilio_profile: "abc-prod"
    twilio_account_scope: "subaccount or isolated profile"
    vapi_org: "abc-prod"
    phone_alias: "appliance-inbound-prod"
    squad_slug: "appliance_inbound_entry_prod"
    assistant_slug: "entry_greeter_prod"
```

---

# 6. Repo / config-as-code структура

```text
voice-agent/
  docs/
    vapi_stage1_squad_inbound_twilio_spec.md
    runbook_twilio_cli.md
    runbook_vapi_cli.md
    runbook_incident_inbound_voice.md

  config/
    environments/
      dev.yaml
      uat.yaml
      prod.yaml

    vapi/
      assistants/
        entry_greeter.yaml
      squads/
        appliance_inbound_entry.yaml
      phones/
        inbound_number.yaml

    twilio/
      profiles/
        dev.example.yaml
        uat.example.yaml
        prod.example.yaml
      numbers/
        inbound_number_inventory.yaml
      operations/
        fallback_voice_routes.yaml

  scripts/
    twilio/
      verify-number.sh
      set-voice-url.sh
      rollback-voice-url.sh
      tail-debugger.sh
    vapi/
      validate-config.sh
      promote-dev-to-uat.sh
      promote-uat-to-prod.sh
```

---

# 7. Twilio CLI — обязательный операционный контур

## 7.1. Установка

Согласно текущему CLI reference:

```bash
brew tap twilio/brew
brew install twilio
```

## 7.2. Базовая аутентификация

```bash
twilio login
```

или с конкретным Account SID:

```bash
twilio login ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

## 7.3. Профили

Профили — обязательны. Без этого очень легко обновить не тот номер.

Полезные команды:

```bash
twilio profiles:list
twilio profiles:use abc-dev
twilio profiles:use abc-uat
twilio profiles:use abc-prod
```

## 7.4. Рекомендуемая настройка CLI

Для дисциплины лучше включить требование явного profile при командах automation/runbook-уровня.

```bash
twilio config:set --require-profile-input
```

## 7.5. Глобальные флаги, которые реально нужны

```bash
-p, --profile
-o, --output [columns|json|tsv|none]
-l, --log-level [debug|info|warn|error|none]
--silent
```

Практически в этом проекте нужно по умолчанию использовать:

```bash
-o json
-p <profile>
```

---

# 8. Twilio CLI — команды, которые нужны именно для Stage 1

## 8.1. Посмотреть номера

```bash
twilio phone-numbers:list -p abc-dev -o json
```

Использование:
- найти нужный inbound number;
- проверить, что работаем в правильной среде;
- увидеть полный JSON, а не обрезанный columns view.

## 8.2. Обновить incoming voice webhook номера

Это ключевая команда для break-glass, локальной отладки и rollback.

```bash
twilio phone-numbers:update +1XXXXXXXXXX \
  -p abc-dev \
  --voice-url https://example.com/twilio/inbound/voice \
  --voice-method POST
```

или через SID номера:

```bash
twilio phone-numbers:update PNXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX \
  -p abc-dev \
  --voice-url https://example.com/twilio/inbound/voice \
  --voice-method POST
```

## 8.3. Проверить, что webhook реально обновлён

```bash
twilio phone-numbers:list -p abc-dev -o json
```

## 8.4. Смотреть debugger логи

```bash
twilio debugger:logs:list -p abc-dev
```

Для непрерывного просмотра:

```bash
twilio debugger:logs:list -p abc-dev --streaming
```

## 8.5. Поиск свободных номеров (если понадобится отдельный номер на среду)

```bash
twilio api:core:available-phone-numbers:local:list \
  --country-code US \
  --area-code 617 \
  -p abc-dev \
  -o json
```

## 8.6. Дополнительные полезные плагины

```bash
twilio plugins:install @twilio-labs/plugin-watch
twilio plugins:install @twilio-labs/plugin-webhook
```

Они не обязательны для запуска Stage 1, но полезны для наблюдения и эмуляции событий.

---

# 9. Важные ограничения и правила при работе через Twilio CLI

## 9.1. Никогда не используй localhost как voice-url

Twilio не примет `localhost` / `127.0.0.1` напрямую для webhook URL.

Для локальной проверки всегда нужен public tunnel:

- `ngrok`
- `cloudflared`
- другой публичный tunnel

## 9.2. Если voice-url меняется, но вызовы идут не туда

Нужно проверить, не задан ли у номера:

- `voice_application_sid`
- `trunk_sid`

Если один из них установлен, `voice_url` может игнорироваться.

## 9.3. После импорта номера в Vapi не держать два постоянных источника правды

Нельзя одновременно:
- вручную жить в Twilio Console,
- регулярно менять номер через Twilio CLI,
- параллельно управлять тем же номером через Vapi.

Нужно выбрать правило:

### Нормальный режим
- номер импортирован в Vapi;
- Vapi управляет маршрутом вызова.

### Исключения
- аварийный bypass;
- диагностика;
- локальный тестовый маршрут;
- rollback.

---

# 10. Vapi CLI — роль в этом проекте

Twilio CLI отвечает за телеком-операции.

Vapi CLI отвечает за:
- проектную инициализацию;
- управление assistant/phone ресурсами;
- локальную webhook-отладку;
- multi-account switching.

## 10.1. Установка и старт

```bash
curl -sSL https://vapi.ai/install.sh | bash
vapi login
vapi init
```

## 10.2. Базовые команды, которые нам нужны

```bash
vapi assistant list
vapi assistant create
vapi assistant get <assistant-id>
vapi assistant update <assistant-id>
vapi phone list
vapi phone update <phone-number-id>
```

## 10.3. Локальная webhook-отладка

```bash
# Terminal 1
ngrok http 4242

# Terminal 2
vapi listen --forward-to localhost:3000/webhook
```

Важно понимать:
- `vapi listen` сам по себе **не создаёт публичный URL**;
- внешний public URL должен дать tunnel-сервис;
- этот URL потом используется в настройках webhook/server URL.

---

# 11. Рекомендуемый способ запуска Stage 1

## 11.1. Продакшн-рекомендация

Для Stage 1 рекомендую **не использовать dynamic assistant resolution как основной путь**.

Причина:
- на первом этапе нам нужен не routing engine, а **предсказуемый и устойчивый inbound entrypoint**;
- dynamic path полезен позже, когда появятся tenant-level rules, office hours, geo-routing, spam screening, CRM-based personalization.

### Поэтому для Stage 1 делаем так:
1. импортируем Twilio number в Vapi;
2. создаём saved squad;
3. привязываем `squadId` к Vapi phone number;
4. первый member squad — `entry_greeter`;
5. звонок сразу стартует с этого assistant.

## 11.2. Когда включать dynamic server URL

Включать позже, когда понадобится:
- выбор squad по номеру/DID;
- per-brand routing;
- office-hours routing;
- быстрый transfer-to-human без AI;
- anti-spam / allowlist / denylist;
- персонализация greetings по caller history.

---

# 12. Stage 1 — минимальная конфигурация сущностей

## 12.1. Entry assistant

```yaml
assistant:
  slug: "entry_greeter"
  purpose: "Ответить на входящий звонок и произнести первое приветствие"
  goals:
    - "взять трубку без задержки"
    - "произнести controlled greeting"
    - "не пытаться на Stage 1 квалифицировать лида глубоко"
  allowed_actions:
    - "greet"
    - "ask how to help"
    - "hold conversation briefly"
  prohibited_actions:
    - "обещать booking"
    - "подтверждать слот в календаре"
    - "делать transfer-to-human как production policy, если это ещё не реализовано"
  first_message: "Thank you for calling. You’ve reached our appliance repair line. How can I help you today?"
  prompt_style:
    tone: "professional, calm, concise"
    interruption_handling: "polite"
    verbosity: "short"
```

## 12.2. Squad

```yaml
squad:
  slug: "appliance_inbound_entry"
  strategy: "squad-first even when only one assistant is active"
  members:
    - order: 1
      assistant_ref: "entry_greeter"
  handoff_policy:
    enabled: false
    note: "Will be introduced in Stage 2+"
```

## 12.3. Vapi phone number binding

```yaml
phone_number:
  alias: "appliance-inbound"
  provider: "byo-phone-number"
  source_provider: "Twilio"
  binding_mode: "static"
  vapi_target:
    squad_ref: "appliance_inbound_entry"
  server_url_mode:
    enabled: false
    note: "Dynamic assistant/squad resolution deferred to later stage"
```

---

# 13. Пошаговый план развёртывания Stage 1

## Step 1 — подготовить среду Twilio CLI

```bash
twilio login
twilio profiles:list
twilio profiles:use abc-dev
```

Проверить:
- в какой profile ты вошёл;
- какой account/subaccount у этого profile;
- какие номера там уже есть.

## Step 2 — зафиксировать inventory номера

```bash
twilio phone-numbers:list -p abc-dev -o json
```

Сохранить отдельно:
- `phone_number_e164`
- `phone_number_sid`
- `friendly_name`
- current `voice_url` if present

## Step 3 — поднять Vapi CLI и Vapi org для среды

```bash
vapi login
vapi init
vapi phone list
```

## Step 4 — импортировать номер из Twilio в Vapi

Предпочтительно через Vapi dashboard/API.

После импорта нужно проверить:
- номер появился в Vapi;
- provider = BYO / Twilio-backed import;
- номер в статусе active;
- привязка к нужной среде корректна.

## Step 5 — создать assistant `entry_greeter`

Создать ассистента с очень узкой задачей:
- быстро ответить;
- сказать приветствие;
- не уводить логику в qualification-heavy сценарий.

## Step 6 — создать squad `appliance_inbound_entry`

Состав squad на этом этапе:
- member #1 = `entry_greeter`

Никаких дополнительных handoff destinations на Stage 1 не требуется.

## Step 7 — привязать squad к Vapi phone number

На уровне номера:
- задать `squadId` соответствующего squad;
- не включать ещё dynamic routing, если нет отдельной причины.

## Step 8 — сделать контрольный inbound test

Тест:
1. позвонить на Twilio number;
2. убедиться, что Vapi взял вызов;
3. убедиться, что сработал именно `entry_greeter`;
4. услышать нужное приветствие.

---

# 14. Локальная отладка и временное переключение маршрута

Иногда нужно временно увести звонок с Vapi на диагностический endpoint или вернуть обратно.

## 14.1. Диагностический маршрут напрямую через Twilio CLI

```bash
twilio phone-numbers:update PNXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX \
  -p abc-dev \
  --voice-url https://<public-tunnel-or-debug-endpoint>/twilio/inbound/voice \
  --voice-method POST
```

Применять только когда нужно:
- проверить, что проблема точно не в carrier layer;
- проверить чистый Twilio -> app path;
- сделать rollback при проблеме с Vapi config.

## 14.2. Возврат маршрута обратно

Нужно заранее хранить:
- previous voice URL;
- дата изменения;
- кто менял;
- зачем менял.

Пример отдельного inventory-файла:

```yaml
twilio_number_operations:
  number: "+1XXXXXXXXXX"
  environment: "dev"
  last_known_good:
    voice_url: "https://vapi-managed-or-approved-endpoint.example.com/voice"
    voice_method: "POST"
    verified_at: "2026-03-07T19:30:00-05:00"
    verified_by: "robert"
```

---

# 15. Acceptance Criteria для Stage 1

Stage 1 принят только если одновременно выполнены все условия:

```yaml
acceptance_criteria:
  telephony:
    - "На Twilio number можно дозвониться"
    - "Номер находится в правильной среде"
    - "CLI profile однозначно соответствует этой среде"

  vapi:
    - "Импортированный номер виден в Vapi"
    - "К номеру привязан squad"
    - "Squad стартует с entry_greeter"

  conversation:
    - "AI отвечает без критической задержки"
    - "Приветствие соответствует утвержденной формулировке"
    - "Нет лишней qualification logic, не реализованной на этом этапе"

  operations:
    - "Есть Twilio CLI runbook на verify/update/rollback"
    - "Есть Vapi CLI runbook на inspect/update"
    - "Есть понятный inventory номера и сред"

  testing:
    - "Есть минимум 3 ручных тест-звонка"
    - "Есть минимум 1 негативный сценарий rollback"
```

---

# 16. Test plan для Stage 1

## 16.1. Ручные тесты

### Test A — Happy path
- Позвонить на номер.
- Агент отвечает приветствием.
- Вызов слышен, TTS понятный.

### Test B — Repeated calls
- Сделать 3 подряд входящих звонка.
- Проверить стабильность запуска.

### Test C — Wrong environment protection
- Проверить, что запуск команд без правильного profile не проходит по внутреннему процессу.

### Test D — Twilio CLI rollback drill
- Временно поменять `voice-url` на debug endpoint.
- Убедиться, что вызов идёт туда.
- Вернуть предыдущий маршрут.

### Test E — Observability
- Открыть `twilio debugger:logs:list --streaming`.
- Сделать тестовый вызов.
- Убедиться, что при ошибках их видно сразу.

## 16.2. Что отложить на следующий этап

Не надо пытаться в Stage 1 тестировать:
- structured extraction `area/unit/issue`;
- calendar booking;
- FSM integration;
- human handoff behavior;
- price quoting.

---

# 17. Риски и как их предотвратить

## Риск 1 — случайно обновили не тот номер
**Причина:** нет строгого profile discipline.

**Защита:**
- отдельные profiles;
- требование profile в командах;
- inventory file;
- dry-run process через `list -o json` до `update`.

## Риск 2 — config drift между Vapi и Twilio
**Причина:** руками меняют одно и то же в двух местах.

**Защита:**
- правило “Vapi — основной runtime path, Twilio CLI — operations/break-glass only”.

## Риск 3 — локальная отладка не работает
**Причина:** используется localhost URL.

**Защита:**
- только public tunnel.

## Риск 4 — voice-url обновили, но номер продолжает идти по старому пути
**Причина:** у номера есть `voice_application_sid` или `trunk_sid`.

**Защита:**
- проверять number resource configuration до диагностики.

## Риск 5 — слишком рано усложнили архитектуру
**Причина:** пытаемся сразу строить qualification + scheduling + CRM tools.

**Защита:**
- Stage 1 ограничить только inbound answer + greeting.

---

# 18. Что будет следующим документом после этого

Следующий логичный документ:

```yaml
next_stage:
  title: "Stage 2 — Lead Qualification inside Squad"
  additions:
    - "entry_greeter -> lead_qualifier handoff"
    - "structured extraction: area, unit, issue"
    - "required slots and validation rules"
    - "non-target lead policy"
    - "spam / wrong-area / unsupported-unit handling"
```

---

# 19. Практическая рекомендация по итогам

Для твоего кейса оптимально так:

1. **Сразу строить на Squad.**
2. **На Stage 1 держать в squad только одного assistant.**
3. **Twilio CLI сделать обязательным operational toolchain.**
4. **Основной inbound путь держать статическим через `squadId`, а не dynamic routing.**
5. **Dynamic server URL path включать только когда появится реальная логика выбора assistant/squad.**

Это даст:
- максимальный запас по контролю над будущим script flow;
- аккуратную environment discipline;
- управляемый rollback;
- минимальный риск хаоса в конфигурации уже на первом этапе.
