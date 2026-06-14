-- 108: BILLING — overage rates + idempotent overage-charge ledger.
-- Overage beyond a plan's included_units is billed in arrears as a Stripe
-- invoice item on the next cycle. metered = USD per extra unit, keyed by
-- metric (sms | call_minutes | agent_runs). agent_runs = 0 (not billed).

UPDATE billing_plans SET metered = '{"sms":0.03,"call_minutes":0.03,"agent_runs":0}' WHERE id = 'starter';
UPDATE billing_plans SET metered = '{"sms":0.01,"call_minutes":0.02,"agent_runs":0}' WHERE id = 'pro';
UPDATE billing_plans SET metered = '{"sms":0.01,"call_minutes":0.02,"agent_runs":0}' WHERE id = 'huge';

-- Ledger: one row per (company, period, metric) we've billed. The PK gives
-- idempotency so a daily run never double-charges the same period.
CREATE TABLE IF NOT EXISTS billing_overage_charges (
    company_id               UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    period_start             DATE NOT NULL,
    metric                   TEXT NOT NULL,
    overage_units            NUMERIC(14,3) NOT NULL DEFAULT 0,
    amount_usd               NUMERIC(10,2) NOT NULL DEFAULT 0,
    provider_invoice_item_id TEXT,
    created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (company_id, period_start, metric)
);
