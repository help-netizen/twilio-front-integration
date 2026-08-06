-- rollback_240_native_technician_directory.sql
-- Safe only before native-only technician/config writes become authoritative.

ALTER TABLE technician_work_schedule_days
    DROP CONSTRAINT IF EXISTS technician_work_schedule_days_native_fk;
ALTER TABLE technician_area_wildcards
    DROP CONSTRAINT IF EXISTS technician_area_wildcards_native_fk;
ALTER TABLE technician_radius_assignments
    DROP CONSTRAINT IF EXISTS technician_radius_assignments_native_fk;
ALTER TABLE technician_district_assignments
    DROP CONSTRAINT IF EXISTS technician_district_assignments_native_fk;
ALTER TABLE technician_work_schedules
    DROP CONSTRAINT IF EXISTS technician_work_schedules_native_fk;
ALTER TABLE technician_time_off
    DROP CONSTRAINT IF EXISTS technician_time_off_native_fk;
ALTER TABLE technician_base_locations
    DROP CONSTRAINT IF EXISTS technician_base_locations_native_fk;
ALTER TABLE technician_profiles
    DROP CONSTRAINT IF EXISTS technician_profiles_native_fk;

ALTER TABLE technician_work_schedule_days
    DROP COLUMN IF EXISTS technician_uuid;
ALTER TABLE technician_area_wildcards
    DROP COLUMN IF EXISTS technician_uuid;
ALTER TABLE technician_radius_assignments
    DROP COLUMN IF EXISTS technician_uuid;
ALTER TABLE technician_district_assignments
    DROP COLUMN IF EXISTS technician_uuid;
ALTER TABLE technician_work_schedules
    DROP COLUMN IF EXISTS technician_uuid;
ALTER TABLE technician_time_off
    DROP COLUMN IF EXISTS technician_uuid;
ALTER TABLE technician_base_locations
    DROP COLUMN IF EXISTS technician_uuid;
ALTER TABLE technician_profiles
    DROP COLUMN IF EXISTS technician_uuid;

DROP TABLE IF EXISTS technician_external_identities;
DROP TABLE IF EXISTS technicians;
