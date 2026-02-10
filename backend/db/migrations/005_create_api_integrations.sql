-- =============================================================================
-- Migration 005: Create api_integrations table
-- Secured multi-tenant API credential storage for lead generators
-- =============================================================================

CREATE TABLE IF NOT EXISTS api_integrations (
    id              BIGSERIAL PRIMARY KEY,
    client_name     TEXT NOT NULL,
    key_id          TEXT NOT NULL UNIQUE,
    secret_hash     TEXT NOT NULL,
    scopes          JSONB NOT NULL DEFAULT '["leads:create"]'::jsonb,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at      TIMESTAMPTZ,
    revoked_at      TIMESTAMPTZ,
    last_used_at    TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_api_integrations_key_id ON api_integrations(key_id);
CREATE INDEX IF NOT EXISTS idx_api_integrations_active ON api_integrations(key_id)
    WHERE revoked_at IS NULL;

COMMENT ON TABLE api_integrations IS 'API integration credentials for external lead generators';
COMMENT ON COLUMN api_integrations.key_id IS 'Public identifier (X-BLANC-API-KEY header value)';
COMMENT ON COLUMN api_integrations.secret_hash IS 'hash(secret + server_pepper) — plaintext never stored';
COMMENT ON COLUMN api_integrations.scopes IS 'JSON array of permissions, e.g. ["leads:create"]';

-- Auto-update trigger (reuses existing function from v3_schema)
CREATE TRIGGER trg_api_integrations_updated_at BEFORE UPDATE ON api_integrations
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
