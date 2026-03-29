-- =============================================================================
-- Migration 067: Create portal_sessions table (PF005)
-- Tracks active client portal sessions
-- =============================================================================

CREATE TABLE IF NOT EXISTS portal_sessions (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    token_id        UUID NOT NULL REFERENCES portal_access_tokens(id) ON DELETE CASCADE,
    contact_id      BIGINT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
    ip_address      INET,
    user_agent      TEXT,
    started_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_active_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    ended_at        TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_portal_sessions_token ON portal_sessions(token_id);
CREATE INDEX IF NOT EXISTS idx_portal_sessions_contact ON portal_sessions(contact_id);
CREATE INDEX IF NOT EXISTS idx_portal_sessions_active ON portal_sessions(started_at DESC) WHERE ended_at IS NULL;

COMMENT ON TABLE portal_sessions IS 'PF005: Active client portal session tracking';
