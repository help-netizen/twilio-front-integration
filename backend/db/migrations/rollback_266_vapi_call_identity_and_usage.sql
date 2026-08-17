-- Rollback 266. Refuse to discard any usage evidence or provisioned T2
-- assistant-request binding. Legacy calls/outbound attempts are never modified.

DO $$
DECLARE
    evidence_table TEXT;
    has_evidence BOOLEAN;
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

    FOREACH evidence_table IN ARRAY ARRAY[
        'vapi_call_usage_final_snapshots',
        'vapi_call_usage_adjustments',
        'vapi_usage_audit_runs',
        'vapi_usage_alerts',
        'vapi_provider_message_quarantine',
        'vapi_call_cost_input_events',
        'vapi_usage_alert_delivery_runs',
        'vapi_tenant_voice_configs',
        'vapi_tenant_provisioning_runs',
        'vapi_company_credential_acceptance'
    ] LOOP
        IF to_regclass(evidence_table) IS NOT NULL THEN
            EXECUTE format(
                'SELECT EXISTS (SELECT 1 FROM %I LIMIT 1)',
                evidence_table
            ) INTO has_evidence;
            IF has_evidence THEN
                RAISE EXCEPTION
                    'VAPI_AGENCY_266_ROLLBACK_BLOCKED: preserve downstream evidence in % first',
                    evidence_table;
            END IF;
        END IF;
    END LOOP;

END $$;

-- 266 is the root of the call-identity schema. A direct rollback on a database
-- that has later Vapi migrations must remove their empty dependent structures
-- in reverse dependency order; leaving FK-less descendants is not a rollback.
DROP TABLE IF EXISTS vapi_usage_alert_delivery_items;

ALTER TABLE IF EXISTS vapi_usage_alerts
    DROP COLUMN IF EXISTS last_delivery_run_id;

DROP TABLE IF EXISTS vapi_usage_alert_delivery_runs;
DROP TABLE IF EXISTS vapi_call_cost_input_events;
DROP FUNCTION IF EXISTS prevent_vapi_cost_input_mutation();
DROP TABLE IF EXISTS vapi_fallback_rate_policies;

DROP TABLE IF EXISTS vapi_provider_message_quarantine;
DROP TABLE IF EXISTS vapi_call_usage_adjustments;
DROP TABLE IF EXISTS vapi_call_usage_final_snapshots;
DROP FUNCTION IF EXISTS prevent_vapi_final_snapshot_mutation();
DROP TABLE IF EXISTS vapi_usage_alerts;
DROP TABLE IF EXISTS vapi_usage_audit_runs;

DROP TABLE IF EXISTS vapi_company_credential_acceptance;
DROP TABLE IF EXISTS vapi_tenant_provisioning_runs;
DROP TABLE IF EXISTS vapi_tenant_voice_configs;

ALTER TABLE vapi_call_sessions
    DROP CONSTRAINT IF EXISTS fk_vapi_session_request_credential_same_company,
    DROP CONSTRAINT IF EXISTS fk_vapi_session_resource_same_company,
    DROP CONSTRAINT IF EXISTS fk_vapi_session_profile_same_company,
    DROP CONSTRAINT IF EXISTS chk_vapi_session_subscription_limits_object,
    DROP COLUMN IF EXISTS provider_placement_observed_at,
    DROP COLUMN IF EXISTS provider_subscription_limits;

DROP INDEX IF EXISTS uq_vapi_resource_fallback_assistant;
DROP INDEX IF EXISTS uq_vapi_resource_identity_company_connection;
DROP INDEX IF EXISTS uq_vapi_active_transient_twilio_number;
DROP INDEX IF EXISTS uq_vapi_active_provider_resource;
DROP INDEX IF EXISTS uq_vapi_active_sip_uri;
DROP INDEX IF EXISTS uq_vapi_profiles_platform_assistant;

ALTER TABLE vapi_tenant_resources
    DROP CONSTRAINT IF EXISTS chk_vapi_resource_fallback_assistant_nonempty,
    DROP CONSTRAINT IF EXISTS chk_vapi_resource_outbound_caller_shape,
    DROP CONSTRAINT IF EXISTS chk_vapi_resource_type,
    DROP CONSTRAINT IF EXISTS chk_vapi_resource_no_plaintext_secret,
    DROP CONSTRAINT IF EXISTS chk_vapi_resource_status,
    DROP COLUMN IF EXISTS fallback_vapi_assistant_id,
    DROP COLUMN IF EXISTS last_verified_at,
    DROP COLUMN IF EXISTS provider_updated_at,
    DROP COLUMN IF EXISTS config_hash,
    DROP COLUMN IF EXISTS twilio_phone_number,
    DROP COLUMN IF EXISTS resource_type,
    DROP COLUMN IF EXISTS status;

ALTER TABLE vapi_assistant_profiles
    DROP CONSTRAINT IF EXISTS fk_vapi_profile_status_credential_same_company,
    DROP CONSTRAINT IF EXISTS fk_vapi_profile_tools_credential_same_company,
    DROP CONSTRAINT IF EXISTS chk_vapi_profile_no_tenant_base_config,
    DROP CONSTRAINT IF EXISTS chk_vapi_profile_status,
    DROP CONSTRAINT IF EXISTS chk_vapi_profile_provider_account,
    DROP COLUMN IF EXISTS last_verified_at,
    DROP COLUMN IF EXISTS provider_updated_at,
    DROP COLUMN IF EXISTS provider_generation,
    DROP COLUMN IF EXISTS call_status_credential_id,
    DROP COLUMN IF EXISTS tools_credential_id,
    DROP COLUMN IF EXISTS template_hash,
    DROP COLUMN IF EXISTS template_version,
    DROP COLUMN IF EXISTS status,
    DROP COLUMN IF EXISTS provider_account_key;

ALTER TABLE provider_connections
    DROP CONSTRAINT IF EXISTS chk_vapi_connection_platform_key_only;

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
