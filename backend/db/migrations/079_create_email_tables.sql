-- =============================================================================
-- Migration 079: Create email tables for EMAIL-001
-- Gmail Shared Mailbox + Email Workspace
-- =============================================================================

-- 1. email_mailboxes — one shared provider mailbox per company
CREATE TABLE IF NOT EXISTS email_mailboxes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider = 'gmail'),
  email_address TEXT NOT NULL,
  display_name TEXT,
  provider_account_id TEXT,
  status TEXT NOT NULL DEFAULT 'connected'
    CHECK (status IN ('connected', 'reconnect_required', 'sync_error', 'disconnected')),
  access_token_encrypted TEXT,
  refresh_token_encrypted TEXT,
  token_expires_at TIMESTAMPTZ,
  history_id TEXT,
  last_synced_at TIMESTAMPTZ,
  last_sync_status TEXT DEFAULT 'ok'
    CHECK (last_sync_status IN ('ok', 'running', 'error', 'backfill_required')),
  last_sync_error TEXT,
  created_by TEXT,
  updated_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- V1 invariant: max one Gmail mailbox per company
CREATE UNIQUE INDEX IF NOT EXISTS uniq_email_mailbox_company_provider
  ON email_mailboxes(company_id, provider);

CREATE INDEX IF NOT EXISTS idx_email_mailbox_status_sync
  ON email_mailboxes(status, last_synced_at);

-- 2. email_threads — local searchable thread index
CREATE TABLE IF NOT EXISTS email_threads (
  id BIGSERIAL PRIMARY KEY,
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  mailbox_id UUID NOT NULL REFERENCES email_mailboxes(id) ON DELETE CASCADE,
  provider_thread_id TEXT NOT NULL,
  subject TEXT,
  participants_json JSONB DEFAULT '[]'::jsonb,
  last_message_at TIMESTAMPTZ,
  last_message_preview TEXT,
  last_message_direction TEXT,
  last_message_from TEXT,
  unread_count INTEGER NOT NULL DEFAULT 0,
  has_attachments BOOLEAN NOT NULL DEFAULT false,
  message_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_email_thread_company_provider
  ON email_threads(company_id, provider_thread_id);

CREATE INDEX IF NOT EXISTS idx_email_threads_company_last_msg
  ON email_threads(company_id, last_message_at DESC);

CREATE INDEX IF NOT EXISTS idx_email_threads_company_unread
  ON email_threads(company_id, unread_count);

CREATE INDEX IF NOT EXISTS idx_email_threads_company_attachments
  ON email_threads(company_id, has_attachments);

CREATE INDEX IF NOT EXISTS idx_email_threads_mailbox
  ON email_threads(mailbox_id);

-- 3. email_messages — individual messages inside threads
CREATE TABLE IF NOT EXISTS email_messages (
  id BIGSERIAL PRIMARY KEY,
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  mailbox_id UUID NOT NULL REFERENCES email_mailboxes(id) ON DELETE CASCADE,
  thread_id BIGINT NOT NULL REFERENCES email_threads(id) ON DELETE CASCADE,
  provider_message_id TEXT NOT NULL,
  provider_thread_id TEXT,
  message_id_header TEXT,
  in_reply_to_header TEXT,
  references_header TEXT,
  direction TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  from_name TEXT,
  from_email TEXT,
  to_recipients_json JSONB DEFAULT '[]'::jsonb,
  cc_recipients_json JSONB DEFAULT '[]'::jsonb,
  subject TEXT,
  snippet TEXT,
  body_text TEXT,
  body_html TEXT,
  has_attachments BOOLEAN NOT NULL DEFAULT false,
  gmail_internal_at TIMESTAMPTZ,
  sent_by_user_id TEXT,
  sent_by_user_email TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_email_message_company_provider
  ON email_messages(company_id, provider_message_id);

CREATE INDEX IF NOT EXISTS idx_email_messages_thread_time
  ON email_messages(thread_id, gmail_internal_at);

CREATE INDEX IF NOT EXISTS idx_email_messages_company_from
  ON email_messages(company_id, from_email);

-- 4. email_attachments — attachment metadata per message
CREATE TABLE IF NOT EXISTS email_attachments (
  id BIGSERIAL PRIMARY KEY,
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  message_id BIGINT NOT NULL REFERENCES email_messages(id) ON DELETE CASCADE,
  provider_attachment_id TEXT,
  part_id TEXT,
  file_name TEXT,
  content_type TEXT,
  file_size INTEGER,
  is_inline BOOLEAN NOT NULL DEFAULT false,
  content_id TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_email_attachments_message_order
  ON email_attachments(message_id, sort_order);

CREATE INDEX IF NOT EXISTS idx_email_attachments_company_type
  ON email_attachments(company_id, content_type);

-- 5. email_sync_state — sync bookkeeping per mailbox
CREATE TABLE IF NOT EXISTS email_sync_state (
  mailbox_id UUID PRIMARY KEY REFERENCES email_mailboxes(id) ON DELETE CASCADE,
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  last_history_id TEXT,
  initial_backfill_completed_at TIMESTAMPTZ,
  last_sync_started_at TIMESTAMPTZ,
  last_sync_finished_at TIMESTAMPTZ,
  last_sync_error TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Triggers: auto-update updated_at
CREATE OR REPLACE TRIGGER trg_email_mailboxes_updated BEFORE UPDATE ON email_mailboxes
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE OR REPLACE TRIGGER trg_email_threads_updated BEFORE UPDATE ON email_threads
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE OR REPLACE TRIGGER trg_email_messages_updated BEFORE UPDATE ON email_messages
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE OR REPLACE TRIGGER trg_email_sync_state_updated BEFORE UPDATE ON email_sync_state
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
