-- AVATARS-001: durably re-assert the "Avatars" marketplace identity + refresh
-- the assistant metadata for the multi-base (ChatGPT + Claude) release.
--
-- Why this exists: migrations in this project are RE-RUN idempotently on every
-- deploy (schema_migrations is legacy/untracked). The original seed 196
-- (INSERT ... ON CONFLICT (app_key) DO UPDATE SET name = EXCLUDED.name, ...)
-- therefore re-clobbers this row back to "ChatGPT CRM Connector" on any deploy
-- whose migration set stops before 200 — observed on prod 2026-07-25, which
-- reverted migration 200's rename. Being the highest-numbered migration that
-- touches this row, this file makes a full replay end on "Avatars". It does NOT
-- protect against a deploy from a branch that lacks this migration — the durable
-- cure there is to only deploy from master (or rebase branches on master first).
--
-- Idempotent: a plain UPDATE, safe to re-run.

UPDATE marketplace_apps
SET name = 'Avatars',
    short_description = 'Give each member a personal AI avatar (ChatGPT or Claude) that works in Albusto with their own access.',
    metadata = jsonb_set(
        COALESCE(metadata, '{}'::jsonb),
        '{assistant}',
        '{
          "what_it_does": "Lets each active company member connect a personal ChatGPT or Claude avatar whose CRM access follows that member''s live permissions and record visibility.",
          "prerequisites": ["A tenant administrator has enabled Avatars for the company", "The member has an active Albusto company membership", "The matching Albusto OAuth client (ChatGPT or Claude) is configured in the crm-prod Keycloak realm"],
          "setup_steps": ["A tenant administrator enables Avatars in Settings → Integrations → Marketplace", "Each member connects their own avatar and authorizes the matching Albusto account", "The member may independently enable Writes or Sends for their own avatar"],
          "outcome": "Each connected avatar acts as its owner through a dedicated audit identity and can never exceed the owner''s live CRM access.",
          "recommend_when": ["Team members want personal ChatGPT or Claude access to Albusto CRM tools", "A company needs owner-attributed AI actions with live RBAC inheritance"],
          "gotchas": ["One active avatar per person in v1 — choosing a different base re-points the same avatar", "Writes and Sends are separate owner-controlled consent tiers", "Disabling the company installation revokes every company avatar", "Payments and file uploads remain unavailable"]
        }'::jsonb,
        true
    ),
    updated_at = NOW()
WHERE app_key = 'chatgpt-crm-mcp';
