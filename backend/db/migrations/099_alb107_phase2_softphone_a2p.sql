-- ============================================================================
-- 099: ALB-107 phase 2 — per-tenant softphone credentials + A2P 10DLC state
-- ============================================================================

-- Softphone (Voice SDK) + messaging service per tenant subaccount
ALTER TABLE company_telephony
    ADD COLUMN IF NOT EXISTS twiml_app_sid TEXT,
    ADD COLUMN IF NOT EXISTS api_key_sid TEXT,
    ADD COLUMN IF NOT EXISTS api_key_secret_enc TEXT,
    ADD COLUMN IF NOT EXISTS messaging_service_sid TEXT;

-- A2P 10DLC ISV registration state machine (one row per company)
CREATE TABLE IF NOT EXISTS company_a2p_registrations (
    company_id          UUID PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
    status              TEXT NOT NULL DEFAULT 'not_started' CHECK (status IN (
                            'not_started',
                            'profile_pending',   -- TrustHub bundles submitted
                            'brand_pending',     -- brand registration created
                            'brand_failed',
                            'campaign_pending',  -- campaign submitted
                            'campaign_failed',
                            'approved'
                        )),
    business_info       JSONB NOT NULL DEFAULT '{}',   -- legal name, EIN, address, website, contact
    trusthub_profile_sid TEXT,    -- secondary customer profile bundle (BU...)
    a2p_profile_sid      TEXT,    -- a2p messaging trust product bundle (BU...)
    brand_sid            TEXT,    -- BN...
    brand_status         TEXT,
    campaign_sid         TEXT,    -- QE.../CM...
    campaign_status      TEXT,
    messaging_service_sid TEXT,   -- MG... (tenant messaging service)
    last_error           TEXT,
    submitted_at         TIMESTAMPTZ,
    approved_at          TIMESTAMPTZ,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_company_a2p_status ON company_a2p_registrations (status);
