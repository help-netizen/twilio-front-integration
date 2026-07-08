-- =============================================================================
-- Migration 159: outbound_call_settings — per-company retry settings for the
-- outbound part-arrived robot call (OUTBOUND-PARTS-CALL-001, OPC1-T4, FR-10).
--
-- Mirrors slot_engine_settings (REC-SETTINGS-001): one row per company, company_id is
-- both PK and FK. outboundCallSettingsService.resolve(companyId) returns DEFAULTS if no
-- row exists (safe-fail, never 500). No Settings UI in v1 — only the Boston Masters row
-- need exist; code reads by job.company_id.
--
--   max_attempts     — max robot-call attempts before the attempt goes 'exhausted'
--   backoff_schedule — ordered retry cadence, one entry per attempt gap
--   next_morning_hour— hour-of-day (company tz) used for the 'next_business_morning' gap
--   enabled          — per-company kill switch / v1 allowlist flag
-- =============================================================================

CREATE TABLE IF NOT EXISTS outbound_call_settings (
    company_id       UUID PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
    max_attempts     INTEGER     NOT NULL DEFAULT 3,
    backoff_schedule JSONB       NOT NULL DEFAULT '["immediate","+2h","next_business_morning"]'::jsonb,
    next_morning_hour INTEGER    NOT NULL DEFAULT 9,
    enabled          BOOLEAN     NOT NULL DEFAULT true,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DROP TRIGGER IF EXISTS trg_outbound_call_settings_updated_at ON outbound_call_settings;
CREATE TRIGGER trg_outbound_call_settings_updated_at
    BEFORE UPDATE ON outbound_call_settings
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

COMMENT ON TABLE outbound_call_settings IS 'OUTBOUND-PARTS-CALL-001 (FR-10): per-company retry settings for the outbound part-arrived robot call. Resolved with safe-fail defaults (outboundCallSettingsService.resolve).';
