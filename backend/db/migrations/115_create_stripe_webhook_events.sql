-- =============================================================================
-- Migration 109: Stripe Payments (F018) — webhook event log (idempotency + audit).
-- Insert-on-receive with ON CONFLICT (stripe_event_id) DO NOTHING for dedup.
-- Separate from platform-billing webhook handling.
-- =============================================================================

CREATE TABLE IF NOT EXISTS stripe_webhook_events (
    id                  BIGSERIAL PRIMARY KEY,
    stripe_event_id     TEXT NOT NULL UNIQUE,
    livemode            BOOLEAN NOT NULL DEFAULT false,
    event_type          TEXT NOT NULL,
    stripe_account_id   TEXT,
    company_id          UUID REFERENCES companies(id) ON DELETE SET NULL,
    processing_status   TEXT NOT NULL DEFAULT 'received'
                        CHECK (processing_status IN ('received','processed','failed','ignored')),
    payload             JSONB NOT NULL DEFAULT '{}',
    error               TEXT,
    processed_at        TIMESTAMPTZ,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_stripe_webhook_events_type ON stripe_webhook_events(event_type);
CREATE INDEX IF NOT EXISTS idx_stripe_webhook_events_account ON stripe_webhook_events(stripe_account_id) WHERE stripe_account_id IS NOT NULL;

COMMENT ON TABLE stripe_webhook_events IS 'F018: Stripe tenant-payments webhook idempotency + audit.';
