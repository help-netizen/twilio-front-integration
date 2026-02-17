---
title: "Twilio → AssemblyAI → Blanc — Execution Backlog (YAML+Markdown)"
version: "1.0"
date: "2026-02-16"
---

# Sprint-ready backlog

## EPIC-1: Twilio Media Stream Ingestion
```yaml
epic: "EPIC-1"
goal: "Стабильно принимать аудиострим из Twilio"
tasks:
  - id: "T1.1"
    title: "Voice webhook + TwiML with Start/Stream"
    estimate: "0.5d"
  - id: "T1.2"
    title: "WS endpoint /ws/twilio (connected/start/media/stop)"
    estimate: "1.0d"
  - id: "T1.3"
    title: "statusCallback webhook (stream-started/stopped/error)"
    estimate: "0.5d"
acceptance:
  - "CallSid/StreamSid/Parameters сохраняются в runtime context"
```

## EPIC-2: Bridge to AssemblyAI Streaming
```yaml
epic: "EPIC-2"
goal: "Передавать Twilio audio chunks в AssemblyAI WS и получать Turn events"
tasks:
  - id: "T2.1"
    title: "AssemblyAI WS client (v3)"
    estimate: "1.0d"
  - id: "T2.2"
    title: "Track router + 1/2 session strategy"
    estimate: "1.0d"
  - id: "T2.3"
    title: "Chunk buffer 50-1000ms"
    estimate: "0.5d"
acceptance:
  - "Поступают Begin/Turn/Termination"
  - "Нет closure по invalid chunk size"
```

## EPIC-3: Live transcript in Blanc UI
```yaml
epic: "EPIC-3"
goal: "Показывать текст в карточке звонка в реальном времени"
tasks:
  - id: "T3.1"
    title: "Internal event bus CALL_TRANSCRIPT_DELTA"
    estimate: "0.5d"
  - id: "T3.2"
    title: "SSE/WS endpoint для UI stream"
    estimate: "0.5d"
  - id: "T3.3"
    title: "UI component Transcript Feed (speaker + text + final marker)"
    estimate: "1.0d"
acceptance:
  - "Live transcript виден во время звонка"
```

## EPIC-4: Finalization + DB persistence
```yaml
epic: "EPIC-4"
goal: "Сохранять итоговый transcript как атрибут звонка"
tasks:
  - id: "T4.1"
    title: "Finalize pipeline on stop/termination"
    estimate: "0.5d"
  - id: "T4.2"
    title: "Persist to calls.attributes.transcript (jsonb)"
    estimate: "0.5d"
  - id: "T4.3"
    title: "Optional segments table + indexes"
    estimate: "0.5d"
acceptance:
  - "После звонка transcript доступен в API/UI"
```

## EPIC-5: Security + Reliability + Observability
```yaml
epic: "EPIC-5"
goal: "Продакшн-готовность"
tasks:
  - id: "T5.1"
    title: "X-Twilio-Signature validation"
    estimate: "0.5d"
  - id: "T5.2"
    title: "Idempotency + dedup + ordering"
    estimate: "0.5d"
  - id: "T5.3"
    title: "Metrics/logging/alerts"
    estimate: "0.5d"
  - id: "T5.4"
    title: "Load test 50 concurrent calls"
    estimate: "0.5d"
acceptance:
  - "Ошибки не приводят к падению сервиса"
  - "Есть трассировка callSid↔streamSid↔assemblySessionId"
```

# Rollout policy
```yaml
rollout:
  stage_1:
    traffic: "10%"
    mode: "inbound_only"
  stage_2:
    traffic: "50%"
    mode: "both_tracks"
  stage_3:
    traffic: "100%"
    mode: "both_tracks + retries tuned"
rollback:
  trigger:
    - "error_rate > 2%"
    - "median_latency > 4s"
  action: "switch off stream in TwiML for impacted tenant"
```
