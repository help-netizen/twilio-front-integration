---
title: "Twilio Conversations end-to-end: таблицы, webhook contracts, rollout без остановки SMS"
version: "1.0.0"
date: "2026-02-15"
owner: "Backend + Frontend + DevOps"
priority: "high"
status: "ready_for_implementation"
context:
  current_state:
    - "В проде уже работает Twilio SMS/Voice на abc-metrics.fly.dev"
    - "Нужно добавить Conversations без даунтайма и без остановки текущих SMS потоков"
  goal:
    - "Единый inbox в UI"
    - "Поддержка файлов (preview + download)"
    - "Поток событий клиента по номеру телефона в разных частях интерфейса"
requirements:
  - "Работать в режиме @orchestrator.md."
scope:
  in:
    - "DB schema: conversations/messages/media/events"
    - "Webhook contracts для Twilio Conversations и совместимость с текущим SMS webhook"
    - "Rollout plan zero-downtime"
  out:
    - "Редизайн существующего Voice потока"
    - "Полная замена legacy SMS в один этап"
non_functional:
  availability: "no downtime, backward compatible"
  security:
    - "HTTPS only"
    - "Проверка X-Twilio-Signature"
    - "Idempotent обработка webhook событий"
  performance:
    - "Conversations webhook handler отвечает <= 2s (hard limit Twilio webhook timeout 5s)"
  observability:
    - "structured logs + correlation ids"
    - "dashboard: webhook success rate, dedupe rate, message latency"
---

# 1) Архитектура (целевое состояние)

## 1.1 Компоненты

1. **Twilio Conversations API** — transport/каналы (SMS, WhatsApp, chat).
2. **Token Service** — выдача Conversations access token для web UI (identity оператора).
3. **Conversations Webhook Ingest** — прием и нормализация событий.
4. **Unified Messaging API** — внутренний API для UI (списки диалогов, сообщения, вложения, отправка).
5. **PostgreSQL** — source of truth для UI и cross-screen event stream.
6. **Legacy SMS Webhook Compatibility Layer** — совместимость и фильтрация дублей на период миграции.

## 1.2 Принципы

- **Conversations = source of truth** для migrated number pairs.
- Текущий SMS webhook остается рабочим для не мигрированных пар.
- Переключение выполняется **по номеру/паре**, а не “всё сразу”.

---

# 2) Структура таблиц (PostgreSQL)

> Минимально требуемые таблицы: `conversations`, `messages`, `media`, `events`.

## 2.1 conversations

```sql
CREATE TABLE conversations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  twilio_conversation_sid TEXT UNIQUE,             -- CH...
  service_sid TEXT,                                -- IS... (если используется не default service)
  channel_type TEXT NOT NULL DEFAULT 'sms',        -- sms|whatsapp|chat|mixed
  state TEXT NOT NULL DEFAULT 'active',            -- active|inactive|closed
  customer_e164 TEXT,                              -- +1...
  proxy_e164 TEXT,                                 -- Twilio number used as proxyAddress
  friendly_name TEXT,
  attributes JSONB NOT NULL DEFAULT '{}'::jsonb,
  source TEXT NOT NULL DEFAULT 'twilio',           -- twilio|legacy_migrated|manual
  first_message_at TIMESTAMPTZ,
  last_message_at TIMESTAMPTZ,
  last_message_preview TEXT,
  last_message_direction TEXT,                     -- inbound|outbound|system
  closed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_conversations_last_message_at ON conversations(last_message_at DESC);
CREATE INDEX idx_conversations_customer_proxy ON conversations(customer_e164, proxy_e164);
CREATE INDEX idx_conversations_state ON conversations(state);
CREATE INDEX idx_conversations_attrs_gin ON conversations USING gin(attributes);

-- Уникальность активной пары (to/from binding) на уровне БД:
CREATE UNIQUE INDEX uniq_active_pair
ON conversations(customer_e164, proxy_e164)
WHERE state = 'active' AND customer_e164 IS NOT NULL AND proxy_e164 IS NOT NULL;
```

## 2.2 messages

```sql
CREATE TABLE messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  twilio_message_sid TEXT UNIQUE,                  -- IM...
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  conversation_sid TEXT,                           -- денормализация для быстрых выборок
  author TEXT,                                     -- identity/phone
  author_type TEXT NOT NULL DEFAULT 'external',    -- external|agent|system
  direction TEXT NOT NULL,                         -- inbound|outbound|system
  transport TEXT NOT NULL DEFAULT 'sms',           -- sms|mms|whatsapp|chat
  body TEXT,
  attributes JSONB NOT NULL DEFAULT '{}'::jsonb,
  delivery_status TEXT,                            -- queued|sent|delivered|read|undelivered|failed|null
  error_code INTEGER,
  error_message TEXT,
  index_in_conversation BIGINT,                    -- Twilio message index (если есть)
  date_created_remote TIMESTAMPTZ,
  date_updated_remote TIMESTAMPTZ,
  date_sent_remote TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_messages_conversation_created ON messages(conversation_id, created_at ASC);
CREATE INDEX idx_messages_transport ON messages(transport);
CREATE INDEX idx_messages_delivery_status ON messages(delivery_status);
CREATE INDEX idx_messages_author ON messages(author);
```

## 2.3 media

```sql
CREATE TABLE media (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  twilio_media_sid TEXT UNIQUE,                    -- ME... (если приходит)
  category TEXT NOT NULL DEFAULT 'media',          -- media
  filename TEXT,
  content_type TEXT,
  size_bytes BIGINT,
  preview_kind TEXT,                               -- image|video|audio|pdf|other
  storage_provider TEXT NOT NULL DEFAULT 'twilio',
  temporary_url TEXT,                              -- кэшировать опционально
  temporary_url_expires_at TIMESTAMPTZ,            -- ~now()+300s
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_media_message_id ON media(message_id);
CREATE INDEX idx_media_content_type ON media(content_type);
CREATE INDEX idx_media_expires_at ON media(temporary_url_expires_at);
```

## 2.4 events

```sql
CREATE TABLE events (
  id BIGSERIAL PRIMARY KEY,
  provider TEXT NOT NULL,                          -- twilio_conversations|twilio_messaging
  event_type TEXT NOT NULL,                        -- onMessageAdded, onDeliveryUpdated, ...
  idempotency_key TEXT NOT NULL,                   -- hash(provider + event_type + sid + timestamp + body)
  twilio_request_sid TEXT,
  conversation_sid TEXT,
  message_sid TEXT,
  participant_sid TEXT,
  webhook_url TEXT,
  headers JSONB NOT NULL DEFAULT '{}'::jsonb,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  processing_status TEXT NOT NULL DEFAULT 'received', -- received|processed|ignored|failed
  processing_error TEXT,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX uniq_events_idempotency_key ON events(idempotency_key);
CREATE INDEX idx_events_conversation_sid ON events(conversation_sid);
CREATE INDEX idx_events_message_sid ON events(message_sid);
CREATE INDEX idx_events_status_received ON events(processing_status, received_at DESC);
```

---

# 3) Webhook contracts

## 3.1 External endpoints (Twilio -> backend)

### A) `POST /webhooks/twilio/conversations/pre`

**Назначение:** pre-action webhook для модерации/правил.  
**SLA:** вернуть 200 быстро (<=2s), тяжелую логику в async worker.

**Headers:**
- `X-Twilio-Signature` (обязательно валидировать)
- `Content-Type: application/x-www-form-urlencoded` или JSON (в зависимости от настройки)

**Body (примерно):**
- `EventType` (например `onMessageAdd`, `onConversationAdd`)
- `ConversationSid`, `MessageSid`, `ParticipantSid`, `Body`, и пр.

**Response contract:**
- `200 {}` -> принять
- `4xx/5xx` -> отклонить (для pre-action)
- timeout -> Twilio fallback behavior по правилам Conversations webhooks

---

### B) `POST /webhooks/twilio/conversations/post`

**Назначение:** post-action ingest событий для записи в БД/обновления UI.

**Обрабатываемые EventType (минимум):**
- `onConversationAdded`
- `onConversationUpdated`
- `onConversationRemoved`
- `onParticipantAdded`
- `onParticipantUpdated`
- `onParticipantRemoved`
- `onMessageAdded`
- `onMessageUpdated`
- `onMessageRemoved`
- `onDeliveryUpdated`

**Требования обработки:**
1. Проверить подпись.
2. Сформировать `idempotency_key`.
3. Записать raw event в `events`.
4. Нормализовать в `conversations/messages/media`.
5. Вернуть `200 OK` максимально быстро.

---

### C) `POST /webhooks/twilio/messaging/inbound` (legacy, уже существует)

**Назначение:** не ломать текущую SMS обработку на период миграции.

**Правило совместимости (анти-дубли):**
- Если пара `(From=customer_e164, To=proxy_e164)` уже привязана к активной Conversation (`state='active'`),  
  **не создавать сообщение в legacy-потоке**, помечать event как `ignored_migrated_pair`.
- Иначе — обрабатывать legacy-логикой как раньше.

---

## 3.2 Internal API contracts (backend -> UI)

### `GET /api/conversations?cursor=...&q=...&state=active`
Возвращает список диалогов:
- `conversationId`, `twilioConversationSid`, `customerE164`, `proxyE164`
- `lastMessagePreview`, `lastMessageAt`, `state`, `unreadCount`, `channelType`

### `GET /api/conversations/:id/messages?cursor=...`
Возвращает сообщения:
- `messageId`, `twilioMessageSid`, `direction`, `author`, `body`, `deliveryStatus`, `createdAt`
- `media[]`: `mediaId`, `filename`, `contentType`, `sizeBytes`, `previewKind`

### `POST /api/conversations/:id/messages`
Отправка текста/файлов:
- multipart/form-data или JSON + media upload
- backend отправляет через Twilio Conversations API

### `GET /api/media/:mediaId/temporary-url`
Генерирует свежий временный URL на вложение (TTL ~300s).

---

# 4) Логика вложений (preview + download)

1. На `onMessageAdded` если есть media:
   - создать запись в `media`.
2. Для preview:
   - image/video/audio/pdf рендерить нативно;
   - для остальных типов показывать generic file tile.
3. Для download:
   - запрашивать `temporary URL` через backend endpoint;
   - не кэшировать ссылку дольше TTL;
   - при 401/403/expired — делать refresh URL и повторять загрузку.

---

# 5) Rollout без остановки текущих SMS (поэтапно)

## Phase 0 — Подготовка (без влияния на прод-поток)
- Создать таблицы `conversations/messages/media/events`.
- Развернуть webhook endpoints (`/conversations/pre`, `/conversations/post`).
- Добавить в Twilio Conversations Service webhooks (pre/post).
- Включить строгую валидацию подписи и idempotency.
- Feature flags:
  - `FF_CONV_READ`
  - `FF_CONV_SEND`
  - `FF_CONV_AUTOCREATE`
  - `FF_CONV_MIGRATED_PAIR_FILTER`

## Phase 1 — Shadow ingest
- Не менять текущий SMS UX.
- Принимать Conversations events, писать в БД.
- Сверять объемы и дубли с legacy событиями.

## Phase 2 — Controlled pilot (explicit REST creation, Autocreate OFF)
- Создавать Conversations только для пилотных клиентов/номеров через API.
- Для этих пар включить фильтр в legacy inbound webhook (`ignored_migrated_pair`).
- UI (для пилота) читает из `/api/conversations`.

## Phase 3 — Outbound switch per pair
- Для migrated pairs отправка сообщений идет через Conversations API.
- Для остальных — старая отправка SMS (без изменений).
- Мониторинг deliverability + onDeliveryUpdated.

## Phase 4 — Number-by-number migration
- По одному номеру добавлять в Messaging Service для Conversations Autocreation.
- После каждого шага: smoke tests + метрики за 24 часа.
- При аномалии — откат только по конкретному номеру.

## Phase 5 — Cutover
- Включить новый inbox для всех операторов.
- Legacy webhook оставить в compatibility mode на переходный период (2–4 недели).
- После стабилизации — выключить legacy write-path.

---

# 6) Acceptance Criteria

1. В UI есть единый раздел диалогов (`conversations`) и карточка переписки (`messages`).
2. Вложения отправляются/получаются; preview и download работают.
3. В других разделах интерфейса можно вывести event stream по номеру телефона.
4. Нет остановки текущих SMS на любом этапе rollout.
5. Дубли сообщений не появляются (idempotency + migrated pair filter).
6. Вебхуки обрабатываются в пределах SLA, ошибки ретраятся.

---

# 7) Тест-кейсы (минимум)

## T1: Inbound SMS для не мигрированной пары
- Ожидание: старый поток работает как раньше.

## T2: Inbound SMS для migrated pair
- Ожидание: событие в Conversations, legacy обработчик помечает `ignored_migrated_pair`.

## T3: Outbound text в migrated pair
- Ожидание: сообщение уходит через Conversations, приходит `onMessageAdded`.

## T4: Media message
- Ожидание: media сохраняется в `media`, preview отображается, download по temporary URL работает.

## T5: Webhook duplicate replay
- Ожидание: повтор не создает вторую запись в `messages/events`.

## T6: Webhook timeout simulation
- Ожидание: endpoint не блокирует основной поток, события уходят в retry/queue корректно.

---

# 8) Rollback plan

1. Отключить `FF_CONV_SEND` и `FF_CONV_AUTOCREATE`.
2. Вернуть отправку на legacy SMS path.
3. Оставить `conversations` ingest в read-only для диагностики.
4. При необходимости откатить номер из Messaging Service Conversations.
5. Сохранить все webhook payloads и отчет по инциденту.

---

# 9) Примечания по реализации

- Для фронта использовать Twilio Conversations JS SDK (NPM/CDN) + собственный UI слой.
- Для быстрого старта UI взять за основу Twilio Conversations React demo и адаптировать.
- Не хранить долговременные публичные media URL (они временные); генерировать по требованию.
- Все телефоны хранить в E.164, нормализация обязательна.

---

# 10) Reference links (для агента)

- Conversations SDK install (JS, NPM/CDN)  
  https://www.twilio.com/docs/conversations/sdk-download-install

- Conversations webhooks (pre/post, timeout)  
  https://www.twilio.com/docs/conversations/conversations-webhooks

- Inbound handling & autocreation + migration guidance  
  https://www.twilio.com/docs/conversations/inbound-autocreation

- Sending messages & media (temporary URLs, security)  
  https://www.twilio.com/docs/conversations/sending-messages-and-media

- Media support in Conversations (temporary URL lifecycle)  
  https://www.twilio.com/docs/conversations/media-support-conversations

- Delivery receipts (onDeliveryUpdated and statuses)  
  https://www.twilio.com/docs/conversations/delivery-receipts
