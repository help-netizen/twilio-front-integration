-- =============================================================================
-- Migration 107: Stripe Payments (F018 / STRIPE-PAY-001) — connected accounts.
-- Per-tenant Stripe Connect account (direct charges, merchant of record = tenant).
-- Separate from platform billing (ADR-001). No secrets stored here.
-- =============================================================================

CREATE TABLE IF NOT EXISTS stripe_connected_accounts (
    id                          BIGSERIAL PRIMARY KEY,
    company_id                  UUID NOT NULL UNIQUE REFERENCES companies(id) ON DELETE CASCADE,
    marketplace_installation_id BIGINT REFERENCES marketplace_installations(id) ON DELETE SET NULL,
    stripe_account_id           TEXT NOT NULL,
    livemode                    BOOLEAN NOT NULL DEFAULT false,
    charges_enabled             BOOLEAN NOT NULL DEFAULT false,
    payouts_enabled             BOOLEAN NOT NULL DEFAULT false,
    details_submitted           BOOLEAN NOT NULL DEFAULT false,
    requirements_currently_due  JSONB NOT NULL DEFAULT '[]',
    requirements_past_due       JSONB NOT NULL DEFAULT '[]',
    capabilities                JSONB NOT NULL DEFAULT '{}',
    status                      TEXT NOT NULL DEFAULT 'onboarding_incomplete',
    created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_stripe_accounts_account_id
    ON stripe_connected_accounts(stripe_account_id);

DROP TRIGGER IF EXISTS trg_stripe_connected_accounts_updated_at ON stripe_connected_accounts;
CREATE TRIGGER trg_stripe_connected_accounts_updated_at
    BEFORE UPDATE ON stripe_connected_accounts
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Ledger idempotency for Stripe-sourced payments (mirrors 104 for zenbooker).
CREATE UNIQUE INDEX IF NOT EXISTS uniq_payment_tx_stripe_external
    ON payment_transactions(company_id, external_id)
    WHERE external_source = 'stripe' AND external_id IS NOT NULL;

COMMENT ON TABLE stripe_connected_accounts IS 'F018: per-tenant Stripe Connect account (direct charges).';
