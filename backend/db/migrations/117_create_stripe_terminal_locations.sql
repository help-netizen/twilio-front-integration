-- =============================================================================
-- Migration 111: F018 Phase 4 — Stripe Terminal locations (Tap to Pay).
-- Per-tenant Terminal location registry. Backend support ships now; the on-device
-- NFC client requires a native/RN mobile shell (tracked separately).
-- =============================================================================

CREATE TABLE IF NOT EXISTS stripe_terminal_locations (
    id                  BIGSERIAL PRIMARY KEY,
    company_id          UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    stripe_account_id   TEXT NOT NULL,
    stripe_location_id  TEXT NOT NULL,
    display_name        TEXT,
    address             JSONB NOT NULL DEFAULT '{}',
    status              TEXT NOT NULL DEFAULT 'active',
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_stripe_terminal_location
    ON stripe_terminal_locations(company_id, stripe_location_id);

DROP TRIGGER IF EXISTS trg_stripe_terminal_locations_updated_at ON stripe_terminal_locations;
CREATE TRIGGER trg_stripe_terminal_locations_updated_at
    BEFORE UPDATE ON stripe_terminal_locations
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

COMMENT ON TABLE stripe_terminal_locations IS 'F018 Phase 4: Stripe Terminal locations per tenant.';
