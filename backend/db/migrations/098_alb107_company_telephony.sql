-- ============================================================================
-- 098: ALB-107 — multi-tenant telephony (Twilio subaccount per company)
-- ============================================================================

CREATE TABLE IF NOT EXISTS company_telephony (
    company_id          UUID PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
    provider            TEXT NOT NULL DEFAULT 'twilio',
    -- Subaccount credentials. Token is AES-256-GCM encrypted at rest
    -- (iv:tag:ciphertext, key derived from TELEPHONY_TOKEN_KEY/BLANC_SERVER_PEPPER).
    twilio_subaccount_sid TEXT UNIQUE,
    twilio_auth_token_enc TEXT,
    status              TEXT NOT NULL DEFAULT 'connected'
                        CHECK (status IN ('connected', 'suspended', 'closed')),
    connected_by        UUID REFERENCES crm_users(id),
    connected_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    suspended_at        TIMESTAMPTZ,
    metadata            JSONB NOT NULL DEFAULT '{}',
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_company_telephony_subaccount
    ON company_telephony (twilio_subaccount_sid)
    WHERE twilio_subaccount_sid IS NOT NULL;

-- Purchased-number bookkeeping on the existing per-company settings table
ALTER TABLE phone_number_settings
    ADD COLUMN IF NOT EXISTS twilio_number_sid TEXT,
    ADD COLUMN IF NOT EXISTS locality TEXT,
    ADD COLUMN IF NOT EXISTS capabilities JSONB,
    ADD COLUMN IF NOT EXISTS purchased_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_phone_number_settings_number_sid
    ON phone_number_settings (twilio_number_sid)
    WHERE twilio_number_sid IS NOT NULL;
