-- Migration 266: durable Vapi call identity and usage projections.
--
-- T2 writes only vapi_call_sessions. The observation/current-usage tables are
-- created in the same approved migration group so T3/T4 can add data without a
-- second, temporarily inconsistent identity schema.

ALTER TABLE api_integrations
    DROP CONSTRAINT IF EXISTS chk_api_integrations_machine_surface;

ALTER TABLE api_integrations
    ADD CONSTRAINT chk_api_integrations_machine_surface
    CHECK (machine_surface IS NULL OR machine_surface IN (
        'vapi_tools',
        'vapi_call_status',
        'vapi_assistant_request',
        'sales_mcp_public'
    ));

ALTER TABLE vapi_tenant_resources
    ADD COLUMN IF NOT EXISTS purpose TEXT NOT NULL DEFAULT 'inbound_call',
    ADD COLUMN IF NOT EXISTS assistant_profile_id TEXT,
    ADD COLUMN IF NOT EXISTS server_credential_id BIGINT;

ALTER TABLE vapi_assistant_profiles
    ADD COLUMN IF NOT EXISTS environment TEXT NOT NULL DEFAULT 'prod';

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'chk_vapi_tenant_resources_purpose'
          AND conrelid = 'vapi_tenant_resources'::regclass
    ) THEN
        ALTER TABLE vapi_tenant_resources
            ADD CONSTRAINT chk_vapi_tenant_resources_purpose
            CHECK (purpose ~ '^[a-z0-9][a-z0-9_-]{0,63}$');
    END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_vapi_profiles_identity_company_connection
    ON vapi_assistant_profiles(id, company_id, provider_connection_id);

CREATE UNIQUE INDEX IF NOT EXISTS uq_api_integrations_id_company
    ON api_integrations(id, company_id);

CREATE UNIQUE INDEX IF NOT EXISTS uq_provider_connections_id_company
    ON provider_connections(id, company_id);

-- One platform Vapi account is represented by company-scoped logical
-- connections. The provider org is therefore a grouping key, not tenant-unique.
DROP INDEX IF EXISTS uq_provider_connections_provider_org;
CREATE INDEX IF NOT EXISTS idx_provider_connections_provider_org
    ON provider_connections(provider, provider_org_id)
    WHERE provider_org_id IS NOT NULL;

DROP INDEX IF EXISTS uq_vapi_resource_tenant_env;
DROP INDEX IF EXISTS uq_vapi_resources_company_env;

CREATE UNIQUE INDEX IF NOT EXISTS uq_vapi_resources_company_purpose_env
    ON vapi_tenant_resources(company_id, purpose, environment)
    WHERE company_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_vapi_profiles_company_purpose_env
    ON vapi_assistant_profiles(company_id, purpose, environment)
    WHERE company_id IS NOT NULL AND purpose IS NOT NULL;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'fk_vapi_profile_connection_same_company'
          AND conrelid = 'vapi_assistant_profiles'::regclass
    ) THEN
        ALTER TABLE vapi_assistant_profiles
            ADD CONSTRAINT fk_vapi_profile_connection_same_company
            FOREIGN KEY (provider_connection_id, company_id)
            REFERENCES provider_connections(id, company_id);
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'fk_vapi_resource_connection_same_company'
          AND conrelid = 'vapi_tenant_resources'::regclass
    ) THEN
        ALTER TABLE vapi_tenant_resources
            ADD CONSTRAINT fk_vapi_resource_connection_same_company
            FOREIGN KEY (provider_connection_id, company_id)
            REFERENCES provider_connections(id, company_id);
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'fk_vapi_resource_assistant_same_company'
          AND conrelid = 'vapi_tenant_resources'::regclass
    ) THEN
        ALTER TABLE vapi_tenant_resources
            ADD CONSTRAINT fk_vapi_resource_assistant_same_company
            FOREIGN KEY (assistant_profile_id, company_id, provider_connection_id)
            REFERENCES vapi_assistant_profiles(id, company_id, provider_connection_id);
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'fk_vapi_resource_credential_same_company'
          AND conrelid = 'vapi_tenant_resources'::regclass
    ) THEN
        ALTER TABLE vapi_tenant_resources
            ADD CONSTRAINT fk_vapi_resource_credential_same_company
            FOREIGN KEY (server_credential_id, company_id)
            REFERENCES api_integrations(id, company_id);
    END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_vapi_resource_session_tuple
    ON vapi_tenant_resources(
        id,
        company_id,
        provider_connection_id,
        assistant_profile_id,
        server_credential_id
    );

CREATE TABLE IF NOT EXISTS vapi_call_sessions (
    id                              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id                      UUID NOT NULL REFERENCES companies(id),
    direction                       TEXT NOT NULL,
    purpose                         TEXT NOT NULL,
    environment                     TEXT NOT NULL,
    provider_connection_id          TEXT,
    assistant_profile_id            TEXT,
    tenant_resource_id              TEXT,
    assistant_request_credential_id BIGINT,
    provider_account_key            TEXT NOT NULL,
    expected_vapi_assistant_id      TEXT,
    vapi_call_id                    TEXT,
    twilio_parent_call_sid          TEXT,
    twilio_child_call_sid           TEXT,
    outbound_call_attempt_id        BIGINT REFERENCES outbound_call_attempts(id),
    flow_execution_id               TEXT REFERENCES call_flow_executions(id) ON DELETE SET NULL,
    flow_node_id                    TEXT,
    correlation_token_hash          TEXT,
    correlation_expires_at          TIMESTAMPTZ,
    correlation_consumed_at         TIMESTAMPTZ,
    bind_source                     TEXT,
    bound_at                        TIMESTAMPTZ,
    admitted_at                     TIMESTAMPTZ NOT NULL DEFAULT now(),
    state                           TEXT NOT NULL DEFAULT 'created',
    quarantine_reason               TEXT,
    quarantined_at                  TIMESTAMPTZ,
    started_at                      TIMESTAMPTZ,
    ended_at                        TIMESTAMPTZ,
    provider_ended_reason           TEXT,
    created_at                      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at                      TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT chk_vapi_call_sessions_direction
        CHECK (direction IN ('inbound', 'outbound')),
    CONSTRAINT chk_vapi_call_sessions_purpose
        CHECK (purpose ~ '^[a-z0-9][a-z0-9_-]{0,63}$'),
    CONSTRAINT chk_vapi_call_sessions_state
        CHECK (state IN (
            'created', 'admitted', 'provider_pending', 'active', 'ended',
            'cost_pending', 'closed', 'quarantined'
        )),
    CONSTRAINT chk_vapi_call_sessions_bind_source
        CHECK (bind_source IS NULL OR bind_source IN (
            'assistant_request', 'status_update', 'end_of_call_report', 'post_call_response'
        )),
    CONSTRAINT chk_vapi_call_sessions_inbound_tuple
        CHECK (
            direction = 'outbound'
            OR (
                provider_connection_id IS NOT NULL
                AND assistant_profile_id IS NOT NULL
                AND tenant_resource_id IS NOT NULL
                AND assistant_request_credential_id IS NOT NULL
                AND expected_vapi_assistant_id IS NOT NULL
                AND twilio_parent_call_sid IS NOT NULL
                AND flow_node_id IS NOT NULL
                AND correlation_token_hash IS NOT NULL
                AND correlation_expires_at IS NOT NULL
            )
        ),
    CONSTRAINT chk_vapi_call_sessions_bound_fields
        CHECK (
            (vapi_call_id IS NULL AND bound_at IS NULL)
            OR (vapi_call_id IS NOT NULL AND bound_at IS NOT NULL)
        ),
    CONSTRAINT fk_vapi_call_sessions_resource_tuple
        FOREIGN KEY (
            tenant_resource_id,
            company_id,
            provider_connection_id,
            assistant_profile_id,
            assistant_request_credential_id
        ) REFERENCES vapi_tenant_resources(
            id,
            company_id,
            provider_connection_id,
            assistant_profile_id,
            server_credential_id
        )
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_vapi_call_sessions_id_company
    ON vapi_call_sessions(id, company_id);

CREATE UNIQUE INDEX IF NOT EXISTS uq_vapi_call_sessions_provider_call
    ON vapi_call_sessions(vapi_call_id)
    WHERE vapi_call_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_vapi_call_sessions_correlation_token
    ON vapi_call_sessions(correlation_token_hash)
    WHERE correlation_token_hash IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_vapi_call_sessions_outbound_attempt
    ON vapi_call_sessions(company_id, outbound_call_attempt_id)
    WHERE outbound_call_attempt_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_vapi_call_sessions_company_parent
    ON vapi_call_sessions(company_id, twilio_parent_call_sid, created_at DESC)
    WHERE twilio_parent_call_sid IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_vapi_call_sessions_pending_token
    ON vapi_call_sessions(company_id, correlation_token_hash, correlation_expires_at)
    WHERE direction = 'inbound' AND state IN ('created', 'admitted', 'provider_pending');

DROP TRIGGER IF EXISTS trg_vapi_call_sessions_updated_at ON vapi_call_sessions;
CREATE TRIGGER trg_vapi_call_sessions_updated_at
    BEFORE UPDATE ON vapi_call_sessions
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TABLE IF NOT EXISTS vapi_call_usage_observations (
    id                              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id                      UUID NOT NULL,
    vapi_call_session_id            UUID NOT NULL,
    source                          TEXT NOT NULL,
    provider_event_id               TEXT,
    payload_hash                    TEXT NOT NULL,
    supplier_cost                   NUMERIC(24,12),
    breakdown_total                 NUMERIC(24,12),
    transport_cost                  NUMERIC(24,12),
    stt_cost                        NUMERIC(24,12),
    llm_cost                        NUMERIC(24,12),
    tts_cost                        NUMERIC(24,12),
    vapi_cost                       NUMERIC(24,12),
    chat_cost                       NUMERIC(24,12),
    analysis_cost                   NUMERIC(24,12),
    prompt_tokens                   BIGINT,
    completion_tokens               BIGINT,
    total_tokens                    BIGINT,
    breakdown_schema_version        INTEGER NOT NULL DEFAULT 1,
    cost_breakdown_evidence         JSONB NOT NULL DEFAULT '{}'::jsonb,
    provider_updated_at             TIMESTAMPTZ,
    observed_at                     TIMESTAMPTZ NOT NULL DEFAULT now(),
    started_at                      TIMESTAMPTZ,
    ended_at                        TIMESTAMPTZ,
    ended_reason                    TEXT,
    validation_state                TEXT NOT NULL DEFAULT 'accepted',
    validation_error                TEXT,
    created_at                      TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT fk_vapi_usage_observation_session_company
        FOREIGN KEY (vapi_call_session_id, company_id)
        REFERENCES vapi_call_sessions(id, company_id),
    CONSTRAINT chk_vapi_usage_observation_source
        CHECK (source IN ('end_of_call_report', 'get_call', 'audit_repair')),
    CONSTRAINT chk_vapi_usage_observation_validation
        CHECK (validation_state IN ('accepted', 'quarantined')),
    CONSTRAINT chk_vapi_usage_observation_costs
        CHECK (
            (supplier_cost IS NULL OR supplier_cost >= 0)
            AND (breakdown_total IS NULL OR breakdown_total >= 0)
            AND (transport_cost IS NULL OR transport_cost >= 0)
            AND (stt_cost IS NULL OR stt_cost >= 0)
            AND (llm_cost IS NULL OR llm_cost >= 0)
            AND (tts_cost IS NULL OR tts_cost >= 0)
            AND (vapi_cost IS NULL OR vapi_cost >= 0)
            AND (chat_cost IS NULL OR chat_cost >= 0)
            AND (analysis_cost IS NULL OR analysis_cost >= 0)
        ),
    CONSTRAINT chk_vapi_usage_observation_tokens
        CHECK (
            (prompt_tokens IS NULL OR prompt_tokens >= 0)
            AND (completion_tokens IS NULL OR completion_tokens >= 0)
            AND (total_tokens IS NULL OR total_tokens >= 0)
        )
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_vapi_usage_observation_payload
    ON vapi_call_usage_observations(company_id, vapi_call_session_id, source, payload_hash);

CREATE UNIQUE INDEX IF NOT EXISTS uq_vapi_usage_observation_event
    ON vapi_call_usage_observations(company_id, source, provider_event_id)
    WHERE provider_event_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_vapi_usage_observations_session
    ON vapi_call_usage_observations(company_id, vapi_call_session_id, observed_at DESC);

CREATE TABLE IF NOT EXISTS vapi_call_usage (
    company_id                      UUID NOT NULL,
    vapi_call_session_id            UUID NOT NULL,
    state                           TEXT NOT NULL DEFAULT 'provisional',
    supplier_cost                   NUMERIC(24,12),
    normalized_breakdown            JSONB NOT NULL DEFAULT '{}'::jsonb,
    ended_reason                    TEXT,
    duration_seconds                NUMERIC(18,6),
    snapshot_hash                   TEXT,
    stable_count                    INTEGER NOT NULL DEFAULT 0,
    last_authoritative_at           TIMESTAMPTZ,
    reconcile_attempts              INTEGER NOT NULL DEFAULT 0,
    next_reconcile_at               TIMESTAMPTZ,
    first_pending_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_error                      TEXT,
    final_snapshot_version          INTEGER NOT NULL DEFAULT 0,
    finalized_at                    TIMESTAMPTZ,
    created_at                      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at                      TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (vapi_call_session_id),
    CONSTRAINT uq_vapi_call_usage_session_company UNIQUE (vapi_call_session_id, company_id),
    CONSTRAINT fk_vapi_call_usage_session_company
        FOREIGN KEY (vapi_call_session_id, company_id)
        REFERENCES vapi_call_sessions(id, company_id),
    CONSTRAINT chk_vapi_call_usage_state
        CHECK (state IN (
            'provisional', 'reconciling', 'stable_once', 'final',
            'stale_pending', 'quarantined'
        )),
    CONSTRAINT chk_vapi_call_usage_nonnegative
        CHECK (
            (supplier_cost IS NULL OR supplier_cost >= 0)
            AND (duration_seconds IS NULL OR duration_seconds >= 0)
            AND stable_count >= 0
            AND reconcile_attempts >= 0
            AND final_snapshot_version >= 0
        )
);

CREATE INDEX IF NOT EXISTS idx_vapi_call_usage_due
    ON vapi_call_usage(company_id, next_reconcile_at)
    WHERE state IN ('provisional', 'reconciling', 'stable_once', 'stale_pending');

DROP TRIGGER IF EXISTS trg_vapi_call_usage_updated_at ON vapi_call_usage;
CREATE TRIGGER trg_vapi_call_usage_updated_at
    BEFORE UPDATE ON vapi_call_usage
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Only exact, globally unambiguous legacy Vapi ids are safe to backfill. They
-- remain outbound evidence and do not invent an assistant/resource relation.
WITH unambiguous AS (
    SELECT vapi_call_id
    FROM outbound_call_attempts
    WHERE vapi_call_id IS NOT NULL
      AND BTRIM(vapi_call_id) <> ''
    GROUP BY vapi_call_id
    HAVING COUNT(*) = 1
)
INSERT INTO vapi_call_sessions (
    company_id,
    direction,
    purpose,
    environment,
    provider_account_key,
    vapi_call_id,
    outbound_call_attempt_id,
    bind_source,
    bound_at,
    admitted_at,
    state,
    created_at,
    updated_at
)
SELECT
    attempt.company_id,
    'outbound',
    CASE WHEN attempt.scenario = 'lead_call' THEN 'outbound_lead_call' ELSE 'outbound_parts_call' END,
    'prod',
    'vapi:platform',
    attempt.vapi_call_id,
    attempt.id,
    'post_call_response',
    attempt.updated_at,
    attempt.created_at,
    CASE
        WHEN attempt.status = 'dialing' THEN 'active'
        ELSE 'cost_pending'
    END,
    attempt.created_at,
    attempt.updated_at
FROM outbound_call_attempts attempt
JOIN unambiguous exact ON exact.vapi_call_id = attempt.vapi_call_id
ON CONFLICT DO NOTHING;

COMMENT ON TABLE vapi_call_sessions IS
    'One durable row per Vapi AI leg. Twilio SIDs are tenant-scoped grouping evidence, never provider identity.';
COMMENT ON COLUMN vapi_call_sessions.correlation_token_hash IS
    'Hash of the opaque one-time inbound correlation token; plaintext is sent once in SIP and never stored.';
COMMENT ON COLUMN vapi_call_sessions.provider_account_key IS
    'Audit label for the single platform Vapi account; vapi_call_id itself is globally unique.';
COMMENT ON TABLE vapi_call_usage_observations IS
    'Append-only supplier evidence populated from T3; no tenant-facing projection.';
COMMENT ON TABLE vapi_call_usage IS
    'Current authoritative supplier usage state populated by T3/T4; not a billing ledger.';
