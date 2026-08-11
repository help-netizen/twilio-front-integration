-- AUTH-BACKCHANNEL-001: short-lived OIDC backchannel logout revocations.
-- This is realm-scoped authentication state, not tenant-owned CRM data.

CREATE TABLE IF NOT EXISTS revoked_sessions (
    issuer TEXT NOT NULL,
    key_type TEXT NOT NULL CHECK (key_type IN ('sid', 'sub')),
    key_value TEXT NOT NULL CHECK (length(key_value) > 0),
    revoked_at TIMESTAMPTZ NOT NULL,
    received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL,
    logout_token_jti TEXT NOT NULL CHECK (length(logout_token_jti) > 0),
    PRIMARY KEY (issuer, key_type, key_value),
    UNIQUE (issuer, logout_token_jti)
);

-- The primary key already supports exact lookup; INCLUDE keeps the middleware's
-- live-row/time comparison index-only when PostgreSQL's visibility map permits.
CREATE INDEX IF NOT EXISTS idx_revoked_sessions_auth_lookup
    ON revoked_sessions (issuer, key_type, key_value)
    INCLUDE (expires_at, revoked_at);

CREATE INDEX IF NOT EXISTS idx_revoked_sessions_expiry
    ON revoked_sessions (issuer, expires_at);
