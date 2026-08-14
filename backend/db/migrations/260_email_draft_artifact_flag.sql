-- =============================================================================
-- Migration 260: EMAIL-DRAFT-INGEST-001 — reversible Gmail draft artifact flag
--
-- Migration number verified against origin/master on 2026-08-14: 259 was the
-- highest occupied number. Existing rows remain visible until the dry-run-first
-- prune CLI classifies them and --apply marks only Gmail 404s.
-- =============================================================================

ALTER TABLE email_messages
  ADD COLUMN IF NOT EXISTS is_draft_artifact BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN email_messages.is_draft_artifact IS
  'EMAIL-DRAFT-INGEST-001: reversible marker for an ingested Gmail autosave whose provider_message_id no longer exists; read projections exclude marked rows.';

CREATE INDEX IF NOT EXISTS idx_email_messages_draft_prune_candidates
  ON email_messages (company_id, mailbox_id, id)
  WHERE direction = 'outbound' AND is_draft_artifact = false;
