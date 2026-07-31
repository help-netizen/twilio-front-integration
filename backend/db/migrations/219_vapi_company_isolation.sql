-- Migration 219: bind legacy Vapi integration rows to an explicit company.
--
-- Vapi is currently configured only for ABC Homes LLC. The generic
-- provider_connections table may contain other provider types in future, so
-- its backfill and indexes are restricted to provider = 'vapi'. Legacy
-- tenant_id values remain intact for compatibility; company_id is the tenant
-- authorization key from this migration forward.

ALTER TABLE provider_connections
    ADD COLUMN IF NOT EXISTS company_id UUID;
ALTER TABLE vapi_tenant_resources
    ADD COLUMN IF NOT EXISTS company_id UUID;
ALTER TABLE vapi_assistant_profiles
    ADD COLUMN IF NOT EXISTS company_id UUID;
ALTER TABLE call_flow_node_configs
    ADD COLUMN IF NOT EXISTS company_id UUID;
ALTER TABLE call_ai_runs
    ADD COLUMN IF NOT EXISTS company_id UUID;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'fk_provider_connections_company'
          AND conrelid = 'provider_connections'::regclass
    ) THEN
        ALTER TABLE provider_connections
            ADD CONSTRAINT fk_provider_connections_company
            FOREIGN KEY (company_id) REFERENCES companies(id);
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'fk_vapi_tenant_resources_company'
          AND conrelid = 'vapi_tenant_resources'::regclass
    ) THEN
        ALTER TABLE vapi_tenant_resources
            ADD CONSTRAINT fk_vapi_tenant_resources_company
            FOREIGN KEY (company_id) REFERENCES companies(id);
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'fk_vapi_assistant_profiles_company'
          AND conrelid = 'vapi_assistant_profiles'::regclass
    ) THEN
        ALTER TABLE vapi_assistant_profiles
            ADD CONSTRAINT fk_vapi_assistant_profiles_company
            FOREIGN KEY (company_id) REFERENCES companies(id);
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'fk_call_flow_node_configs_company'
          AND conrelid = 'call_flow_node_configs'::regclass
    ) THEN
        ALTER TABLE call_flow_node_configs
            ADD CONSTRAINT fk_call_flow_node_configs_company
            FOREIGN KEY (company_id) REFERENCES companies(id);
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'fk_call_ai_runs_company'
          AND conrelid = 'call_ai_runs'::regclass
    ) THEN
        ALTER TABLE call_ai_runs
            ADD CONSTRAINT fk_call_ai_runs_company
            FOREIGN KEY (company_id) REFERENCES companies(id);
    END IF;
END $$;

UPDATE provider_connections
SET company_id = '00000000-0000-0000-0000-000000000001'::uuid
WHERE tenant_id = 'default'
  AND provider = 'vapi'
  AND company_id IS DISTINCT FROM '00000000-0000-0000-0000-000000000001'::uuid;

UPDATE vapi_tenant_resources resource
SET company_id = '00000000-0000-0000-0000-000000000001'::uuid
FROM provider_connections connection
WHERE resource.tenant_id = 'default'
  AND resource.provider_connection_id = connection.id
  AND connection.provider = 'vapi'
  AND connection.company_id = '00000000-0000-0000-0000-000000000001'::uuid
  AND resource.company_id IS DISTINCT FROM '00000000-0000-0000-0000-000000000001'::uuid;

UPDATE vapi_assistant_profiles profile
SET company_id = '00000000-0000-0000-0000-000000000001'::uuid
FROM provider_connections connection
WHERE profile.tenant_id = 'default'
  AND profile.provider_connection_id = connection.id
  AND connection.provider = 'vapi'
  AND connection.company_id = '00000000-0000-0000-0000-000000000001'::uuid
  AND profile.company_id IS DISTINCT FROM '00000000-0000-0000-0000-000000000001'::uuid;

UPDATE call_flow_node_configs
SET company_id = '00000000-0000-0000-0000-000000000001'::uuid
WHERE tenant_id = 'default'
  AND node_kind = 'vapi_agent'
  AND company_id IS DISTINCT FROM '00000000-0000-0000-0000-000000000001'::uuid;

UPDATE call_ai_runs
SET company_id = '00000000-0000-0000-0000-000000000001'::uuid
WHERE tenant_id = 'default'
  AND provider = 'vapi'
  AND company_id IS DISTINCT FROM '00000000-0000-0000-0000-000000000001'::uuid;

CREATE UNIQUE INDEX IF NOT EXISTS uq_provider_connections_company_provider_env
    ON provider_connections(company_id, provider, environment);
CREATE UNIQUE INDEX IF NOT EXISTS uq_vapi_resources_company_env
    ON vapi_tenant_resources(company_id, environment);
CREATE UNIQUE INDEX IF NOT EXISTS uq_vapi_profiles_company_slug
    ON vapi_assistant_profiles(company_id, slug);
CREATE UNIQUE INDEX IF NOT EXISTS uq_vapi_node_configs_company_flow_node
    ON call_flow_node_configs(company_id, flow_id, node_id);
CREATE INDEX IF NOT EXISTS idx_vapi_ai_runs_company_created
    ON call_ai_runs(company_id, created_at DESC)
    WHERE provider = 'vapi';
