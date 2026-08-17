-- Rollback 280: remove VAPI agency provisioning recovery state.

ALTER TABLE vapi_tenant_provisioning_runs
    DROP COLUMN IF EXISTS last_successful_template_variables,
    DROP COLUMN IF EXISTS previous_rollout_state;

DROP INDEX IF EXISTS uq_vapi_resource_fallback_assistant;

ALTER TABLE vapi_call_sessions
    DROP CONSTRAINT IF EXISTS fk_vapi_session_request_credential_same_company;

DROP TABLE IF EXISTS vapi_company_credential_acceptance;

ALTER TABLE vapi_call_sessions
    ADD CONSTRAINT fk_vapi_call_sessions_resource_tuple
    FOREIGN KEY (
        tenant_resource_id,
        company_id,
        provider_connection_id,
        assistant_profile_id,
        assistant_request_credential_id
    ) REFERENCES vapi_tenant_resources(
        id,
        company_id,
        provider_connection_id,
        assistant_profile_id,
        server_credential_id
    ) NOT VALID;

ALTER TABLE vapi_tenant_resources
    DROP CONSTRAINT IF EXISTS chk_vapi_resource_fallback_assistant_nonempty,
    DROP COLUMN IF EXISTS fallback_vapi_assistant_id;
