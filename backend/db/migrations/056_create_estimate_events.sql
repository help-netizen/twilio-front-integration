-- =============================================================================
-- Migration 056: Create estimate_events table (PF002)
-- Audit trail for estimate lifecycle events
-- =============================================================================

CREATE TABLE IF NOT EXISTS estimate_events (
    id              BIGSERIAL PRIMARY KEY,
    estimate_id     BIGINT NOT NULL REFERENCES estimates(id) ON DELETE CASCADE,
    event_type      VARCHAR(50) NOT NULL,
    actor_type      VARCHAR(20) NOT NULL DEFAULT 'user'
                    CHECK (actor_type IN ('user','system','client')),
    actor_id        VARCHAR(255),
    metadata        JSONB NOT NULL DEFAULT '{}',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_estimate_events_estimate ON estimate_events(estimate_id, created_at);
CREATE INDEX IF NOT EXISTS idx_estimate_events_type ON estimate_events(event_type);

COMMENT ON TABLE estimate_events IS 'PF002: Audit trail for estimate lifecycle events';
