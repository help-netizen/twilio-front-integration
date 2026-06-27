-- =============================================================================
-- Rollback 129: email → contact → timeline link + Gmail watch lifecycle columns
-- Drops exactly what 129_email_timeline_link.sql added. Idempotent (IF EXISTS).
-- Touches nothing in 079 — only the columns/index introduced by 129.
-- =============================================================================

-- Index first (it depends on email_messages.contact_id).
DROP INDEX IF EXISTS idx_email_messages_contact_timeline;

-- email_messages link columns.
ALTER TABLE email_messages
  DROP COLUMN IF EXISTS contact_id,
  DROP COLUMN IF EXISTS timeline_id,
  DROP COLUMN IF EXISTS on_timeline;

-- email_mailboxes watch columns.
ALTER TABLE email_mailboxes
  DROP COLUMN IF EXISTS watch_history_id,
  DROP COLUMN IF EXISTS watch_expires_at;
