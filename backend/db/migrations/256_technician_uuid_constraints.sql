-- TECH-ID-CANON-001 T3: validate native technician references and make the
-- company base row explicit. origin/master max was 255 immediately before
-- this file was created (2026-08-12).

ALTER TABLE technician_base_locations
    ADD COLUMN IF NOT EXISTS id UUID NOT NULL DEFAULT gen_random_uuid(),
    ADD COLUMN IF NOT EXISTS is_company_default BOOLEAN NOT NULL DEFAULT FALSE;

UPDATE technician_base_locations
SET is_company_default = (tech_id = '__company__')
WHERE is_company_default IS DISTINCT FROM (tech_id = '__company__');

ALTER TABLE technician_base_locations
    ADD CONSTRAINT technician_base_locations_id_key UNIQUE (id),
    ADD CONSTRAINT technician_base_locations_owner_check CHECK (
        (is_company_default = TRUE AND technician_uuid IS NULL)
        OR
        (is_company_default = FALSE AND technician_uuid IS NOT NULL)
    );

CREATE UNIQUE INDEX uq_technician_base_locations_company_default
    ON technician_base_locations (company_id)
    WHERE is_company_default = TRUE;

ALTER TABLE technician_profiles
    VALIDATE CONSTRAINT technician_profiles_native_fk;
ALTER TABLE technician_base_locations
    VALIDATE CONSTRAINT technician_base_locations_native_fk;
ALTER TABLE technician_time_off
    VALIDATE CONSTRAINT technician_time_off_native_fk;
ALTER TABLE technician_work_schedules
    VALIDATE CONSTRAINT technician_work_schedules_native_fk;
ALTER TABLE technician_work_schedule_days
    VALIDATE CONSTRAINT technician_work_schedule_days_native_fk;
ALTER TABLE technician_district_assignments
    VALIDATE CONSTRAINT technician_district_assignments_native_fk;
ALTER TABLE technician_radius_assignments
    VALIDATE CONSTRAINT technician_radius_assignments_native_fk;
ALTER TABLE technician_area_wildcards
    VALIDATE CONSTRAINT technician_area_wildcards_native_fk;

ALTER TABLE technician_profiles
    ALTER COLUMN technician_uuid SET NOT NULL;
ALTER TABLE technician_time_off
    ALTER COLUMN technician_uuid SET NOT NULL;
ALTER TABLE technician_work_schedules
    ALTER COLUMN technician_uuid SET NOT NULL;
ALTER TABLE technician_work_schedule_days
    ALTER COLUMN technician_uuid SET NOT NULL;
ALTER TABLE technician_district_assignments
    ALTER COLUMN technician_uuid SET NOT NULL;
ALTER TABLE technician_radius_assignments
    ALTER COLUMN technician_uuid SET NOT NULL;
ALTER TABLE technician_area_wildcards
    ALTER COLUMN technician_uuid SET NOT NULL;

COMMENT ON COLUMN technician_base_locations.is_company_default IS
    'True for the single company-level base address; false for technician-owned rows.';
COMMENT ON COLUMN technician_base_locations.id IS
    'Stable row identity replacing the overloaded legacy (company_id, tech_id) key.';
