-- Roll back AVATARS-001 Multi-base only when no Claude binding would be lost.

DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM chatgpt_mcp_bindings
        WHERE base <> 'chatgpt'
    ) THEN
        RAISE EXCEPTION
            'AVATARS_MULTI_BASE_ROLLBACK_CLAUDE_BINDINGS: disconnect and remove Claude binding history explicitly before rollback';
    END IF;
END $$;

DROP INDEX IF EXISTS uq_chatgpt_mcp_binding_active_principal;

CREATE UNIQUE INDEX uq_chatgpt_mcp_binding_active_principal
    ON chatgpt_mcp_bindings(oauth_issuer, oauth_subject, oauth_client_id)
    WHERE status = 'active';

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
             'agent:chatgpt-crm-mcp:' ||
             b.company_id::text || ':' || b.owner_user_id::text
         AND conflict.id <> ai.id
        WHERE b.status = 'active'
    ) THEN
        RAISE EXCEPTION
            'AVATARS_MULTI_BASE_ROLLBACK_AI_IDENTITY_CONFLICT: Phase A avatar keycloak_sub is already in use';
    END IF;
END $$;

UPDATE crm_users ai
SET keycloak_sub =
        'agent:chatgpt-crm-mcp:' ||
        b.company_id::text || ':' || b.owner_user_id::text,
    updated_at = NOW()
FROM chatgpt_mcp_bindings b
WHERE b.status = 'active'
  AND b.base = 'chatgpt'
  AND ai.id = b.ai_user_id
  AND ai.company_id = b.company_id
  AND ai.kind = 'agent';

ALTER TABLE chatgpt_mcp_bindings
    DROP CONSTRAINT IF EXISTS chk_chatgpt_mcp_binding_base,
    DROP COLUMN IF EXISTS base;
