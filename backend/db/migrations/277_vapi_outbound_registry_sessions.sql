-- Migration 277: tenant-bound outbound Vapi caller resources and placement evidence.
--
-- Operational caller ids are populated separately. This migration only adds
-- structural ownership constraints and telemetry storage; an empty registry is
-- valid and causes outbound placement to fail closed at runtime.

ALTER TABLE vapi_tenant_resources
    ADD COLUMN IF NOT EXISTS resource_type TEXT NOT NULL DEFAULT 'sip_destination',
    ADD COLUMN IF NOT EXISTS twilio_phone_number TEXT;

ALTER TABLE vapi_call_sessions
    ADD COLUMN IF NOT EXISTS provider_subscription_limits JSONB,
    ADD COLUMN IF NOT EXISTS provider_placement_observed_at TIMESTAMPTZ;

ALTER TABLE vapi_usage_audit_runs
    ADD COLUMN IF NOT EXISTS outbound_identity_repaired_count INTEGER NOT NULL DEFAULT 0;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'chk_vapi_resource_type'
          AND conrelid = 'vapi_tenant_resources'::regclass
    ) THEN
        ALTER TABLE vapi_tenant_resources
            ADD CONSTRAINT chk_vapi_resource_type
            CHECK (resource_type IN (
                'sip_destination', 'vapi_phone_number', 'transient_twilio'
            ));
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'chk_vapi_resource_outbound_caller_shape'
          AND conrelid = 'vapi_tenant_resources'::regclass
    ) THEN
        ALTER TABLE vapi_tenant_resources
            ADD CONSTRAINT chk_vapi_resource_outbound_caller_shape
            CHECK (
                resource_type = 'sip_destination'
                OR (
                    resource_type = 'vapi_phone_number'
                    AND NULLIF(BTRIM(vapi_phone_number_id), '') IS NOT NULL
                    AND twilio_phone_number IS NULL
                )
                OR (
                    resource_type = 'transient_twilio'
                    AND NULLIF(BTRIM(twilio_phone_number), '') IS NOT NULL
                    AND vapi_phone_number_id IS NULL
                )
            );
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'chk_vapi_session_subscription_limits_object'
          AND conrelid = 'vapi_call_sessions'::regclass
    ) THEN
        ALTER TABLE vapi_call_sessions
            ADD CONSTRAINT chk_vapi_session_subscription_limits_object
            CHECK (
                provider_subscription_limits IS NULL
                OR jsonb_typeof(provider_subscription_limits) = 'object'
            );
    END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_vapi_active_transient_twilio_number
    ON vapi_tenant_resources(twilio_phone_number)
    WHERE twilio_phone_number IS NOT NULL AND is_active = true;

CREATE UNIQUE INDEX IF NOT EXISTS uq_vapi_resource_identity_company_connection
    ON vapi_tenant_resources(id, company_id, provider_connection_id);

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'fk_vapi_session_profile_same_company'
          AND conrelid = 'vapi_call_sessions'::regclass
    ) THEN
        ALTER TABLE vapi_call_sessions
            ADD CONSTRAINT fk_vapi_session_profile_same_company
            FOREIGN KEY (assistant_profile_id, company_id, provider_connection_id)
            REFERENCES vapi_assistant_profiles(id, company_id, provider_connection_id)
            NOT VALID;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'fk_vapi_session_resource_same_company'
          AND conrelid = 'vapi_call_sessions'::regclass
    ) THEN
        ALTER TABLE vapi_call_sessions
            ADD CONSTRAINT fk_vapi_session_resource_same_company
            FOREIGN KEY (tenant_resource_id, company_id, provider_connection_id)
            REFERENCES vapi_tenant_resources(id, company_id, provider_connection_id)
            NOT VALID;
    END IF;
END $$;

COMMENT ON COLUMN vapi_tenant_resources.twilio_phone_number IS
    'Platform-only tenant-bound transient Twilio caller id; credentials remain in secret storage';
COMMENT ON COLUMN vapi_call_sessions.provider_subscription_limits IS
    'Diagnostic Vapi POST /call subscriptionLimits snapshot; never an admission authority';
COMMENT ON COLUMN vapi_usage_audit_runs.outbound_identity_repaired_count IS
    'provider_pending outbound sessions bound from server-owned provider call metadata';
