-- Migration 264: company-bound machine credentials and Vapi organization identity.
--
-- Existing api_integrations remain ordinary API integrations: machine_surface is
-- nullable and no legacy credential is guessed or backfilled here. Operators
-- provision the current environment secrets explicitly for a selected company.

ALTER TABLE api_integrations
    ADD COLUMN IF NOT EXISTS machine_surface TEXT,
    ADD COLUMN IF NOT EXISTS actor_user_id UUID;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'chk_api_integrations_machine_surface'
          AND conrelid = 'api_integrations'::regclass
    ) THEN
        ALTER TABLE api_integrations
            ADD CONSTRAINT chk_api_integrations_machine_surface
            CHECK (machine_surface IS NULL OR machine_surface IN ('vapi_tools', 'sales_mcp_public'));
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'chk_api_integrations_machine_actor'
          AND conrelid = 'api_integrations'::regclass
    ) THEN
        ALTER TABLE api_integrations
            ADD CONSTRAINT chk_api_integrations_machine_actor
            CHECK (machine_surface IS DISTINCT FROM 'sales_mcp_public' OR actor_user_id IS NOT NULL);
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'fk_api_integrations_actor_membership'
          AND conrelid = 'api_integrations'::regclass
    ) THEN
        ALTER TABLE api_integrations
            ADD CONSTRAINT fk_api_integrations_actor_membership
            FOREIGN KEY (actor_user_id, company_id)
            REFERENCES company_memberships(user_id, company_id);
    END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_api_integrations_machine_secret
    ON api_integrations(machine_surface, secret_hash)
    WHERE machine_surface IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_api_integrations_machine_company
    ON api_integrations(company_id, machine_surface)
    WHERE machine_surface IS NOT NULL;

ALTER TABLE provider_connections
    ADD COLUMN IF NOT EXISTS provider_org_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS uq_provider_connections_provider_org
    ON provider_connections(provider, provider_org_id)
    WHERE provider_org_id IS NOT NULL;

COMMENT ON COLUMN api_integrations.machine_surface IS
    'Public machine surface authenticated by this company-bound credential';
COMMENT ON COLUMN api_integrations.actor_user_id IS
    'Optional human actor; required for sales_mcp_public and bound to company membership';
COMMENT ON COLUMN provider_connections.provider_org_id IS
    'Provider-side organization/account identifier; never used as the local tenant authority';
