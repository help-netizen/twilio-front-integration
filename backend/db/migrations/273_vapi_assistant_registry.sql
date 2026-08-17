-- Migration 273: authoritative assistant registry and ABC cutover.
--
-- The first apply must run in a PostgreSQL session whose custom settings are
-- populated from the deployment environment (assistant ids are identifiers,
-- not secrets):
--   app.vapi_inbound_assistant_id <- VAPI_INBOUND_ASSISTANT_ID
--   app.vapi_lead_assistant_id    <- VAPI_LEAD_CALL_ASSISTANT_ID
--   app.vapi_parts_assistant_id   <- VAPI_OUTBOUND_ASSISTANT_ID
-- Apply the first run with psql and ON_ERROR_STOP (apply_migrations.js is not a
-- production runner and historically swallows migration failures):
--   PGOPTIONS="-c app.vapi_inbound_assistant_id=${VAPI_INBOUND_ASSISTANT_ID} -c app.vapi_lead_assistant_id=${VAPI_LEAD_CALL_ASSISTANT_ID} -c app.vapi_parts_assistant_id=${VAPI_OUTBOUND_ASSISTANT_ID}" \
--     psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
--       -f backend/db/migrations/273_vapi_assistant_registry.sql
-- A repeat apply derives the ids from the completed registry. Missing,
-- ambiguous or conflicting evidence aborts the migration; no partial registry
-- is accepted.

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
    ADD COLUMN IF NOT EXISTS provider_account_key TEXT NOT NULL DEFAULT 'vapi:platform',
    ADD COLUMN IF NOT EXISTS status TEXT,
    ADD COLUMN IF NOT EXISTS template_version TEXT,
    ADD COLUMN IF NOT EXISTS template_hash TEXT,
    ADD COLUMN IF NOT EXISTS tools_credential_id BIGINT,
    ADD COLUMN IF NOT EXISTS call_status_credential_id BIGINT,
    ADD COLUMN IF NOT EXISTS provider_generation TEXT,
    ADD COLUMN IF NOT EXISTS provider_updated_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS last_verified_at TIMESTAMPTZ;

UPDATE vapi_assistant_profiles
SET status = CASE WHEN is_active THEN 'active' ELSE 'disabled' END
WHERE status IS NULL;

ALTER TABLE vapi_assistant_profiles
    ALTER COLUMN status SET DEFAULT 'provisioning',
    ALTER COLUMN status SET NOT NULL;

ALTER TABLE vapi_tenant_resources
    ADD COLUMN IF NOT EXISTS status TEXT;

UPDATE vapi_tenant_resources
SET status = CASE WHEN is_active THEN 'active' ELSE 'disabled' END
WHERE status IS NULL;

ALTER TABLE vapi_tenant_resources
    ALTER COLUMN status SET DEFAULT 'provisioning',
    ALTER COLUMN status SET NOT NULL;

-- Retire plaintext/provider configuration which used to be tenant-editable.
UPDATE provider_connections
SET encrypted_credentials_json = NULL
WHERE provider = 'vapi'
  AND encrypted_credentials_json IS NOT NULL;

UPDATE vapi_assistant_profiles
SET base_config_json = NULL
WHERE base_config_json IS NOT NULL;

UPDATE vapi_tenant_resources
SET assistant_request_secret = NULL
WHERE assistant_request_secret IS NOT NULL;

DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM vapi_assistant_profiles
        WHERE company_id IS NULL OR purpose IS NULL OR BTRIM(purpose) = ''
    ) THEN
        RAISE EXCEPTION
            'VAPI_AGENCY_273_PROFILE_SCOPE_REQUIRED: every legacy profile needs company/purpose before registry cutover';
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'chk_vapi_profile_provider_account'
          AND conrelid = 'vapi_assistant_profiles'::regclass
    ) THEN
        ALTER TABLE vapi_assistant_profiles
            ADD CONSTRAINT chk_vapi_profile_provider_account
            CHECK (provider_account_key = 'vapi:platform');
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'chk_vapi_profile_status'
          AND conrelid = 'vapi_assistant_profiles'::regclass
    ) THEN
        ALTER TABLE vapi_assistant_profiles
            ADD CONSTRAINT chk_vapi_profile_status
            CHECK (status IN ('provisioning', 'active', 'drifted', 'disabled', 'deleting'));
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'chk_vapi_profile_no_tenant_base_config'
          AND conrelid = 'vapi_assistant_profiles'::regclass
    ) THEN
        ALTER TABLE vapi_assistant_profiles
            ADD CONSTRAINT chk_vapi_profile_no_tenant_base_config
            CHECK (base_config_json IS NULL);
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'chk_vapi_resource_status'
          AND conrelid = 'vapi_tenant_resources'::regclass
    ) THEN
        ALTER TABLE vapi_tenant_resources
            ADD CONSTRAINT chk_vapi_resource_status
            CHECK (status IN ('provisioning', 'active', 'drifted', 'disabled', 'deleting'));
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'chk_vapi_resource_no_plaintext_secret'
          AND conrelid = 'vapi_tenant_resources'::regclass
    ) THEN
        ALTER TABLE vapi_tenant_resources
            ADD CONSTRAINT chk_vapi_resource_no_plaintext_secret
            CHECK (assistant_request_secret IS NULL);
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'chk_vapi_connection_platform_key_only'
          AND conrelid = 'provider_connections'::regclass
    ) THEN
        ALTER TABLE provider_connections
            ADD CONSTRAINT chk_vapi_connection_platform_key_only
            CHECK (provider <> 'vapi' OR encrypted_credentials_json IS NULL);
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'fk_vapi_profile_tools_credential_same_company'
          AND conrelid = 'vapi_assistant_profiles'::regclass
    ) THEN
        ALTER TABLE vapi_assistant_profiles
            ADD CONSTRAINT fk_vapi_profile_tools_credential_same_company
            FOREIGN KEY (tools_credential_id, company_id)
            REFERENCES api_integrations(id, company_id);
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'fk_vapi_profile_status_credential_same_company'
          AND conrelid = 'vapi_assistant_profiles'::regclass
    ) THEN
        ALTER TABLE vapi_assistant_profiles
            ADD CONSTRAINT fk_vapi_profile_status_credential_same_company
            FOREIGN KEY (call_status_credential_id, company_id)
            REFERENCES api_integrations(id, company_id);
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

DO $$
DECLARE
    abc_company CONSTANT UUID := '00000000-0000-0000-0000-000000000001'::uuid;
    platform_account CONSTANT TEXT := 'vapi:platform';
    connection_row provider_connections%ROWTYPE;
    resource_row vapi_tenant_resources%ROWTYPE;
    inbound_profile_id TEXT;
    lead_profile_id TEXT;
    parts_profile_id TEXT;
    inbound_id TEXT;
    lead_id TEXT;
    parts_id TEXT;
    supplied_inbound TEXT := NULLIF(BTRIM(current_setting('app.vapi_inbound_assistant_id', true)), '');
    supplied_lead TEXT := NULLIF(BTRIM(current_setting('app.vapi_lead_assistant_id', true)), '');
    supplied_parts TEXT := NULLIF(BTRIM(current_setting('app.vapi_parts_assistant_id', true)), '');
    selected_tools_credential_id BIGINT;
    selected_status_credential_id BIGINT;
    selected_assistant_request_credential_id BIGINT;
    match_count INTEGER;
BEGIN
    SELECT COUNT(*), MIN(id)
    INTO match_count, connection_row.id
    FROM provider_connections
    WHERE company_id = abc_company
      AND provider = 'vapi'
      AND environment = 'prod'
      AND status = 'active';
    IF match_count <> 1 THEN
        RAISE EXCEPTION
            'VAPI_AGENCY_273_ABC_CONNECTION_REQUIRED: expected 1 active ABC prod connection, found %',
            match_count;
    END IF;
    SELECT * INTO STRICT connection_row
    FROM provider_connections
    WHERE id = connection_row.id AND company_id = abc_company;

    SELECT COUNT(*), MIN(id)
    INTO match_count, resource_row.id
    FROM vapi_tenant_resources
    WHERE company_id = abc_company
      AND environment = 'prod'
      AND is_active = true
      AND NULLIF(BTRIM(sip_uri), '') IS NOT NULL;
    IF match_count <> 1 THEN
        RAISE EXCEPTION
            'VAPI_AGENCY_273_ABC_SIP_RESOURCE_REQUIRED: expected 1 active ABC prod SIP resource, found %',
            match_count;
    END IF;
    SELECT * INTO STRICT resource_row
    FROM vapi_tenant_resources
    WHERE id = resource_row.id AND company_id = abc_company;
    IF resource_row.provider_connection_id <> connection_row.id THEN
        RAISE EXCEPTION
            'VAPI_AGENCY_273_ABC_RESOURCE_CONNECTION_MISMATCH: resource and connection differ';
    END IF;

    SELECT COUNT(*), MIN(id)
    INTO match_count, selected_tools_credential_id
    FROM api_integrations
    WHERE company_id = abc_company
      AND machine_surface = 'vapi_tools'
      AND revoked_at IS NULL
      AND (expires_at IS NULL OR expires_at > now())
      AND scopes @> '["vapi_tools:invoke"]'::jsonb;
    IF match_count <> 1 THEN
        RAISE EXCEPTION
            'VAPI_AGENCY_273_TOOLS_CREDENTIAL_REQUIRED: expected 1 active ABC vapi_tools credential, found %',
            match_count;
    END IF;

    SELECT COUNT(*), MIN(id)
    INTO match_count, selected_status_credential_id
    FROM api_integrations
    WHERE company_id = abc_company
      AND machine_surface = 'vapi_call_status'
      AND revoked_at IS NULL
      AND (expires_at IS NULL OR expires_at > now())
      AND scopes @> '["vapi_call_status:invoke"]'::jsonb;
    IF match_count <> 1 THEN
        RAISE EXCEPTION
            'VAPI_AGENCY_273_STATUS_CREDENTIAL_REQUIRED: expected 1 active ABC vapi_call_status credential, found %',
            match_count;
    END IF;

    SELECT COUNT(*), MIN(id)
    INTO match_count, selected_assistant_request_credential_id
    FROM api_integrations
    WHERE company_id = abc_company
      AND machine_surface = 'vapi_assistant_request'
      AND revoked_at IS NULL
      AND (expires_at IS NULL OR expires_at > now())
      AND scopes @> '["vapi_assistant_request:invoke"]'::jsonb;
    IF match_count <> 1 THEN
        RAISE EXCEPTION
            'VAPI_AGENCY_273_ASSISTANT_REQUEST_CREDENTIAL_REQUIRED: expected 1 active ABC vapi_assistant_request credential, found %',
            match_count;
    END IF;

    SELECT COUNT(*), MIN(vapi_assistant_id)
    INTO match_count, inbound_id
    FROM vapi_assistant_profiles
    WHERE company_id = abc_company AND purpose = 'inbound_call' AND environment = 'prod';
    IF match_count > 1 THEN
        RAISE EXCEPTION 'VAPI_AGENCY_273_INBOUND_PROFILE_AMBIGUOUS';
    END IF;
    IF inbound_id IS NULL THEN inbound_id := supplied_inbound;
    ELSIF supplied_inbound IS NOT NULL AND supplied_inbound <> inbound_id THEN
        RAISE EXCEPTION 'VAPI_AGENCY_273_INBOUND_ID_CONFLICT';
    END IF;

    SELECT COUNT(*), MIN(vapi_assistant_id)
    INTO match_count, lead_id
    FROM vapi_assistant_profiles
    WHERE company_id = abc_company AND purpose = 'outbound_lead_call' AND environment = 'prod';
    IF match_count > 1 THEN
        RAISE EXCEPTION 'VAPI_AGENCY_273_LEAD_PROFILE_AMBIGUOUS';
    END IF;
    IF lead_id IS NULL THEN lead_id := supplied_lead;
    ELSIF supplied_lead IS NOT NULL AND supplied_lead <> lead_id THEN
        RAISE EXCEPTION 'VAPI_AGENCY_273_LEAD_ID_CONFLICT';
    END IF;

    SELECT COUNT(*), MIN(vapi_assistant_id)
    INTO match_count, parts_id
    FROM vapi_assistant_profiles
    WHERE company_id = abc_company AND purpose = 'outbound_parts_call' AND environment = 'prod';
    IF match_count > 1 THEN
        RAISE EXCEPTION 'VAPI_AGENCY_273_PARTS_PROFILE_AMBIGUOUS';
    END IF;
    IF parts_id IS NULL THEN parts_id := supplied_parts;
    ELSIF supplied_parts IS NOT NULL AND supplied_parts <> parts_id THEN
        RAISE EXCEPTION 'VAPI_AGENCY_273_PARTS_ID_CONFLICT';
    END IF;

    IF inbound_id IS NULL OR lead_id IS NULL OR parts_id IS NULL THEN
        RAISE EXCEPTION
            'VAPI_AGENCY_273_ASSISTANT_IDS_REQUIRED: set all three app.vapi_*_assistant_id values from deployment env';
    END IF;
    IF inbound_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       OR lead_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       OR parts_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
        RAISE EXCEPTION 'VAPI_AGENCY_273_ASSISTANT_ID_INVALID: all assistant ids must be UUIDs';
    END IF;
    IF inbound_id = lead_id OR inbound_id = parts_id OR lead_id = parts_id THEN
        RAISE EXCEPTION 'VAPI_AGENCY_273_ASSISTANT_IDS_NOT_DISTINCT';
    END IF;

    inbound_profile_id := 'vapi_profile_abc_inbound_prod';
    lead_profile_id := 'vapi_profile_abc_outbound_lead_prod';
    parts_profile_id := 'vapi_profile_abc_outbound_parts_prod';

    UPDATE vapi_assistant_profiles
    SET tenant_id = connection_row.tenant_id,
        provider_connection_id = connection_row.id,
        slug = 'inbound-qualification',
        base_config_json = NULL,
        vapi_assistant_id = inbound_id,
        version = 'legacy-abc-v1',
        is_active = true,
        provider_account_key = platform_account,
        status = 'active',
        template_version = 'legacy-abc-v1',
        tools_credential_id = selected_tools_credential_id,
        call_status_credential_id = selected_status_credential_id,
        updated_at = now()
    WHERE company_id = abc_company AND purpose = 'inbound_call' AND environment = 'prod'
    RETURNING id INTO inbound_profile_id;
    IF NOT FOUND THEN
        inbound_profile_id := 'vapi_profile_abc_inbound_prod';
        INSERT INTO vapi_assistant_profiles (
            id, tenant_id, company_id, provider_connection_id, slug, purpose,
            base_config_json, vapi_assistant_id, version, is_active, environment,
            provider_account_key, status, template_version,
            tools_credential_id, call_status_credential_id
        ) VALUES (
            inbound_profile_id, connection_row.tenant_id, abc_company, connection_row.id,
            'inbound-qualification', 'inbound_call', NULL, inbound_id,
            'legacy-abc-v1', true, 'prod', platform_account, 'active',
            'legacy-abc-v1', selected_tools_credential_id, selected_status_credential_id
        );
    END IF;

    UPDATE vapi_assistant_profiles
    SET tenant_id = connection_row.tenant_id,
        provider_connection_id = connection_row.id,
        slug = 'outbound-lead',
        base_config_json = NULL,
        vapi_assistant_id = lead_id,
        version = 'legacy-abc-v1',
        is_active = true,
        provider_account_key = platform_account,
        status = 'active',
        template_version = 'legacy-abc-v1',
        tools_credential_id = selected_tools_credential_id,
        call_status_credential_id = selected_status_credential_id,
        updated_at = now()
    WHERE company_id = abc_company AND purpose = 'outbound_lead_call' AND environment = 'prod'
    RETURNING id INTO lead_profile_id;
    IF NOT FOUND THEN
        lead_profile_id := 'vapi_profile_abc_outbound_lead_prod';
        INSERT INTO vapi_assistant_profiles (
            id, tenant_id, company_id, provider_connection_id, slug, purpose,
            base_config_json, vapi_assistant_id, version, is_active, environment,
            provider_account_key, status, template_version,
            tools_credential_id, call_status_credential_id
        ) VALUES (
            lead_profile_id, connection_row.tenant_id, abc_company, connection_row.id,
            'outbound-lead', 'outbound_lead_call', NULL, lead_id,
            'legacy-abc-v1', true, 'prod', platform_account, 'active',
            'legacy-abc-v1', selected_tools_credential_id, selected_status_credential_id
        );
    END IF;

    UPDATE vapi_assistant_profiles
    SET tenant_id = connection_row.tenant_id,
        provider_connection_id = connection_row.id,
        slug = 'outbound-parts',
        base_config_json = NULL,
        vapi_assistant_id = parts_id,
        version = 'legacy-abc-v1',
        is_active = true,
        provider_account_key = platform_account,
        status = 'active',
        template_version = 'legacy-abc-v1',
        tools_credential_id = selected_tools_credential_id,
        call_status_credential_id = selected_status_credential_id,
        updated_at = now()
    WHERE company_id = abc_company AND purpose = 'outbound_parts_call' AND environment = 'prod'
    RETURNING id INTO parts_profile_id;
    IF NOT FOUND THEN
        parts_profile_id := 'vapi_profile_abc_outbound_parts_prod';
        INSERT INTO vapi_assistant_profiles (
            id, tenant_id, company_id, provider_connection_id, slug, purpose,
            base_config_json, vapi_assistant_id, version, is_active, environment,
            provider_account_key, status, template_version,
            tools_credential_id, call_status_credential_id
        ) VALUES (
            parts_profile_id, connection_row.tenant_id, abc_company, connection_row.id,
            'outbound-parts', 'outbound_parts_call', NULL, parts_id,
            'legacy-abc-v1', true, 'prod', platform_account, 'active',
            'legacy-abc-v1', selected_tools_credential_id, selected_status_credential_id
        );
    END IF;

    UPDATE vapi_tenant_resources
    SET purpose = 'inbound_call',
        assistant_profile_id = inbound_profile_id,
        server_credential_id = selected_assistant_request_credential_id,
        assistant_request_secret = NULL,
        status = 'active',
        updated_at = now()
    WHERE id = resource_row.id
      AND company_id = abc_company
      AND provider_connection_id = connection_row.id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'VAPI_AGENCY_273_ABC_RESOURCE_BIND_FAILED';
    END IF;

    INSERT INTO vapi_tenant_voice_configs (
        company_id, environment, rollout_state, readiness_evidence
    ) VALUES (
        abc_company, 'prod', 'legacy_canary',
        jsonb_build_object('registry_bootstrap', 'migration_273')
    )
    ON CONFLICT (company_id, environment) DO UPDATE
    SET rollout_state = CASE
            WHEN vapi_tenant_voice_configs.rollout_state = 'suspended'
                THEN 'suspended'
            ELSE 'legacy_canary'
        END,
        readiness_evidence = vapi_tenant_voice_configs.readiness_evidence
            || jsonb_build_object('registry_bootstrap', 'migration_273'),
        updated_at = now();

    SELECT COUNT(*) INTO match_count
    FROM vapi_assistant_profiles
    WHERE company_id = abc_company
      AND environment = 'prod'
      AND purpose IN ('inbound_call', 'outbound_lead_call', 'outbound_parts_call')
      AND status = 'active'
      AND is_active = true;
    IF match_count <> 3 THEN
        RAISE EXCEPTION
            'VAPI_AGENCY_273_ABC_REGISTRY_INCOMPLETE: expected 3 active profiles, found %',
            match_count;
    END IF;
END $$;

COMMENT ON TABLE vapi_tenant_voice_configs IS
    'Platform-owned voice rollout configuration; no tenant write route';
COMMENT ON COLUMN vapi_assistant_profiles.provider_account_key IS
    'Single platform Vapi account key; constrained constant, never derived from a tenant connection';
COMMENT ON COLUMN vapi_assistant_profiles.base_config_json IS
    'Retired tenant-editable provider config; constrained NULL after VAPI-AGENCY-001 T5';
