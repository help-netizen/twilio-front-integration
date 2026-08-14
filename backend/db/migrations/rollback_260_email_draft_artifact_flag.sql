-- Rollback 260: EMAIL-DRAFT-INGEST-001

DROP INDEX IF EXISTS idx_email_messages_draft_prune_candidates;

ALTER TABLE email_messages
  DROP COLUMN IF EXISTS is_draft_artifact;
