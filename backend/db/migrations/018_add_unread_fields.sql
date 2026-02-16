-- =============================================================================
-- Migration 018: Add unread indicator fields to sms_conversations
-- =============================================================================

ALTER TABLE sms_conversations ADD COLUMN IF NOT EXISTS has_unread BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE sms_conversations ADD COLUMN IF NOT EXISTS last_read_at TIMESTAMPTZ;
ALTER TABLE sms_conversations ADD COLUMN IF NOT EXISTS last_incoming_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_sms_conv_unread ON sms_conversations(has_unread, last_message_at DESC);
