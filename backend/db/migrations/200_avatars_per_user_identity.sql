-- AVATARS-001 Phase A: convert the company-wide ChatGPT binding into a
-- per-owner avatar binding without changing existing binding/agent IDs.

ALTER TABLE chatgpt_mcp_bindings
    ADD COLUMN IF NOT EXISTS owner_user_id UUID,
    ADD COLUMN IF NOT EXISTS writes_enabled BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS sends_enabled BOOLEAN NOT NULL DEFAULT false;

UPDATE chatgpt_mcp_bindings
SET owner_user_id = authorized_by_user_id
WHERE owner_user_id IS NULL;

DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM chatgpt_mcp_bindings b
        LEFT JOIN company_memberships cm
          ON cm.user_id = b.owner_user_id
         AND cm.company_id = b.company_id
        WHERE b.owner_user_id IS NULL
           OR cm.id IS NULL
    ) THEN
        RAISE EXCEPTION
            'AVATARS_OWNER_MEMBERSHIP_REQUIRED: every binding owner must belong to the binding company';
    END IF;
END $$;

ALTER TABLE chatgpt_mcp_bindings
    ALTER COLUMN owner_user_id SET NOT NULL;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'fk_chatgpt_binding_owner_membership'
          AND conrelid = 'chatgpt_mcp_bindings'::regclass
    ) THEN
        ALTER TABLE chatgpt_mcp_bindings
            ADD CONSTRAINT fk_chatgpt_binding_owner_membership
            FOREIGN KEY (owner_user_id, company_id)
            REFERENCES company_memberships(user_id, company_id)
            ON DELETE RESTRICT;
    END IF;
END $$;

UPDATE chatgpt_mcp_bindings b
SET writes_enabled = EXISTS (
        SELECT 1
        FROM mcp_agent_permission_grants g
        WHERE g.company_id = b.company_id
          AND g.agent_user_id = b.ai_user_id
          AND g.permission_key = 'mcp.tool.svc.create_lead'
    ),
    sends_enabled = EXISTS (
        SELECT 1
        FROM mcp_agent_permission_grants g
        WHERE g.company_id = b.company_id
          AND g.agent_user_id = b.ai_user_id
          AND g.permission_key = 'mcp.tool.svc.send_estimate'
    );

DROP INDEX IF EXISTS uq_chatgpt_mcp_binding_active_company;

CREATE UNIQUE INDEX IF NOT EXISTS uq_chatgpt_mcp_binding_active_owner
    ON chatgpt_mcp_bindings(company_id, owner_user_id)
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
             'agent:chatgpt-crm-mcp:' || b.company_id::text || ':' || b.owner_user_id::text
         AND conflict.id <> ai.id
        WHERE b.status = 'active'
    ) THEN
        RAISE EXCEPTION
            'AVATARS_AI_IDENTITY_CONFLICT: target avatar keycloak_sub already belongs to another CRM user';
    END IF;
END $$;

UPDATE crm_users ai
SET keycloak_sub =
        'agent:chatgpt-crm-mcp:' || b.company_id::text || ':' || b.owner_user_id::text,
    full_name = 'Avatar of ' || COALESCE(
        NULLIF(BTRIM(owner_user.full_name), ''),
        NULLIF(BTRIM(owner_user.email), ''),
        'User'
    ),
    updated_at = NOW()
FROM chatgpt_mcp_bindings b
JOIN crm_users owner_user
  ON owner_user.id = b.owner_user_id
WHERE b.status = 'active'
  AND ai.id = b.ai_user_id
  AND ai.company_id = b.company_id
  AND ai.kind = 'agent';

UPDATE marketplace_apps
SET name = 'Avatars',
    metadata = jsonb_set(
        COALESCE(metadata, '{}'::jsonb),
        '{assistant}',
        '{
          "what_it_does": "Lets each active company member connect a personal ChatGPT avatar whose CRM access follows that member''s live permissions and record visibility.",
          "prerequisites": ["A tenant administrator has enabled Avatars for the company", "The member has an active Albusto company membership", "The Albusto ChatGPT OAuth client is configured in the crm-prod Keycloak realm"],
          "setup_steps": ["A tenant administrator enables Avatars in Settings → Integrations → Marketplace", "Each member connects their own avatar and authorizes the matching Albusto account", "The member may independently enable Writes or Sends for their own avatar"],
          "outcome": "Each connected avatar acts as its owner through a dedicated audit identity and can never exceed the owner''s live CRM access.",
          "recommend_when": ["Team members want personal ChatGPT access to Albusto CRM tools", "A company needs owner-attributed AI actions with live RBAC inheritance"],
          "gotchas": ["One active avatar per person is supported in v1", "Writes and Sends are separate owner-controlled consent tiers", "Disabling the company installation revokes every company avatar", "Payments and file uploads remain unavailable"]
        }'::jsonb,
        true
    ),
    updated_at = NOW()
WHERE app_key = 'chatgpt-crm-mcp';

COMMENT ON COLUMN chatgpt_mcp_bindings.owner_user_id IS
    'Human CRM owner whose live company membership, role, permissions, and scopes cap this avatar.';
COMMENT ON COLUMN chatgpt_mcp_bindings.writes_enabled IS
    'Owner-controlled narrowing tier for internal CRM write tools; never grants a missing human permission.';
COMMENT ON COLUMN chatgpt_mcp_bindings.sends_enabled IS
    'Owner-controlled narrowing tier for customer-send tools; independent from Writes.';

