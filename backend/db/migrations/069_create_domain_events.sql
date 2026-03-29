-- =============================================================================
-- Migration 069: Create domain_events table (infrastructure)
-- Canonical event sourcing table for all business domain events
-- =============================================================================

CREATE TABLE IF NOT EXISTS domain_events (
    id              BIGSERIAL PRIMARY KEY,
    company_id      UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    aggregate_type  VARCHAR(50) NOT NULL,
    aggregate_id    VARCHAR(255) NOT NULL,
    event_type      VARCHAR(100) NOT NULL,
    event_data      JSONB NOT NULL DEFAULT '{}',
    actor_type      VARCHAR(20) NOT NULL DEFAULT 'system'
                    CHECK (actor_type IN ('user','system','client','webhook')),
    actor_id        VARCHAR(255),
    idempotency_key VARCHAR(255),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_domain_events_idempotency
    ON domain_events(idempotency_key) WHERE idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_domain_events_aggregate
    ON domain_events(aggregate_type, aggregate_id, created_at);

CREATE INDEX IF NOT EXISTS idx_domain_events_company_created
    ON domain_events(company_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_domain_events_type
    ON domain_events(event_type);

COMMENT ON TABLE domain_events IS 'Infrastructure: Canonical event sourcing table for all business domain events';
