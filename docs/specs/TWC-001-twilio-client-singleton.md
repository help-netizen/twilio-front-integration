# Спецификация: TWC-001 — Twilio API Client Singleton

## Общее описание
Единый shared экземпляр Twilio Node SDK на процесс. Все backend-модули, которым нужен Twilio REST API, получают клиент через `getTwilioClient()` из нового модуля `backend/src/services/twilioClient.js`. Это устраняет накопление idle keep-alive HTTPS-сокетов к `api.twilio.com` и связанные CLOSE_WAIT-утечки.

---

## Сценарии поведения

### Сценарий 1: Stale-call reconciliation в inboxWorker
- **Предусловия:** есть stale-звонки (status not final, ttl > N), `TWILIO_ACCOUNT_SID` и `TWILIO_AUTH_TOKEN` заданы.
- **Входные данные:** массив `call_sid` из БД.
- **Шаги:**
  1. inboxWorker вызывает `reconcileStaleCalls()`.
  2. Внутри `fetchAndUpdateFromTwilio(callSid)` вызывается `getTwilioClient()`.
  3. `getTwilioClient()` возвращает уже инициализированный shared instance (или инициализирует на первом вызове).
  4. Выполняется `client.calls(callSid).fetch()` через единый keep-alive пул.
  5. Результат записывается в БД ровно так же, как раньше.
- **Ожидаемый результат:** один и тот же inner Twilio client для всех итераций, ни один новый `https.Agent` не создаётся.
- **Побочные эффекты:** обновление колонок `calls.status / is_final / ended_at / duration_sec / price / price_unit` (без изменений), SSE-публикация `realtimeService.publishCallUpdate(...)` (без изменений).

### Сценарий 2: Проверка доступности оператора
- **Предусловия:** входящий звонок, `callAvailability.checkAvailability(...)` вызван из webhook-обработчика.
- **Входные данные:** TwiML-контекст звонка.
- **Шаги:**
  1. `callAvailability.js` вместо `twilio(sid, token)` вызывает `getTwilioClient()`.
  2. Запрос идёт через тот же пул соединений, что у `reconcileStale.js`.
- **Ожидаемый результат:** идентичный TwiML-ответ, без накопления соединений.

### Сценарий 3: Webhook-event processing в inboxWorker
- **Предусловия:** запись в `inbox_events` с `kind = 'twilio.*'`.
- **Шаги:**
  1. `inboxWorker.claimAndProcessEvents()` обрабатывает событие.
  2. Обработчик вместо `const client = twilio(sid, token)` вызывает `getTwilioClient()`.
  3. Любые `client.calls`, `client.recordings`, `client.messages` — через shared client.
- **Ожидаемый результат:** один shared client за всю работу воркера; стабильное число outgoing-сокетов.

### Сценарий 4: Phone-settings request
- **Предусловия:** аутентифицированный admin-запрос к `/api/phone-settings/*`.
- **Шаги:**
  1. Route-handler вместо локального `twilio()` вызывает `getTwilioClient()`.
  2. Все Numbers API вызовы идут через shared client.

### Сценарий 5: Cold start процесса
- **Предусловия:** свежий старт node, env заданы.
- **Шаги:**
  1. Модули, которые ранее на require выполняли `const client = twilio(sid, token)` (`conversationsService.js`, `twilioSync.js`, `reconcileService.js`), больше этого не делают.
  2. Первый реальный вызов Twilio (например, входящее SMS) триггерит `getTwilioClient()`, который один раз инициализирует клиент.
- **Ожидаемый результат:** ленивая инициализация, никакой работы при импорте модулей.

### Сценарий 6: Тесты или CLI без Twilio env
- **Предусловия:** Jest или CLI-команда не требуют Twilio API.
- **Шаги:**
  1. Импорт `conversationsService` / `reconcileStale` / `inboxWorker` / `phoneSettings` не падает.
  2. `getTwilioClient()` НЕ вызывается, так как код-путь до Twilio API не доходит.
- **Ожидаемый результат:** загрузка модулей без env работает; ошибка возникает только если код реально пробует использовать клиента без env.

---

## Граничные случаи

| Случай | Ожидаемое поведение |
|---|---|
| Множественные параллельные вызовы `getTwilioClient()` до завершения первой инициализации | Все вызовы возвращают один и тот же объект (синхронная инициализация — гонок не будет, JS однопоточный). |
| Повторный вызов `getTwilioClient()` после успешной инициализации | Возвращает закэшированный instance; `===` идентичность сохранена. |
| `TWILIO_ACCOUNT_SID` пустой или отсутствует | Первый вызов `getTwilioClient()` бросает `Error('TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN are required')`. |
| `TWILIO_AUTH_TOKEN` пустой или отсутствует | То же самое. |
| Env становится доступен после первой ошибки | Поведение не определено (rare); опционально клиент может НЕ кэшировать результат при ошибке — тогда повторная попытка после установки env отработает. Решение: в случае ошибки `_client` остаётся `null`, повторный вызов снова попробует инициализировать. |
| Несколько процессов node (worker pool / cluster) | Каждый процесс держит свой singleton — это ожидаемо и допустимо. На данном проде один node-процесс. |

---

## Обработка ошибок

| Ошибка | Реакция |
|---|---|
| `getTwilioClient()` бросает из-за отсутствия env | Существующая обработка ошибок в каждом call-site не меняется: `reconcileStale.js` ловит и логирует, `inboxWorker.js` помечает event failed, `phoneSettings.js` возвращает 500. |
| Twilio API возвращает 404 | Поведение не меняется (см. `reconcileStale.js:185`: помечаем call как failed). |
| Twilio API возвращает 5xx / network error | Поведение не меняется; существующая логика ретраев/логирования сохраняется. |
| Утечка случилась снова (количество outbound-сокетов растёт) | Симптомов нет в коде (т.к. shared agent), но если возникнет — это сигнал что какой-то модуль создаёт свой `twilio()` локально → линтер-правило (см. план задач) предотвращает это. |

---

## Взаимодействие компонентов

```
inboxWorker.js  ──┐
reconcileStale ──┤
callAvailability ┤ ──>  twilioClient.js (getTwilioClient)  ──>  twilio SDK ──> api.twilio.com
phoneSettings.js ┤                                               │
conversationsSvc ┤                                               └─ shared https.Agent (keep-alive)
twilioSync.js   ─┤
reconcileService ┘
```

Никаких новых SSE / DB / frontend-взаимодействий. Чистая internal refactor.

---

## API-контракты

Внутренний модуль, без HTTP-эндпоинтов.

```js
// backend/src/services/twilioClient.js
function getTwilioClient(): TwilioClient
// throws Error if TWILIO_ACCOUNT_SID or TWILIO_AUTH_TOKEN are missing on first call
```

Возвращаемый объект — стандартный Twilio Node SDK client (`twilio(sid, token)`-результат). Surface полностью совпадает с `require('twilio')(sid, token)`.

---

## Безопасность и изоляция данных

- Не затрагивается. Никаких новых routes, никаких SQL.
- TWILIO_AUTH_TOKEN остаётся read-once из env, не логируется.
- Singleton не помечается per-tenant; multi-tenant аспект Twilio out-of-scope для TWC-001.

---

## Acceptance criteria (operational)

После деплоя на прод:

1. **TCP-соединения:**
   ```
   fly ssh console -a abc-metrics -C "grep ' 01 ' /proc/net/tcp" \
     | awk '$3 ~ /:01BB$/' | wc -l
   ```
   ≤ 30 в течение 6 часов (было 199+).
2. **CLOSE_WAIT:**
   ```
   fly ssh console -a abc-metrics -C "grep ' 08 ' /proc/net/tcp"
   ```
   ≤ 5 (было 28).
3. **Поведение Twilio API**: никаких регрессий — звонки/SMS/reconcile отрабатывают как раньше (метрики successful API calls в логах не падают).
4. **Memory**: VmRSS node-процесса в ±10% от текущих ~290 MB (singleton не должен увеличить memory; должен слегка снизить за счёт исчезновения дублирующихся agent-пулов).
