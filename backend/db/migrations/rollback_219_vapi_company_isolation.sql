-- Rollback 219: remove explicit Vapi company ownership.

DROP INDEX IF EXISTS idx_vapi_ai_runs_company_created;
DROP INDEX IF EXISTS uq_vapi_node_configs_company_flow_node;
DROP INDEX IF EXISTS uq_vapi_profiles_company_slug;
DROP INDEX IF EXISTS uq_vapi_resources_company_env;
DROP INDEX IF EXISTS uq_provider_connections_company_provider_env;

ALTER TABLE call_ai_runs
    DROP CONSTRAINT IF EXISTS fk_call_ai_runs_company,
    DROP COLUMN IF EXISTS company_id;
ALTER TABLE call_flow_node_configs
    DROP CONSTRAINT IF EXISTS fk_call_flow_node_configs_company,
    DROP COLUMN IF EXISTS company_id;
ALTER TABLE vapi_assistant_profiles
    DROP CONSTRAINT IF EXISTS fk_vapi_assistant_profiles_company,
    DROP COLUMN IF EXISTS company_id;
ALTER TABLE vapi_tenant_resources
    DROP CONSTRAINT IF EXISTS fk_vapi_tenant_resources_company,
    DROP COLUMN IF EXISTS company_id;
ALTER TABLE provider_connections
    DROP CONSTRAINT IF EXISTS fk_provider_connections_company,
    DROP COLUMN IF EXISTS company_id;
