-- =============================================================================
-- Migration 017: Create SMS Conversations tables
-- Twilio Conversations API integration
-- =============================================================================

-- 1. sms_conversations
CREATE TABLE IF NOT EXISTS sms_conversations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  twilio_conversation_sid TEXT UNIQUE,
  service_sid TEXT,
  channel_type TEXT NOT NULL DEFAULT 'sms',
  state TEXT NOT NULL DEFAULT 'active',
  customer_e164 TEXT,
  proxy_e164 TEXT,
  friendly_name TEXT,
  attributes JSONB NOT NULL DEFAULT '{}'::jsonb,
  source TEXT NOT NULL DEFAULT 'twilio',
  first_message_at TIMESTAMPTZ,
  last_message_at TIMESTAMPTZ,
  last_message_preview TEXT,
  last_message_direction TEXT,
  closed_at TIMESTAMPTZ,
  company_id UUID REFERENCES companies(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sms_conv_last_message_at ON sms_conversations(last_message_at DESC);
CREATE INDEX IF NOT EXISTS idx_sms_conv_customer_proxy ON sms_conversations(customer_e164, proxy_e164);
CREATE INDEX IF NOT EXISTS idx_sms_conv_state ON sms_conversations(state);
CREATE INDEX IF NOT EXISTS idx_sms_conv_company ON sms_conversations(company_id);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_sms_active_pair
ON sms_conversations(customer_e164, proxy_e164)
WHERE state = 'active' AND customer_e164 IS NOT NULL AND proxy_e164 IS NOT NULL;

-- 2. sms_messages
CREATE TABLE IF NOT EXISTS sms_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  twilio_message_sid TEXT UNIQUE,
  conversation_id UUID NOT NULL REFERENCES sms_conversations(id) ON DELETE CASCADE,
  conversation_sid TEXT,
  author TEXT,
  author_type TEXT NOT NULL DEFAULT 'external',
  direction TEXT NOT NULL,
  transport TEXT NOT NULL DEFAULT 'sms',
  body TEXT,
  attributes JSONB NOT NULL DEFAULT '{}'::jsonb,
  delivery_status TEXT,
  error_code INTEGER,
  error_message TEXT,
  index_in_conversation BIGINT,
  date_created_remote TIMESTAMPTZ,
  date_updated_remote TIMESTAMPTZ,
  date_sent_remote TIMESTAMPTZ,
  company_id UUID REFERENCES companies(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sms_msg_conversation_created ON sms_messages(conversation_id, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_sms_msg_delivery_status ON sms_messages(delivery_status);
CREATE INDEX IF NOT EXISTS idx_sms_msg_author ON sms_messages(author);

-- 3. sms_media
CREATE TABLE IF NOT EXISTS sms_media (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id UUID NOT NULL REFERENCES sms_messages(id) ON DELETE CASCADE,
  twilio_media_sid TEXT UNIQUE,
  category TEXT NOT NULL DEFAULT 'media',
  filename TEXT,
  content_type TEXT,
  size_bytes BIGINT,
  preview_kind TEXT,
  storage_provider TEXT NOT NULL DEFAULT 'twilio',
  temporary_url TEXT,
  temporary_url_expires_at TIMESTAMPTZ,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sms_media_message ON sms_media(message_id);
CREATE INDEX IF NOT EXISTS idx_sms_media_expires ON sms_media(temporary_url_expires_at);

-- 4. sms_events (raw webhook log)
CREATE TABLE IF NOT EXISTS sms_events (
  id BIGSERIAL PRIMARY KEY,
  provider TEXT NOT NULL DEFAULT 'twilio_conversations',
  event_type TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  twilio_request_sid TEXT,
  conversation_sid TEXT,
  message_sid TEXT,
  participant_sid TEXT,
  webhook_url TEXT,
  headers JSONB NOT NULL DEFAULT '{}'::jsonb,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  processing_status TEXT NOT NULL DEFAULT 'received',
  processing_error TEXT,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_sms_events_idempotency ON sms_events(idempotency_key);
CREATE INDEX IF NOT EXISTS idx_sms_events_conv_sid ON sms_events(conversation_sid);
CREATE INDEX IF NOT EXISTS idx_sms_events_msg_sid ON sms_events(message_sid);
CREATE INDEX IF NOT EXISTS idx_sms_events_status ON sms_events(processing_status, received_at DESC);

-- Triggers: auto-update updated_at
CREATE OR REPLACE TRIGGER trg_sms_conv_updated BEFORE UPDATE ON sms_conversations
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE OR REPLACE TRIGGER trg_sms_msg_updated BEFORE UPDATE ON sms_messages
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE OR REPLACE TRIGGER trg_sms_media_updated BEFORE UPDATE ON sms_media
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
