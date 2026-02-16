---
title: "Twilio: обновление voice-настроек и автоответчик после 30 секунд"
doc_type: "YAML+Markdown task spec"
language: "ru"
owner: "Agent"
environment: "production"
priority: "high"
status: "ready_for_implementation"
objective: >
  Обновить voice-настройки в Twilio для 3 телефонных номеров (и SIP Domain при необходимости),
  реализовать переход на автоответчик с записью голосового сообщения, если никто не ответил за ~30 секунд.
scope:
  in:
    - "Twilio Incoming Phone Numbers: Voice URL / Voice Fallback URL / Status Callback"
    - "Webhook-логика в приложении abc-metrics.fly.dev"
    - "Голосовое приветствие и запись voicemail"
  out:
    - "Изменение логики CRM-интерфейса по отображению legs/interactions"
    - "Изменение SIP-клиентов Bria"
requirements:
  - "Работать в режиме @orchestrator.md."
inputs:
  phone_numbers:
    - "+18774194983"   # (877) 419-4983
    - "+16175006181"   # (617) 500-6181
    - "+16179927291"   # (617) 992-7291
  sip_domain: "abchomes.sip.twilio.com"
  current_urls:
    voice_url: "https://abc-metrics.fly.dev/webhooks/twilio/voice-inbound"
    voice_fallback_url: ""
    status_callback: "https://abc-metrics.fly.dev/webhooks/twilio/voice-status"
  target_urls:
    voice_url: "https://abc-metrics.fly.dev/webhooks/twilio/voice-inbound"
    voice_fallback_url: "https://abc-metrics.fly.dev/webhooks/twilio/voice-fallback"
    status_callback: "https://abc-metrics.fly.dev/webhooks/twilio/voice-status"
  voicemail:
    enabled: true
    dial_timeout_config_value_seconds: 25
    note: "Twilio добавляет ~5 секунд буфера к <Dial timeout>; 25с обычно дает ~30с реального ожидания."
    greeting_text_ru: "Все менеджеры сейчас заняты. Мы перезвоним вам. Пожалуйста, оставьте голосовое сообщение после сигнала."
    record:
      max_length_seconds: 180
      silence_timeout_seconds: 5
      finish_on_key: "#"
      play_beep: true
      transcribe: false
deliverables:
  - "Обновленные настройки Twilio для всех 3 номеров (и SIP Domain, если используется для входящих)"
  - "Новые/обновленные webhook-эндпоинты в приложении"
  - "Логи тестов с 3 сценариями (answered / no-answer / fallback-error)"
  - "Краткий rollout+rollback отчет"
---

# 1) Цель задачи

Сделать так, чтобы входящий звонок продолжал идти по текущему маршруту в Bria, но если никто не ответил за ~30 секунд, звонок переходил на автоответчик:
1. проигрывается приветствие;
2. записывается голосовое сообщение клиента;
3. звонок завершается.

---

# 2) Важные правила реализации

1. **Не использовать Voice Fallback URL** как бизнес-ветку “никто не ответил”.  
   Fallback — только на случай ошибки получения/выполнения TwiML.
2. Бизнес-ветку автоответчика реализовать через `<Dial action="...">` и анализ `DialCallStatus`.
3. Использовать только `https://` URL в настройках Twilio.
4. Перед изменениями снять “снимок” текущих настроек в JSON (backup).

---

# 3) CLI-план: проверка и backup

## 3.1 Проверка профиля и логин

```bash
twilio profiles:list
twilio profiles:use <YOUR_PROFILE>
twilio login
```

## 3.2 Получить SID каждого номера и сохранить текущие настройки

```bash
mkdir -p ./twilio-backup

for NUM in +18774194983 +16175006181 +16179927291; do
  PN_SID=$(twilio api:core:incoming-phone-numbers:list --phone-number "$NUM" --limit 1 -o json | jq -r '.[0].sid')
  twilio api:core:incoming-phone-numbers:fetch --sid "$PN_SID" -o json > "./twilio-backup/${NUM}.json"
  echo "$NUM => $PN_SID"
done
```

## 3.3 Валидация на блокирующие конфиги

Проверить в backup-файлах поля:
- `voice_application_sid`
- `trunk_sid`

Если одно из них задано, `voice_url` у номера может игнорироваться.  
В этом случае агент должен обновлять соответствующий ресурс (Application/Trunk), а не только номер.

---

# 4) CLI-план: обновление настроек номеров

> Применить для всех 3 номеров одинаковую конфигурацию.

```bash
BASE_URL="https://abc-metrics.fly.dev"

for NUM in +18774194983 +16175006181 +16179927291; do
  PN_SID=$(twilio api:core:incoming-phone-numbers:list --phone-number "$NUM" --limit 1 -o json | jq -r '.[0].sid')

  twilio api:core:incoming-phone-numbers:update     --sid "$PN_SID"     --voice-url "$BASE_URL/webhooks/twilio/voice-inbound"     --voice-method POST     --voice-fallback-url "$BASE_URL/webhooks/twilio/voice-fallback"     --voice-fallback-method POST     --status-callback "$BASE_URL/webhooks/twilio/voice-status"     --status-callback-method POST
done
```

## 4.1 Проверка после апдейта

```bash
for NUM in +18774194983 +16175006181 +16179927291; do
  PN_SID=$(twilio api:core:incoming-phone-numbers:list --phone-number "$NUM" --limit 1 -o json | jq -r '.[0].sid')
  twilio api:core:incoming-phone-numbers:fetch --sid "$PN_SID" -o json | jq '{
    phone_number,
    sid,
    voice_url,
    voice_method,
    voice_fallback_url,
    voice_fallback_method,
    status_callback,
    status_callback_method,
    voice_application_sid,
    trunk_sid
  }'
done
```

---

# 5) SIP Domain (abchomes.sip.twilio.com)

Если SIP Domain используется для **входящих SIP INVITE в Twilio**, привести его URL к тем же endpoint-ам:
- Voice URL: `https://abc-metrics.fly.dev/webhooks/twilio/voice-inbound`
- Voice Fallback URL: `https://abc-metrics.fly.dev/webhooks/twilio/voice-fallback`

Сначала получить SID SIP Domain и текущие параметры.  
Если в конкретной версии CLI команды отличаются — использовать `--help` и задокументировать итоговую команду в отчете.

---

# 6) Изменения в приложении (webhooks)

## 6.1 Endpoint: `/webhooks/twilio/voice-inbound` (существующий)

Должен возвращать TwiML с `<Dial>` в Bria-клиенты и `action` на новый endpoint:

- `timeout = 25` (получаем около 30 секунд фактического ожидания)
- `answerOnBridge = true`
- `method = POST`
- `action = /webhooks/twilio/voice-dial-action`

### Пример (Node/Twilio TwiML)

```js
const twiml = new Twilio.twiml.VoiceResponse();

const dial = twiml.dial({
  timeout: 25,
  answerOnBridge: true,
  action: "https://abc-metrics.fly.dev/webhooks/twilio/voice-dial-action",
  method: "POST",
});

// Пример клиентов Bria
dial.client("dispatcher1");
dial.client("dispatcher2");
dial.client("dispatcher3");

return twiml.toString();
```

## 6.2 Новый endpoint: `/webhooks/twilio/voice-dial-action`

Логика:
- Если `DialCallStatus=completed` -> разговор состоялся, завершить без voicemail.
- Если `DialCallStatus in [no-answer, busy, failed, canceled]` -> автоответчик:
  1) `<Say>` приветствие;
  2) `<Record>` с параметрами из `inputs.voicemail.record`;
  3) `<Hangup>`.

### Пример (Node/Twilio TwiML)

```js
const twiml = new Twilio.twiml.VoiceResponse();
const status = String(req.body.DialCallStatus || "").toLowerCase();

const toVoicemail = ["no-answer", "busy", "failed", "canceled"].includes(status);

if (toVoicemail) {
  twiml.say(
    { language: "ru-RU" },
    process.env.VM_GREETING || "Все менеджеры сейчас заняты. Мы перезвоним вам. Пожалуйста, оставьте голосовое сообщение после сигнала."
  );

  twiml.record({
    maxLength: Number(process.env.VM_MAXLEN || 180),
    timeout: Number(process.env.VM_SILENCE_TIMEOUT || 5),
    finishOnKey: process.env.VM_FINISH_ON_KEY || "#",
    playBeep: true,
    transcribe: false,
  });

  twiml.hangup();
} else {
  twiml.hangup();
}

return twiml.toString();
```

## 6.3 Новый endpoint: `/webhooks/twilio/voice-fallback`

Назначение: аварийный ответ, если основной webhook недоступен/ошибка TwiML.  
Минимум:
- короткий `<Say>` (EN/RU),
- `Hangup`,
- логирование инцидента.

---

# 7) ENV-переменные

```env
DIAL_TIMEOUT=25
VM_GREETING=Все менеджеры сейчас заняты. Мы перезвоним вам. Пожалуйста, оставьте голосовое сообщение после сигнала.
VM_MAXLEN=180
VM_SILENCE_TIMEOUT=5
VM_FINISH_ON_KEY=#
VM_LANGUAGE=ru-RU
```

---

# 8) План тестирования

## Сценарий A: никто не взял
- Входящий звонок на любой из 3 номеров.
- Ожидание ~30 секунд.
- Проверка: проигрывается приветствие, начинается запись voicemail.

## Сценарий B: один диспетчер ответил
- Проверка: соединение с диспетчером, автоответчик **не** включается.

## Сценарий C: принудительная ошибка webhook
- Временно сломать `voice-inbound` (например, 500/timeout в тестовом окне).
- Проверка: Twilio дергает `voice-fallback`, звонок получает аварийный ответ.

## Что сохранить в отчет:
- Call SID(ы)
- DialCallStatus
- запись логов webhook
- итог: pass/fail по каждому сценарию

---

# 9) Критерии приемки (Acceptance Criteria)

1. Для всех 3 номеров задан:
   - Voice URL = `/webhooks/twilio/voice-inbound`
   - Voice Fallback URL = `/webhooks/twilio/voice-fallback`
   - Status Callback = `/webhooks/twilio/voice-status`
2. При отсутствии ответа звонок уходит на автоответчик через ~30 секунд.
3. При успешном ответе диспетчера автоответчик не включается.
4. Fallback срабатывает только при ошибке webhook/TwiML.
5. Все изменения и команды зафиксированы в rollout-отчете.

---

# 10) Rollback

1. Взять значения из `./twilio-backup/*.json`.
2. Выполнить обратный `incoming-phone-numbers:update` для каждого номера.
3. Вернуть старую логику webhook в приложении (git revert/rollback deploy).
4. Провести smoke-тест входящего звонка на каждый номер.

---

# 11) Технические примечания

- В Twilio `<Dial>` есть буфер ~5 сек поверх `timeout`, поэтому для “после 30 секунд” установлен `timeout=25`.
- Если обнаружен `voice_application_sid` или `trunk_sid`, обновление делается на уровне Application/Trunk, иначе изменения на номере могут не применяться.
