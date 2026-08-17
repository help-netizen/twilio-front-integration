-- Migration 278: durable state for company-scoped Vapi agency provisioning.
--
-- Data-neutral by design. Provider discovery, assistant/SIP creation and
-- machine-credential provisioning are operational work performed by the
-- dry-run-by-default company provisioning CLI.

ALTER TABLE vapi_tenant_resources
    ADD COLUMN IF NOT EXISTS config_hash TEXT,
    ADD COLUMN IF NOT EXISTS provider_updated_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS last_verified_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS vapi_tenant_provisioning_runs (
    id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id                  UUID NOT NULL REFERENCES companies(id),
    environment                 TEXT NOT NULL DEFAULT 'prod',
    operation_key               UUID NOT NULL DEFAULT gen_random_uuid(),
    template_bundle_version     TEXT NOT NULL,
    input_hash                  TEXT NOT NULL,
    template_variables          JSONB NOT NULL DEFAULT '{}'::jsonb,
    state                       TEXT NOT NULL DEFAULT 'planning',
    current_step                TEXT NOT NULL DEFAULT 'planning',
    provider_assistant_ids      JSONB NOT NULL DEFAULT '{}'::jsonb,
    assistant_readback_evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
    provider_resource_id        TEXT,
    sip_uri                     TEXT,
    tools_credential_id         BIGINT,
    call_status_credential_id   BIGINT,
    assistant_request_credential_id BIGINT,
    resource_readback_hash      TEXT,
    resource_provider_updated_at TIMESTAMPTZ,
    last_error_code             TEXT,
    last_error_step             TEXT,
    attempt_count               INTEGER NOT NULL DEFAULT 0,
    started_at                  TIMESTAMPTZ,
    verified_at                 TIMESTAMPTZ,
    completed_at                TIMESTAMPTZ,
    created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_vapi_tenant_provisioning_company_environment
        UNIQUE (company_id, environment),
    CONSTRAINT uq_vapi_tenant_provisioning_operation_key
        UNIQUE (operation_key),
    CONSTRAINT chk_vapi_tenant_provisioning_environment
        CHECK (environment IN ('prod')),
    CONSTRAINT chk_vapi_tenant_provisioning_state
        CHECK (state IN (
            'planning', 'credentials_ready', 'assistants_pending',
            'assistants_ready', 'resource_pending', 'resource_ready',
            'registry_ready', 'ready', 'failed'
        )),
    CONSTRAINT chk_vapi_tenant_provisioning_variables_object
        CHECK (jsonb_typeof(template_variables) = 'object'),
    CONSTRAINT chk_vapi_tenant_provisioning_assistants_object
        CHECK (jsonb_typeof(provider_assistant_ids) = 'object'),
    CONSTRAINT chk_vapi_tenant_provisioning_evidence_object
        CHECK (jsonb_typeof(assistant_readback_evidence) = 'object'),
    CONSTRAINT chk_vapi_tenant_provisioning_attempt_count
        CHECK (attempt_count >= 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_vapi_tenant_provisioning_id_company
    ON vapi_tenant_provisioning_runs(id, company_id);

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'fk_vapi_provisioning_tools_credential_company'
          AND conrelid = 'vapi_tenant_provisioning_runs'::regclass
    ) THEN
        ALTER TABLE vapi_tenant_provisioning_runs
            ADD CONSTRAINT fk_vapi_provisioning_tools_credential_company
            FOREIGN KEY (tools_credential_id, company_id)
            REFERENCES api_integrations(id, company_id);
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'fk_vapi_provisioning_status_credential_company'
          AND conrelid = 'vapi_tenant_provisioning_runs'::regclass
    ) THEN
        ALTER TABLE vapi_tenant_provisioning_runs
            ADD CONSTRAINT fk_vapi_provisioning_status_credential_company
            FOREIGN KEY (call_status_credential_id, company_id)
            REFERENCES api_integrations(id, company_id);
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'fk_vapi_provisioning_request_credential_company'
          AND conrelid = 'vapi_tenant_provisioning_runs'::regclass
    ) THEN
        ALTER TABLE vapi_tenant_provisioning_runs
            ADD CONSTRAINT fk_vapi_provisioning_request_credential_company
            FOREIGN KEY (assistant_request_credential_id, company_id)
            REFERENCES api_integrations(id, company_id);
    END IF;
END $$;

DROP TRIGGER IF EXISTS trg_vapi_tenant_provisioning_runs_updated_at
    ON vapi_tenant_provisioning_runs;
CREATE TRIGGER trg_vapi_tenant_provisioning_runs_updated_at
    BEFORE UPDATE ON vapi_tenant_provisioning_runs
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

COMMENT ON TABLE vapi_tenant_provisioning_runs IS
    'Platform-only repairable state machine for one company Vapi provisioning operation';
COMMENT ON COLUMN vapi_tenant_provisioning_runs.provider_assistant_ids IS
    'Partial provider assistant identities persisted step-by-step; never tenant authority';
COMMENT ON COLUMN vapi_tenant_provisioning_runs.template_variables IS
    'Validated non-secret allowlisted business variables only';
COMMENT ON COLUMN vapi_tenant_resources.config_hash IS
    'Canonical secret-free readback hash of the provider SIP resource';
