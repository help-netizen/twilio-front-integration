---
document:
  id: text-polish-backend-spec-v1
  title: "Backend требования: Text Polish (Gemini Free Tier)"
  version: "1.0.0"
  status: final
  language: ru
  owner: backend-team
  updated_at: "2026-02-17"
  requirements:
    mode: "@orchestrator.md"
  goal: >
    Реализовать backend-сервис полировки клиентских сообщений:
    исправление ошибок + humanize, с сохранением фактов, низкой задержкой
    и минимальной стоимостью на Gemini API (Free Tier).
  non_goals:
    - "UI/UX фронтенда"
    - "Логика отображения на фронтенде"
    - "Отправка в внешние каналы (SMS/WhatsApp/Email), если это отдельный сервис"
  constraints:
    provider_primary: "Gemini API"
    model_default: "gemini-2.5-flash-lite"
    fast_response_required: true
    low_cost_required: true
    no_sensitive_data_in_free_tier: true
---

# Backend Spec: Text Polish (YAML + Markdown)

## 1) Функционал (что делает сервис)

Сервис принимает исходный текст клиента и возвращает улучшенный текст для отправки клиенту:

1. Исправляет орфографию, пунктуацию, грамматику.  
2. Делает тон естественным и вежливым (humanized), без «робо-стиля».  
3. Сохраняет факты исходного текста: цены, даты, время, телефоны, ссылки, номера, имена, адреса.  
4. Не добавляет новые обещания, скидки, условия, юридические обязательства.  
5. Возвращает результат максимально быстро (ориентир p95 до 2s end-to-end).

---

## 2) API Contract (YAML)

```yaml
api:
  base_path: /api/v1
  auth:
    type: bearer_jwt
    required: true

  endpoints:
    - method: POST
      path: /text/polish
      summary: Полировка одного сообщения
      request:
        content_type: application/json
        schema:
          type: object
          required: [text]
          properties:
            text:
              type: string
              minLength: 1
              maxLength: 4000
            language:
              type: string
              enum: [auto, ru, en]
              default: auto
            tone:
              type: string
              enum: [friendly_professional, neutral, formal]
              default: friendly_professional
            channel:
              type: string
              enum: [chat, sms, email_short]
              default: chat
            strict_fact_preservation:
              type: boolean
              default: true
            max_length_delta_pct:
              type: integer
              minimum: 0
              maximum: 50
              default: 20
            request_id:
              type: string
              description: Идемпотентность/трассировка
            metadata:
              type: object
              additionalProperties: true
      response_200:
        schema:
          type: object
          required:
            - polished_text
            - changed
            - detected_language
            - fallback_used
            - warnings
            - trace_id
            - provider
            - latency_ms
          properties:
            polished_text:
              type: string
            changed:
              type: boolean
            detected_language:
              type: string
              enum: [ru, en, unknown]
            fallback_used:
              type: boolean
            warnings:
              type: array
              items:
                type: string
            trace_id:
              type: string
            provider:
              type: object
              required: [name, model]
              properties:
                name:
                  type: string
                  example: gemini
                model:
                  type: string
                  example: gemini-2.5-flash-lite
            usage:
              type: object
              properties:
                input_tokens:
                  type: integer
                output_tokens:
                  type: integer
            latency_ms:
              type: integer
      errors:
        - status: 400
          code: VALIDATION_ERROR
        - status: 401
          code: UNAUTHORIZED
        - status: 403
          code: FORBIDDEN
        - status: 413
          code: PAYLOAD_TOO_LARGE
        - status: 429
          code: RATE_LIMITED
        - status: 502
          code: PROVIDER_ERROR
        - status: 504
          code: PROVIDER_TIMEOUT

    - method: GET
      path: /text/polish/health
      summary: Healthcheck
      response_200:
        schema:
          type: object
          properties:
            status: { type: string, example: ok }
            service: { type: string, example: text-polish }
            version: { type: string, example: 1.0.0 }
```

---

## 3) Бизнес-правила и инварианты качества

```yaml
quality_invariants:
  - "Нельзя терять или менять цены, даты, время, телефоны, email, URL, order/ticket IDs, имена, адреса."
  - "Нельзя добавлять новые обещания или условия."
  - "Язык ответа должен совпадать с языком входа (если не указано иное)."
  - "Длина результата должна соблюдаться в пределах max_length_delta_pct."
  - "Ответ не должен быть пустым."
  - "При ошибке провайдера сервис обязан вернуть безопасный fallback и валидный JSON."
```

---

## 4) Обработка запроса (pipeline)

```yaml
pipeline:
  - "1. Validate request schema"
  - "2. Normalize text (trim, spaces, line breaks)"
  - "3. Detect language (lightweight heuristic/model)"
  - "4. Mask critical entities (phone, email, URL, date/time, money, IDs, names optional)"
  - "5. Build strict prompt"
  - "6. Call Gemini provider adapter"
  - "7. Parse JSON response"
  - "8. Unmask entities"
  - "9. Post-validate invariants"
  - "10. Return response or fallback"
```

---

## 5) Провайдер и параметры генерации

```yaml
llm_provider:
  primary:
    name: gemini
    model: gemini-2.5-flash-lite
    config:
      temperature: 0.2
      max_output_tokens: 220
      candidate_count: 1
      response_format: json
      thinking_budget: 0
  retry_policy:
    retry_on_http: [429, 500, 502, 503, 504]
    max_retries: 2
    backoff_ms: [200, 500]
    jitter: true
  timeout:
    provider_timeout_ms: 1800
    total_timeout_ms: 2200
```

---

## 6) Промпт-контракт (server-side template)

```yaml
prompt_contract:
  system: |
    Ты редактор сообщений для клиента сервисной компании.
    Исправь ошибки и сделай текст естественным, вежливым и кратким.
    Не меняй факты: цены, даты, номера, имена, адреса, сроки.
    Не добавляй новую информацию, обещания или условия.
    Сохраняй язык исходного текста.
    Верни только JSON: {"polished_text":"string"}.
  user_template: |
    Исходный текст:
    """{{raw_text}}"""
```

---

## 7) Безопасность и приватность

```yaml
security:
  api_key_handling:
    gemini_key_server_side_only: true
    secret_manager_recommended: true
  pii:
    log_full_text_default: false
    redact_sensitive_fields_in_logs: true
    no_sensitive_data_to_free_tier: true
  transport:
    https_only: true
  access:
    auth_required: true
    rate_limit_required: true
```

---

## 8) Observability (логи, метрики, алерты)

```yaml
observability:
  logs:
    structured: true
    fields:
      - trace_id
      - request_id
      - route
      - status_code
      - provider
      - model
      - latency_ms
      - fallback_used
      - error_code
  metrics:
    counters:
      - polish_requests_total
      - polish_provider_errors_total
      - polish_fallback_total
      - polish_validation_errors_total
    histograms:
      - polish_latency_ms
    gauges:
      - polish_inflight_requests
  alerts:
    - name: high_5xx_rate
      condition: "5xx > 2% for 5m"
    - name: high_p95_latency
      condition: "p95 latency > 2500ms for 10m"
    - name: high_fallback_rate
      condition: "fallback_rate > 10% for 10m"
```

---

## 9) Конфигурация ENV

```yaml
env:
  POLISH_ENABLED: "true"
  GEMINI_API_KEY: "secret"
  GEMINI_MODEL: "gemini-2.5-flash-lite"
  POLISH_TIMEOUT_MS: "2200"
  POLISH_PROVIDER_TIMEOUT_MS: "1800"
  POLISH_MAX_INPUT_CHARS: "4000"
  POLISH_MAX_OUTPUT_TOKENS: "220"
  POLISH_TEMPERATURE: "0.2"
  POLISH_RETRY_MAX: "2"
  POLISH_RATE_LIMIT_RPM: "60"
  POLISH_LOG_FULL_TEXT: "false"
```

---

## 10) Ошибки и fallback (контракт поведения)

```yaml
error_handling:
  validation_error:
    http: 400
    action: "return error object"
  provider_timeout:
    http: 504
    action: "return fallback if policy allows"
  provider_5xx_or_429:
    http: 502
    action: "retry then fallback"
  fallback_policy:
    enabled: true
    strategy: "return original text or minimally normalized text"
    response_flag: fallback_used=true
    warnings:
      - "provider_unavailable"
```

---

## 11) Нефункциональные требования (SLO)

```yaml
slo:
  availability: ">= 99.5%"
  latency:
    p95_ms: 2000
    p99_ms: 3500
  service_overhead_without_llm_p95_ms: 120
  max_payload_chars: 4000
```

---

## 12) Тест-план (обязательный)

```yaml
tests:
  unit:
    - "request validation"
    - "mask/unmask entities"
    - "length delta checker"
    - "fallback selector"
  integration:
    - "happy path with provider"
    - "provider timeout"
    - "provider 429/5xx + retries"
    - "invalid provider JSON"
  contract:
    - "request/response schemas"
    - "error schemas"
  load:
    - "p95/p99 under target RPS"
```

---

## 13) Definition of Done

```yaml
definition_of_done:
  - "POST /api/v1/text/polish реализован и задокументирован"
  - "GET /api/v1/text/polish/health реализован"
  - "Включены retry/timeout/rate-limit"
  - "Реализован fallback и trace_id"
  - "Подключены логи/метрики/алерты"
  - "Пройдены unit/integration/contract тесты"
  - "Согласован JSON-контракт с фронтендом"
```

---

## 14) Пример успешного ответа (для фронта)

```json
{
  "polished_text": "Здравствуйте! Мастер сможет приехать завтра после 15:00. Стоимость диагностики — $89.",
  "changed": true,
  "detected_language": "ru",
  "fallback_used": false,
  "warnings": [],
  "trace_id": "trc_01HXYZ...",
  "provider": {
    "name": "gemini",
    "model": "gemini-2.5-flash-lite"
  },
  "usage": {
    "input_tokens": 132,
    "output_tokens": 68
  },
  "latency_ms": 742
}
```
