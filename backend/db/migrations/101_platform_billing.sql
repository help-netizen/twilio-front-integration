-- ============================================================================
-- 101: Platform billing (ADR-001 §2.4) — tenant subscriptions to Albusto.
-- Provider-agnostic (Stripe first). Separate from PF004 tenant→client payments.
-- ============================================================================

CREATE TABLE IF NOT EXISTS billing_plans (
    id              TEXT PRIMARY KEY,               -- 'starter','pro',…
    name            TEXT NOT NULL,
    provider        TEXT NOT NULL DEFAULT 'stripe',
    provider_price_id TEXT,                         -- Stripe price id
    monthly_base_usd NUMERIC(10,2) NOT NULL DEFAULT 0,
    included_seats  INTEGER NOT NULL DEFAULT 1,
    per_seat_usd    NUMERIC(10,2) NOT NULL DEFAULT 0,
    metered         JSONB NOT NULL DEFAULT '{}',    -- {sms_per_unit, call_min_per_unit, agent_run_per_unit}
    is_active       BOOLEAN NOT NULL DEFAULT true,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS billing_subscriptions (
    company_id      UUID PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
    plan_id         TEXT REFERENCES billing_plans(id),
    provider        TEXT NOT NULL DEFAULT 'stripe',
    provider_customer_id TEXT,                      -- cus_…
    provider_subscription_id TEXT,                  -- sub_…
    status          TEXT NOT NULL DEFAULT 'trialing'
                    CHECK (status IN ('trialing','active','past_due','canceled','unpaid','incomplete')),
    trial_ends_at   TIMESTAMPTZ,
    current_period_start TIMESTAMPTZ,
    current_period_end   TIMESTAMPTZ,
    seats           INTEGER NOT NULL DEFAULT 1,
    metadata        JSONB NOT NULL DEFAULT '{}',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_billing_sub_status ON billing_subscriptions (status);
CREATE INDEX IF NOT EXISTS idx_billing_sub_provider
    ON billing_subscriptions (provider_subscription_id)
    WHERE provider_subscription_id IS NOT NULL;

-- Metered usage accumulation (aggregated per company per period per metric)
CREATE TABLE IF NOT EXISTS billing_usage_records (
    id              BIGSERIAL PRIMARY KEY,
    company_id      UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    metric          TEXT NOT NULL,                  -- 'sms','call_minutes','agent_runs','seats'
    period_start    DATE NOT NULL,
    quantity        NUMERIC(14,3) NOT NULL DEFAULT 0,
    reported_to_provider BOOLEAN NOT NULL DEFAULT false,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (company_id, metric, period_start)
);
CREATE INDEX IF NOT EXISTS idx_billing_usage_company ON billing_usage_records (company_id, period_start DESC);

CREATE TABLE IF NOT EXISTS billing_invoices (
    id              BIGSERIAL PRIMARY KEY,
    company_id      UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    provider        TEXT NOT NULL DEFAULT 'stripe',
    provider_invoice_id TEXT UNIQUE,
    amount_due_usd  NUMERIC(10,2),
    amount_paid_usd NUMERIC(10,2),
    status          TEXT,                            -- draft|open|paid|void|uncollectible
    hosted_url      TEXT,
    period_start    TIMESTAMPTZ,
    period_end      TIMESTAMPTZ,
    issued_at       TIMESTAMPTZ,
    raw             JSONB NOT NULL DEFAULT '{}',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_billing_invoices_company ON billing_invoices (company_id, created_at DESC);

-- Seed default plans (idempotent)
INSERT INTO billing_plans (id, name, monthly_base_usd, included_seats, per_seat_usd, metered) VALUES
    ('trial',   'Trial',    0,   3,  0,   '{}'),
    ('starter', 'Starter',  49,  3,  15,  '{"sms_per_unit":0.02,"call_min_per_unit":0.03,"agent_run_per_unit":0.10}'),
    ('pro',     'Pro',      149, 10, 12,  '{"sms_per_unit":0.015,"call_min_per_unit":0.025,"agent_run_per_unit":0.08}')
ON CONFLICT (id) DO NOTHING;
