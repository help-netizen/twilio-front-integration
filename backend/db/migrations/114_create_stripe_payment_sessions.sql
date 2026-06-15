-- =============================================================================
-- Migration 108: Stripe Payments (F018) — payment sessions.
-- Tracks Checkout Sessions / payment intents per invoice. Surface = checkout_link
-- for Phase 2 (manual_card / tap_to_pay reserved for later phases).
-- =============================================================================

CREATE TABLE IF NOT EXISTS stripe_payment_sessions (
    id                          BIGSERIAL PRIMARY KEY,
    company_id                  UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    invoice_id                  BIGINT REFERENCES invoices(id) ON DELETE SET NULL,
    job_id                      BIGINT REFERENCES jobs(id) ON DELETE SET NULL,
    contact_id                  BIGINT REFERENCES contacts(id) ON DELETE SET NULL,
    created_by                  UUID REFERENCES crm_users(id) ON DELETE SET NULL,
    surface                     TEXT NOT NULL DEFAULT 'checkout_link'
                                CHECK (surface IN ('checkout_link','manual_card','tap_to_pay')),
    amount                      NUMERIC(12,2) NOT NULL,
    currency                    VARCHAR(3) NOT NULL DEFAULT 'USD',
    status                      TEXT NOT NULL DEFAULT 'open'
                                CHECK (status IN ('open','complete','expired','canceled','failed')),
    stripe_checkout_session_id  TEXT,
    stripe_payment_intent_id    TEXT,
    stripe_charge_id            TEXT,
    stripe_account_id           TEXT,
    url                         TEXT,
    failure_reason              TEXT,
    expires_at                  TIMESTAMPTZ,
    metadata                    JSONB NOT NULL DEFAULT '{}',
    created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_stripe_sessions_company_invoice
    ON stripe_payment_sessions(company_id, invoice_id) WHERE invoice_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_stripe_sessions_checkout
    ON stripe_payment_sessions(stripe_checkout_session_id) WHERE stripe_checkout_session_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_stripe_sessions_pi
    ON stripe_payment_sessions(stripe_payment_intent_id) WHERE stripe_payment_intent_id IS NOT NULL;

DROP TRIGGER IF EXISTS trg_stripe_payment_sessions_updated_at ON stripe_payment_sessions;
CREATE TRIGGER trg_stripe_payment_sessions_updated_at
    BEFORE UPDATE ON stripe_payment_sessions
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

COMMENT ON TABLE stripe_payment_sessions IS 'F018: Stripe Checkout/payment sessions per invoice.';
