-- =============================================================================
-- Migration 051: Create dispatch_settings table (PF001 Schedule/Dispatcher)
-- Company-level dispatch configuration for schedule views
-- =============================================================================

CREATE TABLE IF NOT EXISTS dispatch_settings (
    id              BIGSERIAL PRIMARY KEY,
    company_id      UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    timezone        VARCHAR(100) NOT NULL DEFAULT 'America/New_York',
    work_start_time TIME NOT NULL DEFAULT '08:00',
    work_end_time   TIME NOT NULL DEFAULT '18:00',
    work_days       SMALLINT[] NOT NULL DEFAULT '{1,2,3,4,5}',
    slot_duration   INTEGER NOT NULL DEFAULT 60,
    buffer_minutes  INTEGER NOT NULL DEFAULT 0,
    settings_json   JSONB NOT NULL DEFAULT '{}',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_dispatch_settings_company UNIQUE (company_id)
);

CREATE TRIGGER trg_dispatch_settings_updated_at
    BEFORE UPDATE ON dispatch_settings
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

COMMENT ON TABLE dispatch_settings IS 'PF001: Company-level dispatch/schedule configuration';
