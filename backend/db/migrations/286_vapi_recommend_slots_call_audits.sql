-- OB-66: durable, provider-call-scoped evidence for every Vapi
-- recommendSlots invocation. Structure only; no provider or tenant data is
-- discovered or seeded by this migration.

CREATE TABLE IF NOT EXISTS vapi_recommend_slots_call_audits (
    provider_call_id TEXT PRIMARY KEY,
    company_id       UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    call_sid         TEXT,
    invocations      JSONB NOT NULL DEFAULT '[]'::jsonb,
    transcript       TEXT,
    callback_task_id BIGINT UNIQUE REFERENCES tasks(id) ON DELETE SET NULL,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT chk_vapi_recommend_slots_invocations_array
        CHECK (jsonb_typeof(invocations) = 'array')
);

CREATE INDEX IF NOT EXISTS idx_vapi_recommend_slots_audits_company_call_sid
    ON vapi_recommend_slots_call_audits(company_id, call_sid)
    WHERE call_sid IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_vapi_recommend_slots_audits_company_created
    ON vapi_recommend_slots_call_audits(company_id, created_at DESC);

COMMENT ON TABLE vapi_recommend_slots_call_audits IS
    'Exact recommendSlots inputs/results and post-call transcript, scoped to one authenticated Vapi call.';
COMMENT ON COLUMN vapi_recommend_slots_call_audits.invocations IS
    'Ordered objects: tool_call_id, arguments, result, observed_at. A repeated tool_call_id is appended at most once.';
COMMENT ON COLUMN vapi_recommend_slots_call_audits.callback_task_id IS
    'Exactly-once dispatcher callback created for a genuine served-area availability failure.';

-- A slot-unavailable callback is created during the call, before the generic
-- end-of-call recovery runs. Let the existing exactly-once recovery case own
-- both terminal task reasons so the two paths cannot produce duplicate tasks.
ALTER TABLE vapi_inbound_recovery_cases
    DROP CONSTRAINT IF EXISTS chk_vapi_inbound_recovery_terminal_shape;

ALTER TABLE vapi_inbound_recovery_cases
    ADD CONSTRAINT chk_vapi_inbound_recovery_terminal_shape CHECK (
        (state = 'task_created' AND decision_reason IN ('missing_open_work', 'slot_unavailable'))
        OR (state = 'skipped' AND task_id IS NULL AND decision_reason IS NOT NULL)
        OR (state IN ('pending', 'retry_pending') AND task_id IS NULL)
    );
