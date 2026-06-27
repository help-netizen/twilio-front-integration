-- =============================================================================
-- Migration 129: email → contact → timeline link + Gmail watch lifecycle columns
-- (EMAIL-TIMELINE-001). Wires inbound/outbound email into the Pulse contact
-- timeline by extending the EMAIL-001 (079) tables with a thin link:
--   • email_messages gains contact_id / timeline_id / on_timeline so buildTimeline
--     can project a contact's email onto the timeline without re-running the match.
--   • email_mailboxes gains watch_history_id / watch_expires_at for the Gmail
--     users.watch push lifecycle (real-time inbound + renewal scheduler).
-- Additive + reversible. No data backfill. The new columns are nullable (or
-- defaulted) and are NEVER filtered by the inbox queries (getThreads /
-- getMessagesByThread), so the standalone /email inbox is byte-for-behavior
-- unchanged. Idempotent: re-runnable by apply_migrations.js (whole-file query,
-- IF NOT EXISTS throughout). Touches nothing in 079.
--
-- Types: contacts.id / timelines.id are BIGINT (BIGSERIAL); email_messages.company_id
-- stays UUID (matches 079); email_mailboxes.history_id is TEXT → watch_history_id TEXT.
-- =============================================================================

-- 1. email_messages: link a message to the contact whose timeline it belongs to.
--    on_timeline = true once projected (inbound matched a contact, OR an outbound
--    send was stamped by the timeline send path).
ALTER TABLE email_messages
  ADD COLUMN IF NOT EXISTS contact_id  BIGINT REFERENCES contacts(id)  ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS timeline_id BIGINT REFERENCES timelines(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS on_timeline BOOLEAN NOT NULL DEFAULT false;

-- Read path: "give me this contact's timeline email, newest-aware, tenant-scoped".
-- Partial index keeps it small (only linked rows participate).
CREATE INDEX IF NOT EXISTS idx_email_messages_contact_timeline
  ON email_messages (company_id, contact_id, gmail_internal_at)
  WHERE contact_id IS NOT NULL;

-- 2. email_mailboxes: Gmail watch lifecycle for real-time push.
ALTER TABLE email_mailboxes
  ADD COLUMN IF NOT EXISTS watch_history_id  TEXT,
  ADD COLUMN IF NOT EXISTS watch_expires_at  TIMESTAMPTZ;
