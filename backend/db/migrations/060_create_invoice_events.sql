-- =============================================================================
-- Migration 060: Create invoice_events table (PF003)
-- Audit trail for invoice lifecycle events
-- =============================================================================

CREATE TABLE IF NOT EXISTS invoice_events (
    id              BIGSERIAL PRIMARY KEY,
    invoice_id      BIGINT NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
    event_type      VARCHAR(50) NOT NULL,
    actor_type      VARCHAR(20) NOT NULL DEFAULT 'user'
                    CHECK (actor_type IN ('user','system','client')),
    actor_id        VARCHAR(255),
    metadata        JSONB NOT NULL DEFAULT '{}',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_invoice_events_invoice ON invoice_events(invoice_id, created_at);
CREATE INDEX IF NOT EXISTS idx_invoice_events_type ON invoice_events(event_type);

COMMENT ON TABLE invoice_events IS 'PF003: Audit trail for invoice lifecycle events';
