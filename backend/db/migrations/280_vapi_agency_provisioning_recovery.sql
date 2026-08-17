-- Migration 280: structural recovery state for VAPI-AGENCY-001 provisioning.
--
-- Data-neutral by design. Operational rollout values and template variables are
-- captured by the company-scoped provisioning CLI, never inferred here.

ALTER TABLE vapi_tenant_provisioning_runs
    ADD COLUMN IF NOT EXISTS previous_rollout_state TEXT,
    ADD COLUMN IF NOT EXISTS last_successful_template_variables JSONB NOT NULL DEFAULT '{}'::jsonb;

-- The SIP safety path must still be able to answer when the normalized profile
-- registry is unavailable. This is a server-owned projection populated by the
-- operational bootstrap/provisioning commands, never tenant input.
ALTER TABLE vapi_tenant_resources
    ADD COLUMN IF NOT EXISTS fallback_vapi_assistant_id TEXT;

-- A session keeps the credential assigned at admission. During a deliberate
-- rotation a second company credential may be accepted for a bounded overlap;
-- arbitrary active same-company credentials are not authority.
CREATE TABLE IF NOT EXISTS vapi_company_credential_acceptance (
    company_id       UUID NOT NULL REFERENCES companies(id),
    environment      TEXT NOT NULL DEFAULT 'prod',
    machine_surface  TEXT NOT NULL,
    credential_id    BIGINT NOT NULL,
    acceptance_state TEXT NOT NULL,
    accepted_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at       TIMESTAMPTZ,
    PRIMARY KEY (company_id, environment, machine_surface, credential_id),
    CONSTRAINT fk_vapi_accepted_credential_company
        FOREIGN KEY (credential_id, company_id)
        REFERENCES api_integrations(id, company_id),
    CONSTRAINT chk_vapi_accepted_credential_environment
        CHECK (environment = 'prod'),
    CONSTRAINT chk_vapi_accepted_credential_surface
        CHECK (machine_surface = 'vapi_assistant_request'),
    CONSTRAINT chk_vapi_accepted_credential_state
        CHECK (acceptance_state IN ('rotating', 'current', 'retiring')),
    CONSTRAINT chk_vapi_accepted_credential_expiry
        CHECK (acceptance_state <> 'retiring' OR expires_at IS NOT NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_vapi_company_current_credential
    ON vapi_company_credential_acceptance(company_id, environment, machine_surface)
    WHERE acceptance_state = 'current';

ALTER TABLE vapi_call_sessions
    DROP CONSTRAINT IF EXISTS fk_vapi_call_sessions_resource_tuple;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'fk_vapi_session_request_credential_same_company'
          AND conrelid = 'vapi_call_sessions'::regclass
    ) THEN
        ALTER TABLE vapi_call_sessions
            ADD CONSTRAINT fk_vapi_session_request_credential_same_company
            FOREIGN KEY (assistant_request_credential_id, company_id)
            REFERENCES api_integrations(id, company_id)
            NOT VALID;
    END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_vapi_resource_fallback_assistant
    ON vapi_tenant_resources(fallback_vapi_assistant_id)
    WHERE fallback_vapi_assistant_id IS NOT NULL;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'chk_vapi_resource_fallback_assistant_nonempty'
          AND conrelid = 'vapi_tenant_resources'::regclass
    ) THEN
        ALTER TABLE vapi_tenant_resources
            ADD CONSTRAINT chk_vapi_resource_fallback_assistant_nonempty
            CHECK (
                fallback_vapi_assistant_id IS NULL
                OR NULLIF(BTRIM(fallback_vapi_assistant_id), '') IS NOT NULL
            );
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'chk_vapi_provisioning_previous_rollout_state'
          AND conrelid = 'vapi_tenant_provisioning_runs'::regclass
    ) THEN
        ALTER TABLE vapi_tenant_provisioning_runs
            ADD CONSTRAINT chk_vapi_provisioning_previous_rollout_state
            CHECK (
                previous_rollout_state IS NULL
                OR previous_rollout_state IN (
                    'legacy_canary', 'provisioning', 'ready',
                    'enabled', 'suspended'
                )
            );
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'chk_vapi_provisioning_last_variables_object'
          AND conrelid = 'vapi_tenant_provisioning_runs'::regclass
    ) THEN
        ALTER TABLE vapi_tenant_provisioning_runs
            ADD CONSTRAINT chk_vapi_provisioning_last_variables_object
            CHECK (jsonb_typeof(last_successful_template_variables) = 'object');
    END IF;
END $$;

COMMENT ON COLUMN vapi_tenant_provisioning_runs.previous_rollout_state IS
    'Rollout state captured immediately before apply; restored if the repairable run fails';
COMMENT ON COLUMN vapi_tenant_provisioning_runs.last_successful_template_variables IS
    'Last verified allowlisted non-secret variables, used when optional CLI values are omitted';
COMMENT ON COLUMN vapi_tenant_resources.fallback_vapi_assistant_id IS
    'Optional server-owned inbound safety projection; never an admission prerequisite';
COMMENT ON TABLE vapi_company_credential_acceptance IS
    'Bounded assistant-request credential overlap for one company during provider rotation';
