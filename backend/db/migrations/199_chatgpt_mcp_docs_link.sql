-- CHATGPT-CRM-MCP-001 hardening: point connector documentation at the live
-- Marketplace setup panel. Keep the assistant metadata complete when an older
-- row is missing it.

UPDATE marketplace_apps
SET docs_url = '/settings/integrations?tab=marketplace&app=chatgpt-crm-mcp',
    metadata = jsonb_set(
        COALESCE(metadata, '{}'::jsonb),
        '{assistant}',
        COALESCE(
            metadata->'assistant',
            '{
              "what_it_does": "Lets an authorized ChatGPT connector look up company CRM records through a dedicated, tenant-bound AI dispatcher identity.",
              "prerequisites": ["A tenant administrator", "The Albusto ChatGPT OAuth client configured in the crm-prod Keycloak realm"],
              "setup_steps": ["Settings → Integrations → Marketplace → ChatGPT CRM Connector → Connect", "Authorize the matching Albusto account from ChatGPT"],
              "outcome": "ChatGPT can use only the explicitly granted, company-scoped CRM tools while the installation and authorizer remain active.",
              "recommend_when": ["User wants ChatGPT to look up Jobs, Leads, Contacts, Schedule, Tasks, Estimates, Invoices, or recent Calls", "User wants a tenant-bound CRM connector with revocable access"],
              "gotchas": ["Only tenant administrators can connect or disconnect it", "Disconnecting immediately blocks still-unexpired tokens", "Payments and customer sends are outside the current release"]
            }'::jsonb
        ),
        true
    ),
    updated_at = NOW()
WHERE app_key = 'chatgpt-crm-mcp'
  AND (
      docs_url IS DISTINCT FROM '/settings/integrations?tab=marketplace&app=chatgpt-crm-mcp'
      OR metadata->'assistant' IS NULL
  );
