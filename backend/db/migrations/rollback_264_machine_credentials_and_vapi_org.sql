-- Rollback 264. Refuse to erase the meaning of live machine credentials.
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM api_integrations
        WHERE machine_surface IS NOT NULL
    ) OR EXISTS (
        SELECT 1 FROM provider_connections
        WHERE provider_org_id IS NOT NULL
    ) THEN
        RAISE EXCEPTION
            'TENANT_ISO_264_ROLLBACK_BLOCKED: remove machine credentials and Vapi org bindings first';
    END IF;
END $$;

DROP INDEX IF EXISTS uq_provider_connections_provider_org;
ALTER TABLE provider_connections
    DROP COLUMN IF EXISTS provider_org_id;

DROP INDEX IF EXISTS idx_api_integrations_machine_company;
DROP INDEX IF EXISTS uq_api_integrations_machine_secret;
ALTER TABLE api_integrations
    DROP CONSTRAINT IF EXISTS fk_api_integrations_actor_membership,
    DROP CONSTRAINT IF EXISTS chk_api_integrations_machine_actor,
    DROP CONSTRAINT IF EXISTS chk_api_integrations_machine_surface,
    DROP COLUMN IF EXISTS actor_user_id,
    DROP COLUMN IF EXISTS machine_surface;
