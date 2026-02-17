---
title: "Twilio → AssemblyAI → Blanc: План реализации онлайн-транскрибации звонков"
version: "1.0"
date: "2026-02-16"
owner: "Blanc FSM"
status: "draft_for_implementation"
language: "ru"
stack:
  backend: ["Node.js", "TypeScript", "WebSocket", "PostgreSQL"]
  telephony: ["Twilio Voice", "Twilio Media Streams"]
  stt: ["AssemblyAI Streaming v3"]
  frontend: ["Blanc FSM UI (WebSocket/SSE stream)"]
goals:
  - "Передавать аудио звонка из Twilio в AssemblyAI в реальном времени"
  - "Показывать поток текста в карточке звонка Blanc (live transcript)"
  - "Сохранять финальный транскрипт как атрибут звонка в БД Blanc после завершения звонка"
non_goals:
  - "Изменение текущей бизнес-логики маршрутизации звонков в Twilio"
  - "Полная замена call-flow (Dial/Queue/Conference)"
---

# 1) Scope и итоговый результат

## Что должно работать
1. При старте звонка Twilio начинает Media Stream (`<Start><Stream>`) в WebSocket endpoint Blanc.
2. Blanc Media Gateway получает аудиопакеты, маршрутизирует по трекам и проксирует в AssemblyAI Streaming.
3. Частичные/финальные сегменты транскрипта публикуются в UI Blanc как поток текста.
4. По завершению звонка финальный транскрипт сохраняется в `calls.attributes.transcript` (JSONB) в БД Blanc.

## Definition of Done
- Live текст появляется в UI во время звонка.
- После завершения звонка транскрипт доступен в карточке звонка и через API.
- Есть трассировка `callSid ↔ streamSid ↔ blancCallId ↔ assemblySessionId`.
- Реализована обработка ошибок и корректное закрытие сессий.

---

# 2) Архитектура (высокоуровнево)

```yaml
components:
  twilio:
    role: "Источник RTP-аудио через Media Streams (WS)"
    output: ["connected", "start", "media", "stop", "dtmf?"]
  blanc_media_gateway:
    role: "Прием WS от Twilio, роутинг треков, bridge в AssemblyAI"
    submodules:
      - "session_manager"
      - "track_router"
      - "chunk_buffer"
      - "realtime_publisher"
      - "transcript_persister"
  assemblyai_streaming:
    role: "Realtime STT по WS"
    events_in: ["audio chunks", "Terminate"]
    events_out: ["Begin", "Turn", "Termination", "Error?"]
  blanc_fsm_ui:
    role: "Отрисовка live transcript"
    transport: ["WebSocket или SSE"]
  blanc_db:
    role: "Хранение сегментов/финального транскрипта"
```

---

# 3) Стратегия треков аудио

```yaml
track_strategy:
  mvp:
    twilio_track: "inbound_track"
    assembly_sessions: 1
    pros:
      - "быстро внедряется"
      - "минимум сложности"
    cons:
      - "только голос клиента"
  production_recommended:
    twilio_track: "both_tracks"
    assembly_sessions: 2
    mapping:
      inbound: "customer"
      outbound: "agent"
    merge_rule: "сортировка по timestamp + track priority"
    pros:
      - "полный диалог клиент/агент"
      - "естественная speaker attribution"
```

---

# 4) Twilio интеграция (TwiML и webhooks)

## TwiML шаблон (пример)

```xml
<Response>
  <Start>
    <Stream
      name="blanc-live-transcript"
      url="wss://media.blanc.yourdomain/ws/twilio"
      track="both_tracks"
      statusCallback="https://api.blanc.yourdomain/webhooks/twilio/stream-status"
      statusCallbackMethod="POST">
      <Parameter name="blancCallId" value="{{BLANC_CALL_ID}}" />
      <Parameter name="tenantId" value="{{TENANT_ID}}" />
      <Parameter name="agentId" value="{{AGENT_ID}}" />
    </Stream>
  </Start>

  <Dial>{{DESTINATION}}</Dial>
</Response>
```

## Правила/ограничения Twilio (учесть в реализации)

```yaml
twilio_constraints:
  stream_url:
    must_be: "wss://"
    query_params_allowed: false
    correlation_via: "custom <Parameter>"
  audio_format:
    encoding: "audio/x-mulaw"
    sample_rate_hz: 8000
    channels: 1
  unidirectional_stream:
    supported_tracks: ["inbound_track", "outbound_track", "both_tracks"]
  callbacks:
    stream_status_events: ["stream-started", "stream-stopped", "stream-error"]
```

---

# 5) AssemblyAI streaming конфигурация

```yaml
assemblyai_ws:
  endpoint: "wss://streaming.assemblyai.com/v3/ws"
  query:
    sample_rate: 8000
    encoding: "pcm_mulaw"
    format_turns: false
  chunking:
    min_ms: 50
    max_ms: 1000
    target_ms: 100
  lifecycle:
    on_start: "expect Begin"
    on_audio: "send binary chunks"
    on_stop: "send {type: Terminate}, wait Termination, close socket"
```

---

# 6) Runtime sequence (по шагам)

```yaml
sequence:
  - step: 1
    name: "Call start"
    actor: "Twilio -> Blanc"
    details:
      - "Twilio открывает WS"
      - "Blanc получает events: connected/start"
      - "Blanc извлекает callSid/streamSid/customParameters"
  - step: 2
    name: "STT sessions open"
    actor: "Blanc -> AssemblyAI"
    details:
      - "Создать 1 или 2 WS сессии по track_strategy"
  - step: 3
    name: "Media forwarding"
    actor: "Blanc"
    details:
      - "На каждый media event: decode base64 -> mulaw bytes"
      - "Буферизовать до target chunk size"
      - "Отправить chunk в соответствующую AssemblyAI сессию"
  - step: 4
    name: "Live transcript push"
    actor: "Blanc -> FSM UI"
    details:
      - "На каждый Turn пушить delta event в UI"
      - "Показывать в карточке звонка в реальном времени"
  - step: 5
    name: "Call end + finalize"
    actor: "Twilio/Blanc/AssemblyAI"
    details:
      - "Получить stop или stream-stopped"
      - "Отправить Terminate во все STT-сессии"
      - "Получить Termination"
      - "Собрать full_text + segments"
      - "Сохранить в calls.attributes.transcript"
```

---

# 7) Контракты внутренних событий Blanc

## Live delta event (Gateway -> UI)

```json
{
  "type": "CALL_TRANSCRIPT_DELTA",
  "callId": "call_123",
  "tenantId": "tenant_001",
  "track": "inbound",
  "speaker": "customer",
  "text": "I need service tomorrow",
  "isFinalTurn": false,
  "turnOrder": 12,
  "startMs": 18340,
  "endMs": 19620,
  "receivedAt": "2026-02-16T21:10:45.320Z"
}
```

## Finalized event (Gateway -> API/DB/UI)

```json
{
  "type": "CALL_TRANSCRIPT_FINALIZED",
  "callId": "call_123",
  "tenantId": "tenant_001",
  "transcript": {
    "language": "en",
    "fullText": "Customer: ...\nAgent: ...",
    "segments": [
      {
        "speaker": "customer",
        "track": "inbound",
        "text": "Hello, my fridge is warm.",
        "startMs": 1200,
        "endMs": 3600,
        "confidence": 0.93
      }
    ],
    "providerMeta": {
      "provider": "assemblyai",
      "sessions": [
        { "track": "inbound", "sessionId": "aai_in_1" },
        { "track": "outbound", "sessionId": "aai_out_1" }
      ]
    }
  }
}
```

---

# 8) Схема хранения в БД Blanc

```yaml
database:
  table_calls:
    existing: true
    add_or_use_columns:
      - name: "attributes"
        type: "jsonb"
        note: "добавить/использовать ключ attributes.transcript"
  optional_table_call_transcript_segments:
    create: true
    columns:
      - "id uuid pk"
      - "call_id uuid not null"
      - "tenant_id uuid not null"
      - "seq int not null"
      - "speaker text not null"
      - "track text not null"
      - "text text not null"
      - "start_ms int"
      - "end_ms int"
      - "confidence numeric(4,3)"
      - "created_at timestamptz default now()"
    indexes:
      - "(call_id, seq)"
      - "(tenant_id, call_id)"
```

## Рекомендуемая структура `calls.attributes.transcript`

```json
{
  "provider": "assemblyai",
  "version": "v1",
  "language": "en",
  "fullText": "Customer: ...\nAgent: ...",
  "segments": [
    {
      "seq": 1,
      "speaker": "customer",
      "track": "inbound",
      "text": "...",
      "startMs": 0,
      "endMs": 1200,
      "confidence": 0.95
    }
  ],
  "meta": {
    "callSid": "CAxxxxxxxx",
    "streamSid": "MZxxxxxxxx",
    "assemblySessionIds": ["..."],
    "finalizedAt": "2026-02-16T22:00:00.000Z"
  }
}
```

---

# 9) API контракты Blanc (внутренние)

```yaml
api_contracts:
  - method: "POST"
    path: "/internal/calls/{callId}/transcript/delta"
    purpose: "ingest live turn from gateway"
    auth: "internal service token"
  - method: "POST"
    path: "/internal/calls/{callId}/transcript/finalize"
    purpose: "persist final transcript"
    auth: "internal service token"
  - method: "GET"
    path: "/api/v1/calls/{callId}/transcript"
    purpose: "read transcript for UI"
    auth: "tenant-scoped user token"
  - method: "GET"
    path: "/api/v1/calls/{callId}/transcript/stream"
    purpose: "SSE stream for live transcript"
    auth: "tenant-scoped user token"
```

---

# 10) Надежность, retry и идемпотентность

```yaml
reliability:
  ws_disconnects:
    twilio_side:
      action: "mark stream interrupted, attempt graceful finalize"
    assembly_side:
      action: "retry connection (bounded), continue buffering when possible"
  idempotency:
    key: "callId + turnOrder + track"
    rule: "ignore duplicate delta events"
  ordering:
    rule: "sort by startMs/endMs; fallback to arrival time"
  backpressure:
    max_buffer_ms: 5000
    action_on_overflow: "drop oldest partial chunks + warning metric"
```

---

# 11) Безопасность

```yaml
security:
  twilio:
    - "Проверять X-Twilio-Signature на webhook/statusCallback"
    - "Разрешить только TLS/WSS endpoint"
  secrets:
    - "AssemblyAI API key хранить только server-side"
    - "Не логировать ключи и raw PII в debug-логах"
  data_protection:
    - "Tenant isolation на уровне всех API"
    - "Контроль доступа к transcript endpoint"
  compliance:
    - "Retention policy для transcript согласно политике компании"
```

---

# 12) Observability / Метрики

```yaml
metrics:
  realtime:
    - "stt_turn_latency_ms (from media timestamp to UI push)"
    - "ws_active_streams"
    - "chunks_sent_per_minute"
    - "partial_vs_final_turn_ratio"
  quality:
    - "empty_turn_rate"
    - "avg_confidence"
    - "dropped_chunks"
  finalize:
    - "finalization_time_ms"
    - "persist_errors_count"
logging:
  required_fields:
    - "tenantId"
    - "blancCallId"
    - "callSid"
    - "streamSid"
    - "assemblySessionId"
```

---

# 13) План внедрения (итерации)

```yaml
rollout_plan:
  - phase: "Phase 1 (MVP)"
    scope:
      - "inbound_track only"
      - "single AssemblyAI session"
      - "live text + final transcript save"
    exit_criteria:
      - "успешный E2E для 20 тестовых звонков"
  - phase: "Phase 2"
    scope:
      - "both_tracks"
      - "2 parallel sessions + merge"
      - "speaker labels customer/agent"
    exit_criteria:
      - ">=95% звонков с полным двухсторонним транскриптом"
  - phase: "Phase 3"
    scope:
      - "retry tuning"
      - "quality metrics dashboards"
      - "post-call normalization/summarization (optional)"
```

---

# 14) Test plan (обязательный минимум)

```yaml
test_cases:
  - id: "E2E-001"
    name: "Happy path, single call"
    checks:
      - "live transcript идет в UI"
      - "final transcript сохранен в DB"
  - id: "E2E-002"
    name: "Dual-track transcription"
    checks:
      - "оба трека транскрибируются"
      - "сегменты верно размечены по speaker"
  - id: "ERR-001"
    name: "AssemblyAI disconnect"
    checks:
      - "service не падает"
      - "есть controlled retry + error status"
  - id: "ERR-002"
    name: "Twilio stream stopped unexpectedly"
    checks:
      - "graceful finalize"
      - "частичный transcript корректно сохранен"
  - id: "LOAD-001"
    name: "50 concurrent calls"
    checks:
      - "acceptable latency"
      - "без критических потерь chunks"
```

---

# 15) Task checklist для разработки

```yaml
implementation_checklist:
  twilio:
    - "[ ] Обновить Voice webhook -> TwiML with <Start><Stream>"
    - "[ ] Передавать blancCallId/tenantId/agentId через <Parameter>"
    - "[ ] Подключить statusCallback handler"
  gateway:
    - "[ ] Реализовать WS endpoint для Twilio Media Streams"
    - "[ ] Парсинг connected/start/media/stop"
    - "[ ] Track router + chunk buffer"
    - "[ ] Bridge к AssemblyAI WS"
  transcript_pipeline:
    - "[ ] Live publish to UI (WS/SSE)"
    - "[ ] Delta event schema validation"
    - "[ ] Finalize pipeline + DB persistence"
  db:
    - "[ ] Схема attributes.transcript согласована"
    - "[ ] (Опц.) Таблица call_transcript_segments + индексы"
  security_observability:
    - "[ ] Signature validation и secret management"
    - "[ ] Метрики/логи/алерты"
  qa_rollout:
    - "[ ] E2E + error tests"
    - "[ ] Pilot на части трафика"
    - "[ ] Full rollout"
```

---

# 16) Риски и решения

```yaml
risks:
  - risk: "Высокая задержка live-текста"
    mitigation:
      - "уменьшить chunk size (но не <50ms)"
      - "format_turns=false"
      - "оптимизировать путь WS -> UI"
  - risk: "Потеря части аудио при сетевых сбоях"
    mitigation:
      - "bounded buffering + reconnect strategy"
      - "корректная обработка stop/error"
  - risk: "Дубли/рассинхронизация сегментов"
    mitigation:
      - "идемпотентные ключи"
      - "sorting/reconciliation на finalize"
```

---

# 17) Итог

Этот документ задаёт реализуемый план для:
- онлайн-транскрибации звонков из Twilio через AssemblyAI,
- отображения текста в реальном времени в Blanc FSM,
- и сохранения финального транскрипта как атрибута звонка в БД Blanc.

Готово к декомпозиции в задачи backend/frontend/DevOps и запуску MVP.
