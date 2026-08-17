-- Migration 275: schema for the platform-owned Vapi assistant registry.
--
-- This migration is intentionally data-neutral. Deployment environment values,
-- provider resources and machine credentials are operational state which
-- PostgreSQL cannot discover. Operators populate a selected company with:
--
--   node backend/scripts/bootstrap-vapi-assistant-registry.js \
--     --company-id <uuid>              # dry-run
--   node backend/scripts/bootstrap-vapi-assistant-registry.js \
--     --company-id <uuid> --apply      # write
--
-- Missing operational data must never prevent this structural migration from
-- applying on a fresh, staging or restored database.

CREATE TABLE IF NOT EXISTS vapi_tenant_voice_configs (
    id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id                  UUID NOT NULL REFERENCES companies(id),
    environment                 TEXT NOT NULL,
    rollout_state               TEXT NOT NULL DEFAULT 'legacy_canary',
    company_concurrency_limit   INTEGER,
    fallback_flow_node_id       TEXT,
    readiness_evidence          JSONB NOT NULL DEFAULT '{}'::jsonb,
    verified_at                 TIMESTAMPTZ,
    enabled_at                  TIMESTAMPTZ,
    enabled_by                  UUID REFERENCES crm_users(id),
    suspended_at                TIMESTAMPTZ,
    suspend_reason              TEXT,
    created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT chk_vapi_voice_config_environment
        CHECK (environment IN ('prod')),
    CONSTRAINT chk_vapi_voice_config_rollout_state
        CHECK (rollout_state IN ('legacy_canary', 'provisioning', 'ready', 'enabled', 'suspended')),
    CONSTRAINT chk_vapi_voice_config_concurrency
        CHECK (company_concurrency_limit IS NULL OR company_concurrency_limit > 0),
    CONSTRAINT uq_vapi_voice_config_company_environment
        UNIQUE (company_id, environment)
);

DROP TRIGGER IF EXISTS trg_vapi_tenant_voice_configs_updated_at
    ON vapi_tenant_voice_configs;
CREATE TRIGGER trg_vapi_tenant_voice_configs_updated_at
    BEFORE UPDATE ON vapi_tenant_voice_configs
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

ALTER TABLE vapi_assistant_profiles
    ADD COLUMN IF NOT EXISTS provider_account_key TEXT,
    ADD COLUMN IF NOT EXISTS status TEXT,
    ADD COLUMN IF NOT EXISTS template_version TEXT,
    ADD COLUMN IF NOT EXISTS template_hash TEXT,
    ADD COLUMN IF NOT EXISTS tools_credential_id BIGINT,
    ADD COLUMN IF NOT EXISTS call_status_credential_id BIGINT,
    ADD COLUMN IF NOT EXISTS provider_generation TEXT,
    ADD COLUMN IF NOT EXISTS provider_updated_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS last_verified_at TIMESTAMPTZ;

ALTER TABLE vapi_tenant_resources
    ADD COLUMN IF NOT EXISTS status TEXT;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'chk_vapi_profile_provider_account'
          AND conrelid = 'vapi_assistant_profiles'::regclass
    ) THEN
        ALTER TABLE vapi_assistant_profiles
            ADD CONSTRAINT chk_vapi_profile_provider_account
            CHECK (provider_account_key IS NULL OR provider_account_key = 'vapi:platform')
            NOT VALID;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'chk_vapi_profile_status'
          AND conrelid = 'vapi_assistant_profiles'::regclass
    ) THEN
        ALTER TABLE vapi_assistant_profiles
            ADD CONSTRAINT chk_vapi_profile_status
            CHECK (status IS NULL OR status IN ('provisioning', 'active', 'drifted', 'disabled', 'deleting'))
            NOT VALID;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'chk_vapi_profile_no_tenant_base_config'
          AND conrelid = 'vapi_assistant_profiles'::regclass
    ) THEN
        ALTER TABLE vapi_assistant_profiles
            ADD CONSTRAINT chk_vapi_profile_no_tenant_base_config
            CHECK (base_config_json IS NULL)
            NOT VALID;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'chk_vapi_resource_status'
          AND conrelid = 'vapi_tenant_resources'::regclass
    ) THEN
        ALTER TABLE vapi_tenant_resources
            ADD CONSTRAINT chk_vapi_resource_status
            CHECK (status IS NULL OR status IN ('provisioning', 'active', 'drifted', 'disabled', 'deleting'))
            NOT VALID;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'chk_vapi_resource_no_plaintext_secret'
          AND conrelid = 'vapi_tenant_resources'::regclass
    ) THEN
        ALTER TABLE vapi_tenant_resources
            ADD CONSTRAINT chk_vapi_resource_no_plaintext_secret
            CHECK (assistant_request_secret IS NULL)
            NOT VALID;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'chk_vapi_connection_platform_key_only'
          AND conrelid = 'provider_connections'::regclass
    ) THEN
        ALTER TABLE provider_connections
            ADD CONSTRAINT chk_vapi_connection_platform_key_only
            CHECK (provider <> 'vapi' OR encrypted_credentials_json IS NULL)
            NOT VALID;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'fk_vapi_profile_tools_credential_same_company'
          AND conrelid = 'vapi_assistant_profiles'::regclass
    ) THEN
        ALTER TABLE vapi_assistant_profiles
            ADD CONSTRAINT fk_vapi_profile_tools_credential_same_company
            FOREIGN KEY (tools_credential_id, company_id)
            REFERENCES api_integrations(id, company_id)
            NOT VALID;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'fk_vapi_profile_status_credential_same_company'
          AND conrelid = 'vapi_assistant_profiles'::regclass
    ) THEN
        ALTER TABLE vapi_assistant_profiles
            ADD CONSTRAINT fk_vapi_profile_status_credential_same_company
            FOREIGN KEY (call_status_credential_id, company_id)
            REFERENCES api_integrations(id, company_id)
            NOT VALID;
    END IF;
END $$;

-- With exactly one platform account, provider assistant identity is globally
-- unique. No company-derived account key can fragment the namespace.
CREATE UNIQUE INDEX IF NOT EXISTS uq_vapi_profiles_platform_assistant
    ON vapi_assistant_profiles(vapi_assistant_id)
    WHERE vapi_assistant_id IS NOT NULL;

DROP INDEX IF EXISTS uq_vapi_profiles_company_purpose_env;
CREATE UNIQUE INDEX uq_vapi_profiles_company_purpose_env
    ON vapi_assistant_profiles(company_id, purpose, environment);

CREATE UNIQUE INDEX IF NOT EXISTS uq_vapi_active_sip_uri
    ON vapi_tenant_resources(sip_uri)
    WHERE sip_uri IS NOT NULL AND is_active = true;

CREATE UNIQUE INDEX IF NOT EXISTS uq_vapi_active_provider_resource
    ON vapi_tenant_resources(vapi_phone_number_id)
    WHERE vapi_phone_number_id IS NOT NULL AND is_active = true;

COMMENT ON TABLE vapi_tenant_voice_configs IS
    'Platform-owned voice rollout configuration; no tenant write route';
COMMENT ON COLUMN vapi_assistant_profiles.provider_account_key IS
    'Single platform Vapi account key; constrained constant, never derived from a tenant connection';
COMMENT ON COLUMN vapi_assistant_profiles.base_config_json IS
    'Retired tenant-editable provider config; constrained NULL after VAPI-AGENCY-001 T5';
