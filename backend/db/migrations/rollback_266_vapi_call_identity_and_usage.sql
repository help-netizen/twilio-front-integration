-- Rollback 266. Refuse to discard any usage evidence or provisioned T2
-- assistant-request binding. Legacy calls/outbound attempts are never modified.

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM vapi_call_usage_observations)
       OR EXISTS (SELECT 1 FROM vapi_call_usage) THEN
        RAISE EXCEPTION
            'VAPI_AGENCY_266_ROLLBACK_BLOCKED: remove/project supplier usage evidence first';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM vapi_tenant_resources
        WHERE assistant_profile_id IS NOT NULL
           OR server_credential_id IS NOT NULL
    ) OR EXISTS (
        SELECT 1
        FROM api_integrations
        WHERE machine_surface IN ('vapi_call_status', 'vapi_assistant_request')
    ) THEN
        RAISE EXCEPTION
            'VAPI_AGENCY_266_ROLLBACK_BLOCKED: retire resource bindings and machine credentials first';
    END IF;

END $$;

DROP TRIGGER IF EXISTS trg_vapi_call_usage_updated_at ON vapi_call_usage;
DROP TABLE IF EXISTS vapi_call_usage;
DROP TABLE IF EXISTS vapi_call_usage_observations;

DROP TRIGGER IF EXISTS trg_vapi_call_sessions_updated_at ON vapi_call_sessions;
DROP TABLE IF EXISTS vapi_call_sessions;

ALTER TABLE vapi_tenant_resources
    DROP CONSTRAINT IF EXISTS fk_vapi_resource_credential_same_company,
    DROP CONSTRAINT IF EXISTS fk_vapi_resource_assistant_same_company,
    DROP CONSTRAINT IF EXISTS fk_vapi_resource_connection_same_company,
    DROP CONSTRAINT IF EXISTS chk_vapi_tenant_resources_purpose;

ALTER TABLE vapi_assistant_profiles
    DROP CONSTRAINT IF EXISTS fk_vapi_profile_connection_same_company;

DROP INDEX IF EXISTS uq_vapi_resource_session_tuple;
DROP INDEX IF EXISTS uq_vapi_profiles_company_purpose_env;
DROP INDEX IF EXISTS uq_vapi_resources_company_purpose_env;
DROP INDEX IF EXISTS uq_api_integrations_id_company;
DROP INDEX IF EXISTS uq_provider_connections_id_company;
DROP INDEX IF EXISTS idx_provider_connections_provider_org;
DROP INDEX IF EXISTS uq_vapi_profiles_identity_company_connection;

ALTER TABLE vapi_tenant_resources
    DROP COLUMN IF EXISTS server_credential_id,
    DROP COLUMN IF EXISTS assistant_profile_id,
    DROP COLUMN IF EXISTS purpose;

ALTER TABLE vapi_assistant_profiles
    DROP COLUMN IF EXISTS environment;

CREATE UNIQUE INDEX IF NOT EXISTS uq_vapi_resource_tenant_env
    ON vapi_tenant_resources(tenant_id, environment);

CREATE UNIQUE INDEX IF NOT EXISTS uq_vapi_resources_company_env
    ON vapi_tenant_resources(company_id, environment);

CREATE UNIQUE INDEX IF NOT EXISTS uq_provider_connections_provider_org
    ON provider_connections(provider, provider_org_id)
    WHERE provider_org_id IS NOT NULL;

ALTER TABLE api_integrations
    DROP CONSTRAINT IF EXISTS chk_api_integrations_machine_surface;

ALTER TABLE api_integrations
    ADD CONSTRAINT chk_api_integrations_machine_surface
    CHECK (machine_surface IS NULL OR machine_surface IN ('vapi_tools', 'sales_mcp_public'));
