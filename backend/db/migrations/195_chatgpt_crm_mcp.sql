-- CHATGPT-CRM-MCP-001 S1: tenant-bound OAuth identity and deny-by-default grants.

ALTER TABLE crm_users
    ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'user';

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'crm_users_kind_check'
    ) THEN
        ALTER TABLE crm_users
            ADD CONSTRAINT crm_users_kind_check CHECK (kind IN ('user', 'agent'));
    END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_crm_users_company_id_id
    ON crm_users(company_id, id);

CREATE UNIQUE INDEX IF NOT EXISTS uq_marketplace_installations_company_id_id
    ON marketplace_installations(company_id, id);

CREATE TABLE IF NOT EXISTS chatgpt_mcp_bindings (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id              UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    installation_id         BIGINT NOT NULL,
    authorized_by_user_id   UUID NOT NULL REFERENCES crm_users(id) ON DELETE RESTRICT,
    oauth_issuer            TEXT NOT NULL,
    oauth_subject           TEXT NOT NULL,
    oauth_client_id         TEXT NOT NULL,
    ai_user_id              UUID NOT NULL,
    status                  TEXT NOT NULL DEFAULT 'active'
                                CHECK (status IN ('active', 'revoked')),
    grant_version           INTEGER NOT NULL DEFAULT 1 CHECK (grant_version > 0),
    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    revoked_at              TIMESTAMPTZ,
    revoked_by_user_id      UUID REFERENCES crm_users(id) ON DELETE SET NULL,
    CONSTRAINT fk_chatgpt_binding_installation_company
        FOREIGN KEY (company_id, installation_id)
        REFERENCES marketplace_installations(company_id, id) ON DELETE CASCADE,
    CONSTRAINT fk_chatgpt_binding_ai_user_company
        FOREIGN KEY (company_id, ai_user_id)
        REFERENCES crm_users(company_id, id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_chatgpt_mcp_binding_active_company
    ON chatgpt_mcp_bindings(company_id) WHERE status = 'active';

CREATE UNIQUE INDEX IF NOT EXISTS uq_chatgpt_mcp_binding_active_principal
    ON chatgpt_mcp_bindings(oauth_issuer, oauth_subject, oauth_client_id)
    WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_chatgpt_mcp_bindings_installation
    ON chatgpt_mcp_bindings(company_id, installation_id);

CREATE TABLE IF NOT EXISTS mcp_agent_permission_grants (
    id                  BIGSERIAL PRIMARY KEY,
    company_id          UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    agent_user_id       UUID NOT NULL,
    permission_key      TEXT NOT NULL,
    bundle_version      INTEGER NOT NULL DEFAULT 1 CHECK (bundle_version > 0),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT fk_mcp_grant_agent_company
        FOREIGN KEY (company_id, agent_user_id)
        REFERENCES crm_users(company_id, id) ON DELETE CASCADE,
    CONSTRAINT uq_mcp_agent_permission
        UNIQUE (company_id, agent_user_id, permission_key)
);

CREATE INDEX IF NOT EXISTS idx_mcp_agent_grants_lookup
    ON mcp_agent_permission_grants(company_id, agent_user_id);

CREATE TABLE IF NOT EXISTS mcp_tool_invocations (
    id                      BIGSERIAL PRIMARY KEY,
    company_id              UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    binding_id              UUID NOT NULL REFERENCES chatgpt_mcp_bindings(id) ON DELETE RESTRICT,
    created_by              UUID NOT NULL,
    authorized_by_user_id   UUID NOT NULL REFERENCES crm_users(id) ON DELETE RESTRICT,
    tool_name               TEXT NOT NULL,
    stage                   TEXT NOT NULL DEFAULT 'S1',
    request_id              TEXT,
    idempotency_key         TEXT,
    argument_hash           TEXT,
    confirmation_class      TEXT CHECK (confirmation_class IN ('R', 'W', 'D', 'I')),
    status                  TEXT NOT NULL CHECK (status IN ('succeeded', 'denied', 'failed')),
    safe_metadata           JSONB NOT NULL DEFAULT '{}'::jsonb,
    started_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at            TIMESTAMPTZ,
    CONSTRAINT fk_mcp_invocation_actor_company
        FOREIGN KEY (company_id, created_by)
        REFERENCES crm_users(company_id, id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_mcp_tool_invocations_company_created
    ON mcp_tool_invocations(company_id, started_at DESC);

CREATE TABLE IF NOT EXISTS mcp_tool_idempotency (
    id                  BIGSERIAL PRIMARY KEY,
    company_id          UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    agent_user_id       UUID NOT NULL,
    tool_name           TEXT NOT NULL,
    idempotency_key     TEXT NOT NULL,
    argument_hash       TEXT NOT NULL,
    state               TEXT NOT NULL CHECK (state IN ('claimed', 'succeeded', 'failed')),
    safe_result         JSONB,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT fk_mcp_idempotency_agent_company
        FOREIGN KEY (company_id, agent_user_id)
        REFERENCES crm_users(company_id, id) ON DELETE CASCADE,
    CONSTRAINT uq_mcp_tool_idempotency
        UNIQUE (company_id, agent_user_id, tool_name, idempotency_key)
);

COMMENT ON COLUMN crm_users.kind IS
    'Distinguishes human users from system agents; agents do not receive company_memberships rows.';
COMMENT ON TABLE chatgpt_mcp_bindings IS
    'Fail-closed OAuth principal to Marketplace installation, company, authorizer, and AI CRM identity binding.';
COMMENT ON TABLE mcp_agent_permission_grants IS
    'System-only deny-by-default permission bundle for company-scoped AI identities.';
COMMENT ON TABLE mcp_tool_invocations IS
    'Append-only tenant-scoped MCP invocation audit; safe_metadata must not contain record bodies or secrets.';
