-- Rollback CHATGPT-CRM-MCP-001 Marketplace seed. Safe to run repeatedly.

DELETE FROM marketplace_installations
WHERE app_id = (SELECT id FROM marketplace_apps WHERE app_key = 'chatgpt-crm-mcp');

DELETE FROM marketplace_apps WHERE app_key = 'chatgpt-crm-mcp';
