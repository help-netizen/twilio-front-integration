-- =============================================================================
-- Migration 261: EMAIL-OCCURRED-AT-001 — one canonical email event timestamp
--
-- Migration number verified against origin/master on 2026-08-14: 260 is the
-- highest occupied number. gmail_internal_at remains the provider's raw fact;
-- occurred_at is the absolute instant used by every product projection/order.
-- =============================================================================

ALTER TABLE email_messages
  ADD COLUMN IF NOT EXISTS occurred_at TIMESTAMPTZ NOT NULL DEFAULT now();

UPDATE email_messages
SET occurred_at = CASE
  WHEN gmail_internal_at IS NULL THEN created_at
  WHEN direction = 'inbound' THEN gmail_internal_at
  WHEN created_at - gmail_internal_at <= INTERVAL '10 minutes' THEN gmail_internal_at
  WHEN created_at - gmail_internal_at <= INTERVAL '24 hours' THEN created_at
  ELSE gmail_internal_at
END;

-- The default is a deploy-compatibility contract: migrations run before the new
-- application container, so the old poller may omit occurred_at for several
-- minutes. Reassert it when this file is exercised against a test/local schema
-- where an earlier migration draft already created the column.
ALTER TABLE email_messages
  ALTER COLUMN occurred_at SET DEFAULT now();

COMMENT ON COLUMN email_messages.occurred_at IS
  'EMAIL-OCCURRED-AT-001: canonical absolute message event instant. Provider gmail_internal_at remains raw evidence; all ordering, pagination, aggregates, and display projections use occurred_at.';

CREATE INDEX IF NOT EXISTS idx_email_messages_thread_occurred
  ON email_messages (thread_id, occurred_at, id);

CREATE INDEX IF NOT EXISTS idx_email_messages_contact_occurred
  ON email_messages (company_id, contact_id, occurred_at, id)
  WHERE contact_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_email_messages_timeline_occurred
  ON email_messages (company_id, timeline_id, occurred_at, id)
  WHERE timeline_id IS NOT NULL;

UPDATE email_threads thread
SET last_message_at = (
  SELECT MAX(message.occurred_at)
  FROM email_messages message
  WHERE message.company_id = thread.company_id
    AND message.thread_id = thread.id
    AND message.is_draft_artifact = false
)
WHERE EXISTS (
  SELECT 1
  FROM email_messages message
  WHERE message.company_id = thread.company_id
    AND message.thread_id = thread.id
    AND message.is_draft_artifact = false
);
