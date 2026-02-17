-- =============================================================================
-- Migration 019: Add unread indicator fields to contacts
-- =============================================================================

ALTER TABLE contacts ADD COLUMN IF NOT EXISTS has_unread BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS last_incoming_event_at TIMESTAMPTZ;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS last_read_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_contacts_unread ON contacts(has_unread, updated_at DESC);
