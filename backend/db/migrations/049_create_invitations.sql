-- =============================================================================
-- Migration 049: Create company_invitations table for PF007
-- Local invite/onboarding tracking on top of Keycloak flows
-- =============================================================================

CREATE TABLE IF NOT EXISTS company_invitations (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id  UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    email       VARCHAR(255) NOT NULL,
    role_key    VARCHAR(50) NOT NULL,
    invited_by  UUID REFERENCES crm_users(id),
    keycloak_sub VARCHAR(255),
    status      VARCHAR(20) NOT NULL DEFAULT 'pending',
    expires_at  TIMESTAMPTZ,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT chk_invitation_role_key CHECK (role_key IN ('tenant_admin', 'manager', 'dispatcher', 'provider')),
    CONSTRAINT chk_invitation_status CHECK (status IN ('pending', 'accepted', 'expired', 'revoked'))
);

CREATE INDEX IF NOT EXISTS idx_invitations_company ON company_invitations(company_id);
CREATE INDEX IF NOT EXISTS idx_invitations_email ON company_invitations(email);
CREATE INDEX IF NOT EXISTS idx_invitations_status ON company_invitations(status);

CREATE TRIGGER trg_invitations_updated_at BEFORE UPDATE ON company_invitations
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

COMMENT ON TABLE company_invitations IS 'Tenant user invitation tracking (PF007)';
