-- Rollback 202: restore the migration-200 "Avatars" state (single-base ChatGPT
-- wording). Deliberately keeps name = 'Avatars' — reverting to
-- "ChatGPT CRM Connector" would re-introduce the very bug 202 fixes.

UPDATE marketplace_apps
SET name = 'Avatars',
    short_description = 'Let each member connect a personal ChatGPT avatar that works in Albusto with their own access.',
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
