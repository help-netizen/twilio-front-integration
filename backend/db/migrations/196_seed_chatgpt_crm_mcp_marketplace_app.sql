-- CHATGPT-CRM-MCP-001: OAuth CRM connector Marketplace app.

INSERT INTO marketplace_apps (
    app_key, name, provider_name, category, app_type,
    short_description, long_description,
    requested_scopes, provisioning_mode, status,
    support_email, privacy_url, docs_url, metadata
) VALUES (
    'chatgpt-crm-mcp',
    'ChatGPT CRM Connector',
    'Albusto',
    'ai',
    'internal',
    'Lets an authorized ChatGPT connector read company CRM records through a tenant-bound AI identity.',
    'Connects ChatGPT to company-scoped Albusto jobs, leads, contacts, schedules, tasks, estimates, and invoices. Every tool requires an exact AI-only permission grant and an active tenant-admin authorization binding.',
    '["jobs:read","leads:read","contacts:read","schedule:read","tasks:read","estimates:read","invoices:read"]'::jsonb,
    'none',
    'published',
    'support@albusto.com',
    'https://albusto.com/privacy',
    '/docs/integrations/chatgpt-crm-mcp',
    '{
      "access_summary": ["Read Jobs, Leads, Contacts, and Schedule", "Read Tasks, Estimates, and Invoices"],
      "requires_credential_input": false,
      "oauth_resource": "https://api.albusto.com/mcp/chatgpt",
      "assistant": {
        "what_it_does": "Lets an authorized ChatGPT connector look up company CRM records through a dedicated, tenant-bound AI dispatcher identity.",
        "prerequisites": ["A tenant administrator", "The Albusto ChatGPT OAuth client configured in the crm-prod Keycloak realm"],
        "setup_steps": ["Settings → Integrations → Marketplace → ChatGPT CRM Connector → Connect", "Authorize the matching Albusto account from ChatGPT"],
        "outcome": "ChatGPT can use only the explicitly granted, company-scoped CRM tools while the installation and authorizer remain active.",
        "recommend_when": ["User wants ChatGPT to look up Jobs, Leads, Contacts, Schedule, Tasks, Estimates, or Invoices", "User wants a tenant-bound CRM connector with revocable access"],
        "gotchas": ["Only tenant administrators can connect or disconnect it", "Disconnecting immediately blocks still-unexpired tokens", "Payments and customer sends are not part of the read-only S1 release"]
      }
    }'::jsonb
)
ON CONFLICT (app_key) DO UPDATE SET
    name = EXCLUDED.name,
    provider_name = EXCLUDED.provider_name,
    category = EXCLUDED.category,
    app_type = EXCLUDED.app_type,
    short_description = EXCLUDED.short_description,
    long_description = EXCLUDED.long_description,
    requested_scopes = EXCLUDED.requested_scopes,
    provisioning_mode = EXCLUDED.provisioning_mode,
    status = EXCLUDED.status,
    support_email = EXCLUDED.support_email,
    privacy_url = EXCLUDED.privacy_url,
    docs_url = EXCLUDED.docs_url,
    metadata = EXCLUDED.metadata,
    updated_at = NOW();
