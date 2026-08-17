ALTER TABLE vapi_call_sessions
    DROP CONSTRAINT IF EXISTS fk_vapi_session_resource_same_company,
    DROP CONSTRAINT IF EXISTS fk_vapi_session_profile_same_company,
    DROP CONSTRAINT IF EXISTS chk_vapi_session_subscription_limits_object;

DROP INDEX IF EXISTS uq_vapi_resource_identity_company_connection;
DROP INDEX IF EXISTS uq_vapi_active_transient_twilio_number;

ALTER TABLE vapi_tenant_resources
    DROP CONSTRAINT IF EXISTS chk_vapi_resource_outbound_caller_shape,
    DROP CONSTRAINT IF EXISTS chk_vapi_resource_type;

ALTER TABLE vapi_call_sessions
    DROP COLUMN IF EXISTS provider_placement_observed_at,
    DROP COLUMN IF EXISTS provider_subscription_limits;

ALTER TABLE vapi_usage_audit_runs
    DROP COLUMN IF EXISTS outbound_identity_repaired_count;

ALTER TABLE vapi_tenant_resources
    DROP COLUMN IF EXISTS twilio_phone_number,
    DROP COLUMN IF EXISTS resource_type;
