-- =============================================================================
-- Twilio CRM — Clean Slate v3 Schema
-- PostgreSQL 15+
-- 
-- Replaces the old contacts/conversations/messages model with a
-- calls-first architecture: calls = snapshot, call_events = history,
-- recordings/transcripts = media layer, webhook_inbox = reliability.
--
-- Run order: contacts → calls → recordings → transcripts → call_events
--            → webhook_inbox → sync_state → triggers
-- =============================================================================

-- Drop legacy tables
DROP TABLE IF EXISTS messages CASCADE;
DROP TABLE IF EXISTS conversations CASCADE;
DROP TABLE IF EXISTS call_events CASCADE;
DROP TABLE IF EXISTS twilio_webhook_inbox CASCADE;
DROP TABLE IF EXISTS sync_state CASCADE;
DROP TABLE IF EXISTS contacts CASCADE;
-- New v3 tables (drop if re-running)
DROP TABLE IF EXISTS transcripts CASCADE;
DROP TABLE IF EXISTS recordings CASCADE;
DROP TABLE IF EXISTS calls CASCADE;

-- =============================================================================
-- 1. contacts — Клиенты и идентификаторы
-- =============================================================================
CREATE TABLE contacts (
  id          BIGSERIAL PRIMARY KEY,
  full_name   TEXT,
  phone_e164  TEXT,
  email       TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX uq_contacts_phone ON contacts(phone_e164)
  WHERE phone_e164 IS NOT NULL;
CREATE UNIQUE INDEX uq_contacts_email ON contacts(email)
  WHERE email IS NOT NULL;

COMMENT ON TABLE contacts IS 'Клиенты и их контактные идентификаторы';

-- =============================================================================
-- 2. calls — Snapshot состояния звонка (1 строка на CallSid)
-- =============================================================================
CREATE TABLE calls (
  id                BIGSERIAL PRIMARY KEY,
  call_sid          VARCHAR(100) NOT NULL UNIQUE,
  parent_call_sid   VARCHAR(100),
  contact_id        BIGINT REFERENCES contacts(id),
  direction         VARCHAR(20) NOT NULL,          -- inbound | outbound-api | outbound-dial
  from_number       TEXT,
  to_number         TEXT,
  status            VARCHAR(30) NOT NULL,          -- queued|initiated|ringing|in-progress|completed|busy|failed|no-answer|canceled
  is_final          BOOLEAN NOT NULL DEFAULT false,
  started_at        TIMESTAMPTZ,
  answered_at       TIMESTAMPTZ,
  ended_at          TIMESTAMPTZ,
  duration_sec      INTEGER,
  price             NUMERIC(10,4),
  price_unit        VARCHAR(10),
  last_event_time   TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  raw_last_payload  JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX idx_calls_status_updated ON calls(status, updated_at DESC);
CREATE INDEX idx_calls_contact_started ON calls(contact_id, started_at DESC);
CREATE INDEX idx_calls_parent ON calls(parent_call_sid)
  WHERE parent_call_sid IS NOT NULL;
CREATE INDEX idx_calls_not_final ON calls(status, started_at DESC)
  WHERE is_final = false;

COMMENT ON TABLE calls IS 'Snapshot состояния звонка — 1 строка на CallSid, обновляется по событиям';
COMMENT ON COLUMN calls.is_final IS 'true когда звонок в терминальном статусе (completed/busy/failed/no-answer/canceled)';
COMMENT ON COLUMN calls.last_event_time IS 'Guard: event_time >= last_event_time для защиты от out-of-order';

-- =============================================================================
-- 3. recordings — Записи разговоров (1+ на call_sid)
-- =============================================================================
CREATE TABLE recordings (
  id              BIGSERIAL PRIMARY KEY,
  recording_sid   VARCHAR(100) NOT NULL UNIQUE,
  call_sid        VARCHAR(100) NOT NULL REFERENCES calls(call_sid),
  status          VARCHAR(30) NOT NULL,            -- in-progress|completed|absent|failed
  recording_url   TEXT,
  duration_sec    INTEGER,
  channels        SMALLINT,
  track           VARCHAR(20),
  source          VARCHAR(50),
  started_at      TIMESTAMPTZ,
  completed_at    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  raw_payload     JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX idx_recordings_call ON recordings(call_sid);
CREATE INDEX idx_recordings_status ON recordings(status, updated_at DESC);

COMMENT ON TABLE recordings IS 'Записи разговоров — может быть несколько на один звонок';

-- =============================================================================
-- 4. transcripts — Транскрипции (post-call и/или realtime)
-- =============================================================================
CREATE TABLE transcripts (
  id                  BIGSERIAL PRIMARY KEY,
  transcription_sid   VARCHAR(100) UNIQUE,
  call_sid            VARCHAR(100) REFERENCES calls(call_sid),
  recording_sid       VARCHAR(100) REFERENCES recordings(recording_sid),
  mode                VARCHAR(20) NOT NULL DEFAULT 'post-call', -- post-call|realtime
  status              VARCHAR(30) NOT NULL,        -- in-progress|completed|failed|stopped
  language_code       VARCHAR(20),
  confidence          NUMERIC(5,4),
  text                TEXT,
  is_final            BOOLEAN NOT NULL DEFAULT true,
  sequence_no         BIGINT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  raw_payload         JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX idx_transcripts_call ON transcripts(call_sid);
CREATE INDEX idx_transcripts_recording ON transcripts(recording_sid);
CREATE INDEX idx_transcripts_status ON transcripts(status, updated_at DESC);

COMMENT ON TABLE transcripts IS 'Транскрипции голосовых записей — post-call или realtime';

-- =============================================================================
-- 5. call_events — Immutable история событий
-- =============================================================================
CREATE TABLE call_events (
  id          BIGSERIAL PRIMARY KEY,
  call_sid    VARCHAR(100) NOT NULL,
  event_type  VARCHAR(50) NOT NULL,                -- call.status_changed|recording.updated|transcript.updated|dial.action
  event_time  TIMESTAMPTZ NOT NULL,
  payload     JSONB NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_call_events_sid_time ON call_events(call_sid, event_time DESC);
CREATE INDEX idx_call_events_type_time ON call_events(event_type, event_time DESC);

COMMENT ON TABLE call_events IS 'Immutable event log — never modified, only appended';

-- =============================================================================
-- 6. webhook_inbox — Дедупликация и надежная обработка webhook
-- =============================================================================
CREATE TABLE webhook_inbox (
  id                  BIGSERIAL PRIMARY KEY,
  provider            TEXT NOT NULL DEFAULT 'twilio',
  event_key           TEXT NOT NULL UNIQUE,
  source              VARCHAR(30) NOT NULL,        -- voice|dial|recording|transcription
  event_type          VARCHAR(50) NOT NULL,
  event_time          TIMESTAMPTZ,
  call_sid            VARCHAR(100),
  recording_sid       VARCHAR(100),
  transcription_sid   VARCHAR(100),
  payload             JSONB NOT NULL,
  headers             JSONB NOT NULL DEFAULT '{}'::jsonb,
  status              VARCHAR(20) NOT NULL DEFAULT 'received', -- received|processed|failed|dead
  attempts            INTEGER NOT NULL DEFAULT 0,
  error_text          TEXT,
  received_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at        TIMESTAMPTZ
);

CREATE INDEX idx_inbox_status_received ON webhook_inbox(status, received_at);
CREATE INDEX idx_inbox_call_received ON webhook_inbox(call_sid, received_at DESC);
CREATE INDEX idx_inbox_pending ON webhook_inbox(received_at)
  WHERE status = 'received';

COMMENT ON TABLE webhook_inbox IS 'Дедупликация и retry вебхуков — event_key обеспечивает idempotency';

-- =============================================================================
-- 7. sync_state — Курсоры reconcile-джоб
-- =============================================================================
CREATE TABLE sync_state (
  job_name        TEXT PRIMARY KEY,
  cursor          JSONB NOT NULL DEFAULT '{}'::jsonb,
  last_success_at TIMESTAMPTZ,
  last_error_at   TIMESTAMPTZ,
  last_error      TEXT,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE sync_state IS 'Reconcile job cursors — tracks last processed position for each job';

-- =============================================================================
-- Trigger: auto-update updated_at
-- =============================================================================
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_contacts_updated_at BEFORE UPDATE ON contacts
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER trg_calls_updated_at BEFORE UPDATE ON calls
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER trg_recordings_updated_at BEFORE UPDATE ON recordings
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER trg_transcripts_updated_at BEFORE UPDATE ON transcripts
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER trg_sync_state_updated_at BEFORE UPDATE ON sync_state
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- =============================================================================
-- Done
-- =============================================================================
