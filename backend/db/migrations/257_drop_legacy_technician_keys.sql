-- TECH-ID-CANON-001 T4: native UUID is now the sole stored technician key in
-- configuration tables. External ids remain only in technician_external_identities.

ALTER TABLE technician_profiles
    DROP CONSTRAINT technician_profiles_company_id_tech_id_key;
DROP INDEX IF EXISTS uq_technician_profiles_native;

ALTER TABLE technician_base_locations
    DROP CONSTRAINT technician_base_locations_pkey,
    DROP CONSTRAINT technician_base_locations_id_key;

DROP INDEX IF EXISTS idx_tech_time_off_lookup;

ALTER TABLE technician_work_schedule_days
    DROP CONSTRAINT technician_work_schedule_days_schedule_fk,
    DROP CONSTRAINT technician_work_schedule_days_native_fk,
    DROP CONSTRAINT technician_work_schedule_days_pkey;
ALTER TABLE technician_work_schedules
    DROP CONSTRAINT technician_work_schedules_pkey;
DROP INDEX IF EXISTS uq_technician_work_schedules_native;
DROP INDEX IF EXISTS uq_technician_work_schedule_days_native;

ALTER TABLE technician_district_assignments
    DROP CONSTRAINT technician_district_assignments_pkey;
DROP INDEX IF EXISTS uq_technician_district_assignments_native;

ALTER TABLE technician_radius_assignments
    DROP CONSTRAINT technician_radius_assignments_pkey;
DROP INDEX IF EXISTS uq_technician_radius_assignments_native;

ALTER TABLE technician_area_wildcards
    DROP CONSTRAINT technician_area_wildcards_pkey;
DROP INDEX IF EXISTS uq_technician_area_wildcards_native;

ALTER TABLE technician_profiles DROP COLUMN tech_id;
ALTER TABLE technician_base_locations DROP COLUMN tech_id;
ALTER TABLE technician_time_off DROP COLUMN technician_id;
ALTER TABLE technician_work_schedules DROP COLUMN technician_id;
ALTER TABLE technician_work_schedule_days DROP COLUMN technician_id;
ALTER TABLE technician_district_assignments DROP COLUMN technician_id;
ALTER TABLE technician_radius_assignments DROP COLUMN technician_id;
ALTER TABLE technician_area_wildcards DROP COLUMN technician_id;

ALTER TABLE technician_profiles
    ADD CONSTRAINT technician_profiles_company_technician_key
    UNIQUE (company_id, technician_uuid);
ALTER TABLE technician_base_locations
    ADD CONSTRAINT technician_base_locations_pkey PRIMARY KEY (id);
ALTER TABLE technician_work_schedules
    ADD CONSTRAINT technician_work_schedules_pkey
    PRIMARY KEY (company_id, technician_uuid);
ALTER TABLE technician_work_schedule_days
    ADD CONSTRAINT technician_work_schedule_days_pkey
    PRIMARY KEY (company_id, technician_uuid, day_of_week),
    ADD CONSTRAINT technician_work_schedule_days_native_fk
    FOREIGN KEY (company_id, technician_uuid)
    REFERENCES technician_work_schedules(company_id, technician_uuid)
    ON DELETE CASCADE;
ALTER TABLE technician_district_assignments
    ADD CONSTRAINT technician_district_assignments_pkey
    PRIMARY KEY (company_id, technician_uuid, district_name);
ALTER TABLE technician_radius_assignments
    ADD CONSTRAINT technician_radius_assignments_pkey
    PRIMARY KEY (company_id, technician_uuid, radius_id);
ALTER TABLE technician_area_wildcards
    ADD CONSTRAINT technician_area_wildcards_pkey
    PRIMARY KEY (company_id, technician_uuid);

COMMENT ON TABLE technician_base_locations IS
    'Technician and company-default base coordinates. Technician rows use technician_uuid; the company row is marked by is_company_default.';
COMMENT ON COLUMN technician_time_off.technician_uuid IS
    'Canonical Albusto technician identity (technicians.id).';
