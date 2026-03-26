-- =============================================================================
-- Migration 048: Create user profile tables for PF007
-- company_user_profiles, company_user_service_areas, company_user_skills
-- =============================================================================

-- 1. Company user profiles — field-tech and dispatch-specific attributes
CREATE TABLE IF NOT EXISTS company_user_profiles (
    id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    membership_id               UUID NOT NULL UNIQUE REFERENCES company_memberships(id) ON DELETE CASCADE,
    phone                       VARCHAR(50),
    schedule_color              VARCHAR(20) DEFAULT '#3B82F6',
    is_provider                 BOOLEAN NOT NULL DEFAULT false,
    call_masking_enabled        BOOLEAN NOT NULL DEFAULT false,
    location_tracking_enabled   BOOLEAN NOT NULL DEFAULT false,
    phone_calls_allowed         BOOLEAN NOT NULL DEFAULT false,
    job_close_mode              VARCHAR(30) NOT NULL DEFAULT 'close',
    created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT chk_job_close_mode CHECK (job_close_mode IN ('close', 'done_pending_approval'))
);

CREATE INDEX IF NOT EXISTS idx_user_profiles_membership ON company_user_profiles(membership_id);

CREATE TRIGGER trg_user_profiles_updated_at BEFORE UPDATE ON company_user_profiles
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

COMMENT ON TABLE company_user_profiles IS 'Per-membership user profile with field-tech attributes (PF007)';

-- 2. Company user service areas
CREATE TABLE IF NOT EXISTS company_user_service_areas (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    membership_id   UUID NOT NULL REFERENCES company_memberships(id) ON DELETE CASCADE,
    service_area_id UUID NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT uq_user_service_area UNIQUE (membership_id, service_area_id)
);

CREATE INDEX IF NOT EXISTS idx_user_service_areas_membership ON company_user_service_areas(membership_id);

COMMENT ON TABLE company_user_service_areas IS 'User-to-service-area restrictions (PF007)';

-- 3. Company user skills / job types
CREATE TABLE IF NOT EXISTS company_user_skills (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    membership_id   UUID NOT NULL REFERENCES company_memberships(id) ON DELETE CASCADE,
    job_type_id     UUID NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT uq_user_skill UNIQUE (membership_id, job_type_id)
);

CREATE INDEX IF NOT EXISTS idx_user_skills_membership ON company_user_skills(membership_id);

COMMENT ON TABLE company_user_skills IS 'User-to-job-type/skill restrictions (PF007)';

-- Backfill: create profiles for existing memberships, migrating phone_calls_allowed
INSERT INTO company_user_profiles (membership_id, phone_calls_allowed)
SELECT m.id, COALESCE(m.phone_calls_allowed, false)
FROM company_memberships m
WHERE NOT EXISTS (
    SELECT 1 FROM company_user_profiles p WHERE p.membership_id = m.id
);
