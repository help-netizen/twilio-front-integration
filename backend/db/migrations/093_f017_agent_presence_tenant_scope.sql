-- Migration 093: F017 tenant-scoped shared agent presence
-- Presence is keyed by company + user and expires quickly so routing is safe
-- across multiple app instances.

CREATE TABLE IF NOT EXISTS agent_presence (
  company_id TEXT NOT NULL,
  user_id    TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'offline',
  group_ids  JSONB NOT NULL DEFAULT '[]'::jsonb,
  details    JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, user_id),
  CONSTRAINT chk_agent_presence_status
    CHECK (status IN ('available', 'on_call', 'offline'))
);

CREATE INDEX IF NOT EXISTS idx_agent_presence_company_status
  ON agent_presence(company_id, status, expires_at);

CREATE INDEX IF NOT EXISTS idx_agent_presence_expires
  ON agent_presence(expires_at);
