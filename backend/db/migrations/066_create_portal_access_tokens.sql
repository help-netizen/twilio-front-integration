-- =============================================================================
-- Migration 066: Create portal_access_tokens table (PF005)
-- Magic link tokens for client portal access
-- =============================================================================

CREATE TABLE IF NOT EXISTS portal_access_tokens (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id      UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    contact_id      BIGINT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
    token_hash      VARCHAR(128) NOT NULL UNIQUE,
    scope           VARCHAR(30) NOT NULL DEFAULT 'full'
                    CHECK (scope IN ('full','estimate','invoice','payment')),
    document_type   VARCHAR(20),
    document_id     BIGINT,
    expires_at      TIMESTAMPTZ NOT NULL,
    revoked_at      TIMESTAMPTZ,
    created_by      UUID REFERENCES crm_users(id) ON DELETE SET NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_portal_tokens_company ON portal_access_tokens(company_id);
CREATE INDEX IF NOT EXISTS idx_portal_tokens_contact ON portal_access_tokens(contact_id);
CREATE INDEX IF NOT EXISTS idx_portal_tokens_expires ON portal_access_tokens(expires_at) WHERE revoked_at IS NULL;

COMMENT ON TABLE portal_access_tokens IS 'PF005: Magic link tokens for client portal access (stores hash, never raw token)';
