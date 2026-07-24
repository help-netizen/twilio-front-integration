-- Roll back AVATARS-001 Phase A only while the old one-binding-per-company
-- invariant can be restored without selecting or revoking a binding.

DO $$
BEGIN
    IF EXISTS (
        SELECT b.company_id
        FROM chatgpt_mcp_bindings b
        WHERE b.status = 'active'
        GROUP BY b.company_id
        HAVING COUNT(*) > 1
    ) THEN
        RAISE EXCEPTION
            'AVATARS_ROLLBACK_MULTIPLE_ACTIVE_BINDINGS: revoke extra avatars explicitly before rollback';
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
             'agent:chatgpt-crm-mcp:' || b.company_id::text
         AND conflict.id <> ai.id
        WHERE b.status = 'active'
    ) THEN
        RAISE EXCEPTION
            'AVATARS_ROLLBACK_AI_IDENTITY_CONFLICT: legacy agent keycloak_sub is already in use';
    END IF;
END $$;

UPDATE crm_users ai
SET keycloak_sub = 'agent:chatgpt-crm-mcp:' || b.company_id::text,
    full_name = 'ChatGPT AI Dispatcher',
    updated_at = NOW()
FROM chatgpt_mcp_bindings b
WHERE b.status = 'active'
  AND ai.id = b.ai_user_id
  AND ai.company_id = b.company_id
  AND ai.kind = 'agent';

DROP INDEX IF EXISTS uq_chatgpt_mcp_binding_active_owner;

CREATE UNIQUE INDEX IF NOT EXISTS uq_chatgpt_mcp_binding_active_company
    ON chatgpt_mcp_bindings(company_id)
    WHERE status = 'active';

ALTER TABLE chatgpt_mcp_bindings
    DROP CONSTRAINT IF EXISTS fk_chatgpt_binding_owner_membership,
    DROP COLUMN IF EXISTS sends_enabled,
    DROP COLUMN IF EXISTS writes_enabled,
    DROP COLUMN IF EXISTS owner_user_id;

UPDATE marketplace_apps
SET name = 'ChatGPT CRM Connector',
    metadata = jsonb_set(
        COALESCE(metadata, '{}'::jsonb),
        '{assistant}',
        '{
          "what_it_does": "Lets an authorized ChatGPT connector use company-scoped Albusto CRM reads, internal writes, and customer Estimate or Invoice sends through a dedicated AI identity.",
          "prerequisites": ["A tenant administrator", "The Albusto ChatGPT OAuth client configured in the crm-prod Keycloak realm"],
          "setup_steps": ["Settings → Integrations → Marketplace → ChatGPT CRM Connector → Connect", "Authorize the matching Albusto account from ChatGPT", "Explicitly enable Writes or Sends when needed"],
          "outcome": "ChatGPT can use only explicitly granted, company-scoped CRM tools while the installation and authorizer remain active.",
          "recommend_when": ["A tenant administrator wants one company-bound ChatGPT CRM connector", "The company needs revocable ChatGPT access to Jobs, Leads, Contacts, Schedule, Tasks, Estimates, Invoices, Calls, or document delivery"],
          "gotchas": ["Only tenant administrators can connect or disconnect it", "Writes and Sends are separate consent tiers", "Disconnecting immediately blocks still-unexpired tokens", "Payments and file uploads remain unavailable"]
        }'::jsonb,
        true
    ),
    updated_at = NOW()
WHERE app_key = 'chatgpt-crm-mcp';

