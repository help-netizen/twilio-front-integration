-- Rollback CHATGPT-CRM-MCP-001 connector documentation link.

UPDATE marketplace_apps
SET docs_url = '/docs/integrations/chatgpt-crm-mcp',
    updated_at = NOW()
WHERE app_key = 'chatgpt-crm-mcp'
  AND docs_url = '/settings/integrations?tab=marketplace&app=chatgpt-crm-mcp';
