-- =============================================================================
-- Migration 119: technician_profiles — per-tenant technician display info for the
-- public payment page (photo + display name). Technicians live in jobs.assigned_techs
-- (JSONB) keyed by tech_id; this table adds an uploadable photo + override name.
-- =============================================================================

CREATE TABLE IF NOT EXISTS technician_profiles (
    id                  BIGSERIAL PRIMARY KEY,
    company_id          UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    tech_id             TEXT NOT NULL,
    name                TEXT,
    photo_storage_key   TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (company_id, tech_id)
);

DROP TRIGGER IF EXISTS trg_technician_profiles_updated_at ON technician_profiles;
CREATE TRIGGER trg_technician_profiles_updated_at
    BEFORE UPDATE ON technician_profiles
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

COMMENT ON TABLE technician_profiles IS 'Technician photo/display info for public payment page.';
