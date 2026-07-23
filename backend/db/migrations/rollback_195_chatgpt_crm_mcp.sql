-- Rollback CHATGPT-CRM-MCP-001 S1 schema. Safe to run repeatedly.

DROP TABLE IF EXISTS mcp_tool_idempotency;
DROP TABLE IF EXISTS mcp_tool_invocations;
DROP TABLE IF EXISTS mcp_agent_permission_grants;
DROP TABLE IF EXISTS chatgpt_mcp_bindings;

DELETE FROM crm_users
WHERE kind = 'agent'
  AND keycloak_sub LIKE 'agent:chatgpt-crm-mcp:%';

DROP INDEX IF EXISTS uq_marketplace_installations_company_id_id;
DROP INDEX IF EXISTS uq_crm_users_company_id_id;

ALTER TABLE crm_users DROP CONSTRAINT IF EXISTS crm_users_kind_check;
ALTER TABLE crm_users DROP COLUMN IF EXISTS kind;
