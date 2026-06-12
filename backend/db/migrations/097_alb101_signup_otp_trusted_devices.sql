-- ============================================================================
-- 097: ALB-101 — self-registration foundation
-- phone OTP codes, trusted devices (SMS 2FA), company geo/onboarding fields.
-- ============================================================================

-- 1. Phone OTP codes (hashed; never store the raw code)
CREATE TABLE IF NOT EXISTS phone_otp (
    id              BIGSERIAL PRIMARY KEY,
    phone           TEXT NOT NULL,
    purpose         TEXT NOT NULL CHECK (purpose IN ('signup', 'login', 'change')),
    code_hash       TEXT NOT NULL,
    attempts        INT  NOT NULL DEFAULT 0,
    created_ip      TEXT,
    expires_at      TIMESTAMPTZ NOT NULL,
    consumed_at     TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_phone_otp_phone_purpose
    ON phone_otp (phone, purpose, created_at DESC);

-- 2. Trusted devices for SMS 2FA (30-day trust window)
CREATE TABLE IF NOT EXISTS trusted_devices (
    id              BIGSERIAL PRIMARY KEY,
    user_id         UUID NOT NULL REFERENCES crm_users(id) ON DELETE CASCADE,
    device_id_hash  TEXT NOT NULL,
    label           TEXT,
    created_ip      TEXT,
    last_used_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at      TIMESTAMPTZ NOT NULL,
    revoked_at      TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_trusted_devices_user
    ON trusted_devices (user_id) WHERE revoked_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_trusted_devices_hash
    ON trusted_devices (device_id_hash);

-- 3. Verified phone on the platform user (2FA target; tenant-agnostic)
ALTER TABLE crm_users
    ADD COLUMN IF NOT EXISTS phone_e164 TEXT,
    ADD COLUMN IF NOT EXISTS phone_verified_at TIMESTAMPTZ;

-- 4. Company geo fields from onboarding (Google Places resolution)
ALTER TABLE companies
    ADD COLUMN IF NOT EXISTS city  TEXT,
    ADD COLUMN IF NOT EXISTS state TEXT,
    ADD COLUMN IF NOT EXISTS zip   TEXT,
    ADD COLUMN IF NOT EXISTS lat   DOUBLE PRECISION,
    ADD COLUMN IF NOT EXISTS lng   DOUBLE PRECISION;

COMMENT ON COLUMN companies.city IS
    'From onboarding Google Places pick; also the source of companies.timezone.';
