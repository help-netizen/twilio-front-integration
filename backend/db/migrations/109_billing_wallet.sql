-- 109: BILLING — prepaid wallet with auto-recharge.
-- Plan fees and usage overage are DEBITED from the wallet; Stripe is used only
-- to TOP UP (manual top-up + off-session auto-recharge). Balance may go down to
-- the grace floor (−$5) before paid telephony (calls/SMS) is blocked.

CREATE TABLE IF NOT EXISTS billing_wallets (
    company_id                  UUID PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
    balance_usd                 NUMERIC(12,2) NOT NULL DEFAULT 0,
    auto_recharge_enabled       BOOLEAN NOT NULL DEFAULT true,
    auto_recharge_threshold_usd NUMERIC(10,2) NOT NULL DEFAULT 5,
    auto_recharge_amount_usd    NUMERIC(10,2) NOT NULL DEFAULT 10,
    default_payment_method_id   TEXT,            -- saved Stripe pm_… for off-session charges
    updated_at                  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Every balance movement. amount_usd is signed (+credit / −debit). `ref` makes a
-- movement idempotent (unique per company) — Stripe payment-intent id, a period
-- key like 'plan:2026-06-01', or 'overage:sms:2026-05-01'.
CREATE TABLE IF NOT EXISTS billing_wallet_ledger (
    id            BIGSERIAL PRIMARY KEY,
    company_id    UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    amount_usd    NUMERIC(12,2) NOT NULL,
    type          TEXT NOT NULL,                 -- topup | auto_topup | plan | overage | adjustment
    description   TEXT,
    balance_after NUMERIC(12,2) NOT NULL,
    ref           TEXT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_wallet_ledger_company ON billing_wallet_ledger (company_id, id DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_wallet_ledger_ref ON billing_wallet_ledger (company_id, ref) WHERE ref IS NOT NULL;
