-- SOFTPHONE-NATIVE-001 Stage 2: iOS Voice push credentials and the durable
-- per-user native-registration signal used by inbound group routing.
--
-- Numbering hazard memo (2026-08-03): the remote refs/heads/master hash
-- 85ede29de4585d7abdc96941704df525d35ef86a matched local origin/master and its
-- migration maximum was 231. Re-check origin/master before integration.

ALTER TABLE company_telephony
    ADD COLUMN IF NOT EXISTS ios_push_credential_sid TEXT;

CREATE TABLE IF NOT EXISTS native_voice_registrations (
    company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES crm_users(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '30 days'),
    PRIMARY KEY (company_id, user_id),
    FOREIGN KEY (user_id, company_id)
        REFERENCES company_memberships(user_id, company_id) ON DELETE CASCADE,
    CONSTRAINT native_voice_registrations_expiry_check
        CHECK (expires_at > updated_at)
);

CREATE INDEX IF NOT EXISTS idx_native_voice_registrations_active
    ON native_voice_registrations(company_id, expires_at, user_id);

COMMENT ON COLUMN company_telephony.ios_push_credential_sid IS
    'Account-local Twilio APN Push Credential SID used only in native Voice grants.';
COMMENT ON TABLE native_voice_registrations IS
    'SOFTPHONE-NATIVE-001: voice.register succeeded and the explicit native softphone toggle is on; active for 30 days.';
