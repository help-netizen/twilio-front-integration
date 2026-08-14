-- Rollback 261: EMAIL-OCCURRED-AT-001

UPDATE email_threads thread
SET last_message_at = (
  SELECT MAX(COALESCE(message.gmail_internal_at, message.created_at))
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

DROP INDEX IF EXISTS idx_email_messages_timeline_occurred;
DROP INDEX IF EXISTS idx_email_messages_contact_occurred;
DROP INDEX IF EXISTS idx_email_messages_thread_occurred;

ALTER TABLE email_messages
  DROP COLUMN IF EXISTS occurred_at;
