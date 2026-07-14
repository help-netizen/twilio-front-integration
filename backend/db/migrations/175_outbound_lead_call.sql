-- =============================================================================
-- Migration 175: OUTBOUND-LEAD-CALL-001 — lead-scoped outbound call chains on the
-- shared dialer table + per-company scenario-scoped settings.
--
-- 1) outbound_call_attempts gains a `scenario` discriminator ('parts_visit' for
--    every existing row) and a nullable lead key; job_id becomes per-scenario-
--    required (CHECK). The parts concurrency guard uq_outbound_call_attempts_
--    active_job is a partial unique on (job_id) — Postgres unique indexes ignore
--    NULL rows, so lead rows (job_id IS NULL) are invisible to it by construction.
-- 2) FR-14(a): mirror partial-unique on (lead_uuid) = at most ONE active chain
--    per lead.
-- 3) outbound_lead_call_settings: one row per company; enabled sources (FR-2) +
--    the lead ladder (FR-5) — fully independent of the parts outbound_call_settings.
-- NOT registered in ensureMarketplaceSchema (DDL, not a seed) — run via the
-- normal migration path (psql before code deploy, prod procedure unchanged).
-- (Spec drafted this as 172; renumbered 172→173→175: 172 taken by feedback_submissions, 173/174 by assistant-bot.)
-- =============================================================================

ALTER TABLE outbound_call_attempts ALTER COLUMN job_id DROP NOT NULL;

ALTER TABLE outbound_call_attempts
    ADD COLUMN IF NOT EXISTS scenario  TEXT NOT NULL DEFAULT 'parts_visit',
    ADD COLUMN IF NOT EXISTS lead_uuid VARCHAR(20) REFERENCES leads(uuid) ON DELETE CASCADE;

-- Shape honesty: lead rows must carry a lead, everything else must carry a job.
-- Existing rows are scenario='parts_visit' with job_id NOT NULL → valid.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'chk_outbound_call_attempts_scope'
          AND conrelid = 'outbound_call_attempts'::regclass
    ) THEN
        ALTER TABLE outbound_call_attempts ADD CONSTRAINT chk_outbound_call_attempts_scope
            CHECK ((scenario = 'lead_call' AND lead_uuid IS NOT NULL)
                OR (scenario <> 'lead_call' AND job_id IS NOT NULL));
    END IF;
END $$;

-- FR-14(a): at most ONE active/queued attempt per lead (mirror of the job guard).
-- NOTE: no `lead_uuid IS NOT NULL` in the predicate — unique indexes ignore
-- NULL rows anyway (parts rows are invisible by construction), and the extra
-- clause breaks ON CONFLICT partial-index INFERENCE in the enqueue INSERT
-- (caught live on the TC-OLC-057 stand: "no unique or exclusion constraint
-- matching the ON CONFLICT specification").
CREATE UNIQUE INDEX IF NOT EXISTS uq_outbound_call_attempts_active_lead
    ON outbound_call_attempts (lead_uuid)
    WHERE status IN ('pending', 'dialing');

-- FR-14(c) lifetime-once lookup + worker/webhook reads by lead.
CREATE INDEX IF NOT EXISTS idx_outbound_call_attempts_lead
    ON outbound_call_attempts (lead_uuid) WHERE lead_uuid IS NOT NULL;

-- Scenario-scoped settings (architecture D-B): sources + lead ladder in one row.
CREATE TABLE IF NOT EXISTS outbound_lead_call_settings (
    company_id       UUID PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
    enabled_sources  JSONB       NOT NULL DEFAULT '["ProReferral"]'::jsonb,
    max_attempts     INTEGER     NOT NULL DEFAULT 3,
    backoff_schedule JSONB       NOT NULL DEFAULT '["immediate","+30m","+2h"]'::jsonb,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DROP TRIGGER IF EXISTS trg_outbound_lead_call_settings_updated_at ON outbound_lead_call_settings;
CREATE TRIGGER trg_outbound_lead_call_settings_updated_at
    BEFORE UPDATE ON outbound_lead_call_settings
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

COMMENT ON COLUMN outbound_call_attempts.scenario  IS 'OUTBOUND-LEAD-CALL-001: parts_visit (job-scoped, default) | lead_call (lead-scoped).';
COMMENT ON COLUMN outbound_call_attempts.lead_uuid IS 'OUTBOUND-LEAD-CALL-001: triggering lead for scenario=lead_call; NULL on parts rows.';
COMMENT ON TABLE  outbound_lead_call_settings      IS 'OUTBOUND-LEAD-CALL-001: per-company enabled lead sources + scenario-scoped retry ladder (independent of outbound_call_settings).';
