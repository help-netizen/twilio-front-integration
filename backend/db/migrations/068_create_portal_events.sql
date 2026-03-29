-- =============================================================================
-- Migration 068: Create portal_events table (PF005)
-- Client portal activity log
-- =============================================================================

CREATE TABLE IF NOT EXISTS portal_events (
    id              BIGSERIAL PRIMARY KEY,
    session_id      UUID NOT NULL REFERENCES portal_sessions(id) ON DELETE CASCADE,
    contact_id      BIGINT REFERENCES contacts(id) ON DELETE SET NULL,
    event_type      VARCHAR(50) NOT NULL,
    document_type   VARCHAR(20),
    document_id     BIGINT,
    metadata        JSONB NOT NULL DEFAULT '{}',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_portal_events_session ON portal_events(session_id, created_at);
CREATE INDEX IF NOT EXISTS idx_portal_events_type ON portal_events(event_type);

COMMENT ON TABLE portal_events IS 'PF005: Client portal activity and interaction log';
