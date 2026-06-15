# Twilio-Front Integration — Schema & API Reference

> **Last updated:** 2026-02-08  
> **Base URL (prod):** `https://abc-metrics.fly.dev`  
> **Base URL (dev):** `http://localhost:3000`

---

## Database Schema

### Core Tables

#### `contacts`
| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | SERIAL | PK | Auto-increment ID |
| `phone_number` | VARCHAR(20) | UNIQUE, NOT NULL | E.164 or formatted number |
| `formatted_number` | VARCHAR(30) | | Display-formatted number |
| `display_name` | VARCHAR(255) | | Contact name |
| `metadata` | JSONB | DEFAULT `{}` | Additional data |
| `created_at` | TIMESTAMP | DEFAULT NOW() | |
| `updated_at` | TIMESTAMP | DEFAULT NOW() | Auto-updated via trigger |

#### `conversations`
| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | SERIAL | PK | |
| `contact_id` | INTEGER | FK → contacts(id) CASCADE | |
| `external_id` | VARCHAR(100) | UNIQUE, NOT NULL | Phone number as ID |
| `subject` | VARCHAR(255) | | e.g. "Calls with +1 (508) 514-0320" |
| `status` | VARCHAR(50) | DEFAULT `'active'` | |
| `last_message_at` | TIMESTAMP | | Latest call timestamp |
| `metadata` | JSONB | DEFAULT `{}` | |
| `created_at` | TIMESTAMP | DEFAULT NOW() | |
| `updated_at` | TIMESTAMP | DEFAULT NOW() | Auto-updated via trigger |

#### `messages` (individual calls)
| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | SERIAL | PK | |
| `conversation_id` | INTEGER | FK → conversations(id) CASCADE | |
| `twilio_sid` | VARCHAR(100) | UNIQUE, NOT NULL | Twilio Call SID (CA...) |
| `direction` | VARCHAR(50) | NOT NULL | `inbound`, `outbound`, `internal`, `external` |
| `status` | VARCHAR(50) | NOT NULL | `completed`, `no-answer`, `busy`, `canceled`, `failed`, `ringing`, `in-progress` |
| `from_number` | VARCHAR(20) | NOT NULL | Caller number or SIP URI |
| `to_number` | VARCHAR(20) | NOT NULL | Called number or SIP URI |
| `duration` | INTEGER | | Seconds |
| `price` | DECIMAL(10,4) | | Call cost |
| `price_unit` | VARCHAR(10) | | e.g. `USD` |
| `start_time` | TIMESTAMP | | |
| `end_time` | TIMESTAMP | | |
| `recording_url` | TEXT | | |
| `parent_call_sid` | VARCHAR(100) | | Links child → parent call |
| `metadata` | JSONB | DEFAULT `{}` | See metadata schema below |
| `created_at` | TIMESTAMP | DEFAULT NOW() | |
| `updated_at` | TIMESTAMPTZ | DEFAULT NOW() | *(migration 004)* |
| `last_event_time` | TIMESTAMPTZ | | Guards against out-of-order events |
| `is_final` | BOOLEAN | DEFAULT FALSE | Terminal status reached |
| `finalized_at` | TIMESTAMPTZ | | When call reached final status |
| `sync_state` | TEXT | DEFAULT `'active'` | `active` → `frozen` |

**Message metadata JSONB:**
```json
{
  "answered_by": "human|machine|null",
  "queue_time": 5,
  "twilio_direction": "outbound-dial",
  "twilio_status": "completed",
  "actual_direction": "inbound",
  "display_status": "completed",
  "twilioDirection": "outbound-dial",
  "duration": 29,
  "hasParent": false,
  "from": "+15085140320",
  "to": "sip:dispatcher@abchomes.sip.us1.twilio.com"
}
```

---

### Infrastructure Tables

#### `twilio_webhook_inbox`
Reliable webhook ingestion queue with deduplication and retry.

| Column | Type | Description |
|--------|------|-------------|
| `id` | BIGSERIAL PK | |
| `source` | TEXT | `twilio_voice`, `twilio_recording` |
| `event_type` | TEXT | `call-inbound`, `call-status`, `recording-complete`, `dial-action` |
| `call_sid` | VARCHAR(100) | |
| `recording_sid` | VARCHAR(100) | |
| `dedupe_key` | VARCHAR(255) UNIQUE | e.g. `call:CA123:completed:1234567890` |
| `payload` | JSONB | Full Twilio webhook payload |
| `received_at` | TIMESTAMPTZ | |
| `processed_at` | TIMESTAMPTZ | |
| `processing_status` | TEXT | `pending` → `processing` → `completed` / `failed` → `dead_letter` |
| `error` | TEXT | Error message if failed |
| `retry_count` | INTEGER | |

#### `call_events`
Immutable event log for call lifecycle audit.

| Column | Type | Description |
|--------|------|-------------|
| `id` | BIGSERIAL PK | |
| `call_sid` | VARCHAR(100) | |
| `event_type` | TEXT | `call.created`, `call.status_changed`, `recording.ready` |
| `event_status` | TEXT | `queued`, `ringing`, `completed`, etc. |
| `event_time` | TIMESTAMPTZ | From Twilio timestamp |
| `created_at` | TIMESTAMPTZ | When we recorded it |
| `source` | TEXT | `webhook`, `reconcile_hot`, `reconcile_warm`, `reconcile_cold` |
| `payload` | JSONB | |

#### `sync_state`
Reconciliation job cursors.

| Column | Type | Description |
|--------|------|-------------|
| `job_name` | TEXT PK | `reconcile_hot`, `reconcile_warm`, `reconcile_cold` |
| `cursor` | JSONB | `{ "last_call_sid": "CA123", "last_updated_at": "..." }` |
| `last_success_at` | TIMESTAMPTZ | |
| `last_error_at` | TIMESTAMPTZ | |
| `last_error` | TEXT | |
| `updated_at` | TIMESTAMPTZ | |

---

## REST API Endpoints

### Health

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/health` | Health check, returns `{ status: "healthy" }` |

### Conversations

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/conversations` | List conversations (paginated) |
| `GET` | `/api/conversations/active` | Get currently active calls |
| `GET` | `/api/conversations/:id` | Get single conversation details |
| `GET` | `/api/conversations/:id/messages` | Get all calls in a conversation |

#### `GET /api/conversations`

**Query params:**
| Param | Default | Description |
|-------|---------|-------------|
| `page` | 1 | Page number |
| `limit` | 20 | Per page |

**Response:**
```json
{
  "conversations": [
    {
      "id": "42",
      "subject": "Calls with +1 (508) 514-0320",
      "status": "active",
      "last_message": {
        "subject": "📞 Incoming Call - 29s",
        "body": "**From:** +1 (508) 514-0320\n**To:** ...",
        "created_at": "2026-02-08T06:11:00Z",
        "direction": "inbound",
        "call_status": "completed"
      },
      "contact": {
        "display_name": "+1 (508) 514-0320",
        "phone_number": "+1 (508) 514-0320"
      },
      "created_at": "...",
      "updated_at": "..."
    }
  ],
  "total": 9,
  "page": 1,
  "limit": 20
}
```

#### `GET /api/conversations/:id/messages`

**Response:**
```json
{
  "messages": [
    {
      "id": "123",
      "subject": "📞 Incoming Call - 29s",
      "body": "**From:** ...\n**To:** ...\n**Duration:** ...",
      "created_at": "2026-02-08T06:11:00Z",
      "direction": "inbound",
      "call_status": "completed",
      "duration": 29,
      "metadata": { ... }
    }
  ]
}
```

> **Note:** Parent-child calls are merged in the response. Child calls inherit parent's duration as `total_duration`, child's duration becomes `talk_time`, and `wait_time` is calculated.

### Sync

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/sync/today` | Sync calls from last 3 days |
| `POST` | `/api/sync/recent` | Sync calls from last hour |

**Response (`POST /api/sync/today`):**
```json
{
  "success": true,
  "message": "Synced 117 new calls from last 3 days",
  "synced": 117,
  "skipped": 35,
  "total": 239
}
```

---

## Twilio Webhook Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/webhooks/twilio/voice-inbound` | New call arrives (returns TwiML) |
| `POST` | `/webhooks/twilio/voice-status` | Call status updates |
| `POST` | `/webhooks/twilio/recording-status` | Recording completed |
| `POST` | `/webhooks/twilio/dial-action` | `<Dial>` action callback |

### `POST /webhooks/twilio/voice-inbound`

Called when a new call arrives. Returns TwiML to route the call.

**Inbound (PSTN → SIP):**
```xml
<Response>
    <Dial timeout="60" action="/webhooks/twilio/dial-action" method="POST">
        <Sip statusCallback="/webhooks/twilio/voice-status"
             statusCallbackEvent="initiated ringing answered completed"
             statusCallbackMethod="POST">sip:dispatcher@abchomes.sip.us1.twilio.com</Sip>
    </Dial>
</Response>
```

**Outbound (SIP → PSTN):**
```xml
<Response>
    <Dial timeout="60" callerId="+16175006181" action="/webhooks/twilio/dial-action" method="POST">
        <Number statusCallback="/webhooks/twilio/voice-status"
                statusCallbackEvent="initiated ringing answered completed"
                statusCallbackMethod="POST">+15085140320</Number>
    </Dial>
</Response>
```

### `POST /webhooks/twilio/voice-status`

Receives status callbacks (`initiated`, `ringing`, `answered`, `completed`). Stores events in `twilio_webhook_inbox` for async processing by the inbox worker.

### `POST /webhooks/twilio/dial-action`

Called after `<Dial>` completes. Receives `DialCallStatus` (`completed`, `no-answer`, `busy`, `failed`, `canceled`). Stores in inbox for final status processing.

---

## SSE (Server-Sent Events)

### `GET /events/calls`

Real-time event stream for call updates. Frontend connects on mount.

**Event types:**

| Event | Description |
|-------|-------------|
| `connected` | Initial connection confirmation |
| `call.created` | New call detected |
| `call.updated` | Call status changed |
| `keepalive` | Heartbeat (every 30s) |

**Event payload:**
```json
{
  "event": "call.updated",
  "data": {
    "callSid": "CA27d559117edb45aac8a0270ac2f97b10",
    "status": "completed",
    "direction": "inbound",
    "from": "+15085140320",
    "to": "+16175006181",
    "duration": 29,
    "timestamp": "2026-02-08T06:11:30Z"
  }
}
```

### `GET /events/stats`

SSE service statistics (number of connected clients, etc.).

---

## Call Processing Logic

### CallProcessor Microservice

Located at `backend/src/services/callProcessor.js`. Centralized call processing logic used by both real-time webhooks and historical sync.

**Direction Detection Priority:**
1. **SIP-based** (webhook data): `FROM external + TO SIP` → inbound, `FROM SIP + TO external` → outbound
2. **Owned-number fallback** (API sync data): `FROM owned + TO external` → outbound, `FROM external + TO owned` → inbound
3. **Both SIP** → internal
4. **Can't determine** → external

**Sync Filters** (applied in `twilioSync.js`):
- Skip `direction === 'internal'` (SIP-to-SIP routing calls)
- Skip calls with no valid external phone number
- Skip malformed phone numbers (not 10-11 digits)
- Skip calls with no `start_time` (prevents epoch dates)

**Owned Phone Numbers:**
Configured via `OWNED_PHONE_NUMBERS` env var:
```
OWNED_PHONE_NUMBERS=+16175006181
```

---

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `DATABASE_URL` | ✅ | PostgreSQL connection string |
| `TWILIO_ACCOUNT_SID` | ✅ | Twilio Account SID |
| `TWILIO_AUTH_TOKEN` | ✅ | Twilio Auth Token |
| `OWNED_PHONE_NUMBERS` | ✅ | Comma-separated owned numbers |
| `WEBHOOK_BASE_URL` | ✅ (prod) | `https://abc-metrics.fly.dev` |
| `SIP_USER` | | SIP endpoint user (default: `dispatcher`) |
| `SIP_DOMAIN` | | SIP domain (default: `abchomes.sip.us1.twilio.com`) |
| `PORT` | | Server port (default: `3000`) |
| `NODE_ENV` | | `production` or `development` |

---

## Twilio Configuration

| Setting | Value |
|---------|-------|
| Phone Number | `+16175006181` |
| Voice URL | `https://abc-metrics.fly.dev/webhooks/twilio/voice-inbound` |
| SIP Domain | `abchomes.sip.twilio.com` |
| SIP Call Control URL | `https://abc-metrics.fly.dev/webhooks/twilio/voice-inbound` |
