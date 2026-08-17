-- Rollback 275 removes only registry schema introduced by migration 275.
-- Operational rows created by bootstrap-vapi-assistant-registry.js are not
-- guessed, deleted or rewritten by a structural rollback.

DROP INDEX IF EXISTS uq_vapi_active_provider_resource;
DROP INDEX IF EXISTS uq_vapi_active_sip_uri;
DROP INDEX IF EXISTS uq_vapi_profiles_platform_assistant;

DROP INDEX IF EXISTS uq_vapi_profiles_company_purpose_env;
CREATE UNIQUE INDEX IF NOT EXISTS uq_vapi_profiles_company_purpose_env
    ON vapi_assistant_profiles(company_id, purpose, environment)
    WHERE company_id IS NOT NULL AND purpose IS NOT NULL;

ALTER TABLE vapi_assistant_profiles
    DROP CONSTRAINT IF EXISTS fk_vapi_profile_status_credential_same_company,
    DROP CONSTRAINT IF EXISTS fk_vapi_profile_tools_credential_same_company,
    DROP CONSTRAINT IF EXISTS chk_vapi_profile_no_tenant_base_config,
    DROP CONSTRAINT IF EXISTS chk_vapi_profile_status,
    DROP CONSTRAINT IF EXISTS chk_vapi_profile_provider_account;

ALTER TABLE vapi_tenant_resources
    DROP CONSTRAINT IF EXISTS chk_vapi_resource_no_plaintext_secret,
    DROP CONSTRAINT IF EXISTS chk_vapi_resource_status;

ALTER TABLE provider_connections
    DROP CONSTRAINT IF EXISTS chk_vapi_connection_platform_key_only;

ALTER TABLE vapi_tenant_resources
    DROP COLUMN IF EXISTS status;

ALTER TABLE vapi_assistant_profiles
    DROP COLUMN IF EXISTS last_verified_at,
    DROP COLUMN IF EXISTS provider_updated_at,
    DROP COLUMN IF EXISTS provider_generation,
    DROP COLUMN IF EXISTS call_status_credential_id,
    DROP COLUMN IF EXISTS tools_credential_id,
    DROP COLUMN IF EXISTS template_hash,
    DROP COLUMN IF EXISTS template_version,
    DROP COLUMN IF EXISTS status,
    DROP COLUMN IF EXISTS provider_account_key;

DROP TABLE IF EXISTS vapi_tenant_voice_configs;
