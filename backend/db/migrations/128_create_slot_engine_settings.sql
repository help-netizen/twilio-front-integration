-- =============================================================================
-- Migration 128: slot_engine_settings — per-company recommendation settings
-- (REC-SETTINGS-001). One row per company holds the discrete, user-editable slot
-- engine parameters (config jsonb: { max_distance_miles, overlap_minutes,
-- min_buffer_minutes, horizon_days, recommendations_shown }). slotEngineService
-- resolves this row and builds the engine config_override from it; the 2 fixed
-- values (allow_empty_day_candidates, max_day_utilization) are NOT stored — they
-- are injected at build time. company_id is both PK and FK (one row per company).
-- =============================================================================

CREATE TABLE IF NOT EXISTS slot_engine_settings (
    company_id  UUID PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
    config      JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DROP TRIGGER IF EXISTS trg_slot_engine_settings_updated_at ON slot_engine_settings;
CREATE TRIGGER trg_slot_engine_settings_updated_at
    BEFORE UPDATE ON slot_engine_settings
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

COMMENT ON TABLE slot_engine_settings IS 'Per-company recommendation settings used to build the slot engine config_override (REC-SETTINGS-001).';
