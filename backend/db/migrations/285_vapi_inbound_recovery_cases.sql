-- VAPI-PERSIST-RECOVERY-001: durable, provider-call-scoped recovery for an
-- inbound AI conversation that ended without an open lead or job.
-- Structure only: no tenant/provider operational data is required or seeded.

CREATE TABLE IF NOT EXISTS vapi_inbound_recovery_cases (
    provider_call_id          TEXT PRIMARY KEY,
    company_id                UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    vapi_call_session_id      UUID REFERENCES vapi_call_sessions(id) ON DELETE SET NULL,
    call_sid                  TEXT,
    timeline_id               BIGINT REFERENCES timelines(id) ON DELETE SET NULL,
    contact_id                BIGINT REFERENCES contacts(id) ON DELETE SET NULL,
    task_id                   BIGINT UNIQUE REFERENCES tasks(id) ON DELETE SET NULL,
    state                     TEXT NOT NULL DEFAULT 'pending',
    decision_reason           TEXT,
    caller_phone_e164         TEXT,
    provider_call_type        TEXT,
    provider_started_at       TIMESTAMPTZ,
    provider_ended_at         TIMESTAMPTZ,
    observed_duration_seconds INTEGER,
    attempt_count             INTEGER NOT NULL DEFAULT 0,
    next_retry_at             TIMESTAMPTZ,
    last_error_code           TEXT,
    first_seen_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT chk_vapi_inbound_recovery_state CHECK (
        state IN ('pending', 'retry_pending', 'task_created', 'skipped')
    ),
    CONSTRAINT chk_vapi_inbound_recovery_duration CHECK (
        observed_duration_seconds IS NULL OR observed_duration_seconds >= 0
    ),
    CONSTRAINT chk_vapi_inbound_recovery_attempts CHECK (attempt_count >= 0),
    CONSTRAINT chk_vapi_inbound_recovery_terminal_shape CHECK (
        (state = 'task_created' AND decision_reason = 'missing_open_work')
        OR (state = 'skipped' AND task_id IS NULL AND decision_reason IS NOT NULL)
        OR (state IN ('pending', 'retry_pending') AND task_id IS NULL)
    )
);

CREATE INDEX IF NOT EXISTS idx_vapi_inbound_recovery_retry
    ON vapi_inbound_recovery_cases(next_retry_at, provider_call_id)
    WHERE state = 'retry_pending';

CREATE INDEX IF NOT EXISTS idx_vapi_inbound_recovery_company_created
    ON vapi_inbound_recovery_cases(company_id, first_seen_at DESC);

COMMENT ON TABLE vapi_inbound_recovery_cases IS
    'Exactly-once dispatcher recovery decisions for inbound AI calls. provider_call_id is globally unique in the single Vapi platform account.';
COMMENT ON COLUMN vapi_inbound_recovery_cases.caller_phone_e164 IS
    'Tenant-scoped callback data from the authenticated provider message; never used to derive company ownership.';
COMMENT ON COLUMN vapi_inbound_recovery_cases.task_id IS
    'Human callback task. A deleted task does not delete the durable provider-call decision.';
