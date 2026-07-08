-- =============================================================================
-- Migration 158: outbound_call_attempts — the retry queue for the outbound
-- "part arrived → book the finish visit" robot call (OUTBOUND-PARTS-CALL-001, OPC1-T3).
--
-- One row per attempt. startRobotCall inserts a `pending` row (immediate scheduled_at)
-- or returns the existing active row; outboundCallWorker claims due rows and dials VAPI;
-- the call-status webhook classifies endedReason → terminal (booked/exhausted/…) or
-- transient → schedule a retry.
--
-- Concurrency key (OQ-5 / S14): the PARTIAL UNIQUE INDEX on (job_id) WHERE
-- status IN ('pending','dialing') guarantees AT MOST ONE active/queued attempt per job,
-- so a double-press or duplicate event cannot start a second concurrent call.
--
-- Types (verified against schema): jobs.id/tasks.id = BIGINT (BIGSERIAL),
-- contacts.id = BIGINT, companies.id = UUID.
-- All FKs are company-safe: rows are always company-scoped and job_id/task_id/contact_id
-- reference the same tenant's rows (enforced at the service layer via company_id filters).
-- =============================================================================

CREATE TABLE IF NOT EXISTS outbound_call_attempts (
    id            BIGSERIAL PRIMARY KEY,
    company_id    UUID        NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    job_id        BIGINT      NOT NULL REFERENCES jobs(id)      ON DELETE CASCADE,
    task_id       BIGINT               REFERENCES tasks(id)     ON DELETE SET NULL,
    contact_id    BIGINT               REFERENCES contacts(id)  ON DELETE SET NULL,
    phone         TEXT,
    vapi_call_id  TEXT,
    attempt_no    INTEGER     NOT NULL DEFAULT 1,
    status        TEXT        NOT NULL DEFAULT 'pending',
    scheduled_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    slot_json     JSONB,
    reason        TEXT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- OQ-5 / S14 concurrency guard: at most one active/queued attempt per job.
CREATE UNIQUE INDEX IF NOT EXISTS uq_outbound_call_attempts_active_job
    ON outbound_call_attempts (job_id)
    WHERE status IN ('pending', 'dialing');

-- Claim-loop index for outboundCallWorker (due rows within a company, by status).
CREATE INDEX IF NOT EXISTS idx_outbound_call_attempts_claim
    ON outbound_call_attempts (company_id, status, scheduled_at);

-- Webhook correlation: match an inbound call-status event to its attempt by vapi_call_id.
CREATE INDEX IF NOT EXISTS idx_outbound_call_attempts_vapi_call_id
    ON outbound_call_attempts (vapi_call_id)
    WHERE vapi_call_id IS NOT NULL;

DROP TRIGGER IF EXISTS trg_outbound_call_attempts_updated_at ON outbound_call_attempts;
CREATE TRIGGER trg_outbound_call_attempts_updated_at
    BEFORE UPDATE ON outbound_call_attempts
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

COMMENT ON TABLE outbound_call_attempts IS 'OUTBOUND-PARTS-CALL-001: retry queue for the outbound part-arrived robot call. Partial-unique (job_id) WHERE status IN (pending,dialing) = OQ-5 concurrency guard.';
COMMENT ON COLUMN outbound_call_attempts.status IS 'pending|dialing|answered|no_answer|voicemail|declined|booked|exhausted|canceled|failed (worker/webhook-managed).';
