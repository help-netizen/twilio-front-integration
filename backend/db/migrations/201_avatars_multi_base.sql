-- AVATARS-001 Multi-base: persist the selected ChatGPT/Claude connector base.

ALTER TABLE chatgpt_mcp_bindings
    ADD COLUMN IF NOT EXISTS base TEXT NOT NULL DEFAULT 'chatgpt';

-- A human OAuth principal gets one active avatar across all connector clients.
-- The company/owner slot remains enforced separately by migration 200.
DROP INDEX IF EXISTS uq_chatgpt_mcp_binding_active_principal;

CREATE UNIQUE INDEX uq_chatgpt_mcp_binding_active_principal
    ON chatgpt_mcp_bindings(oauth_issuer, oauth_subject)
    WHERE status = 'active';

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'chk_chatgpt_mcp_binding_base'
          AND conrelid = 'chatgpt_mcp_bindings'::regclass
    ) THEN
        ALTER TABLE chatgpt_mcp_bindings
            ADD CONSTRAINT chk_chatgpt_mcp_binding_base
            CHECK (base IN ('chatgpt', 'claude'));
    END IF;
END $$;

DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM chatgpt_mcp_bindings b
        JOIN crm_users ai
          ON ai.id = b.ai_user_id
         AND ai.company_id = b.company_id
        JOIN crm_users conflict
          ON conflict.keycloak_sub =
             'agent:chatgpt-crm-mcp:' || b.base || ':' ||
             b.company_id::text || ':' || b.owner_user_id::text
         AND conflict.id <> ai.id
        WHERE b.status = 'active'
    ) THEN
        RAISE EXCEPTION
            'AVATARS_MULTI_BASE_AI_IDENTITY_CONFLICT: target avatar keycloak_sub already belongs to another CRM user';
    END IF;
END $$;

UPDATE crm_users ai
SET keycloak_sub =
        'agent:chatgpt-crm-mcp:' || b.base || ':' ||
        b.company_id::text || ':' || b.owner_user_id::text,
    updated_at = NOW()
FROM chatgpt_mcp_bindings b
WHERE b.status = 'active'
  AND ai.id = b.ai_user_id
  AND ai.company_id = b.company_id
  AND ai.kind = 'agent';

COMMENT ON COLUMN chatgpt_mcp_bindings.base IS
    'User-selected avatar base. Authorization remains the live human owner RBAC/scopes intersected with consent tiers.';
