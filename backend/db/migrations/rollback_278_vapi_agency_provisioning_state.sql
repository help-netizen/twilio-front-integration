DROP TABLE IF EXISTS vapi_tenant_provisioning_runs;

ALTER TABLE vapi_tenant_resources
    DROP COLUMN IF EXISTS last_verified_at,
    DROP COLUMN IF EXISTS provider_updated_at,
    DROP COLUMN IF EXISTS config_hash;
