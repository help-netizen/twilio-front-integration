-- Roll back TECH-ID-CANON-001 T3. Run only after rollback 257 when both were applied.

ALTER TABLE technician_profiles
    ALTER COLUMN technician_uuid DROP NOT NULL;
ALTER TABLE technician_time_off
    ALTER COLUMN technician_uuid DROP NOT NULL;
ALTER TABLE technician_work_schedules
    ALTER COLUMN technician_uuid DROP NOT NULL;
ALTER TABLE technician_work_schedule_days
    ALTER COLUMN technician_uuid DROP NOT NULL;
ALTER TABLE technician_district_assignments
    ALTER COLUMN technician_uuid DROP NOT NULL;
ALTER TABLE technician_radius_assignments
    ALTER COLUMN technician_uuid DROP NOT NULL;
ALTER TABLE technician_area_wildcards
    ALTER COLUMN technician_uuid DROP NOT NULL;

ALTER TABLE technician_work_schedule_days
    DROP CONSTRAINT technician_work_schedule_days_native_fk;
ALTER TABLE technician_area_wildcards
    DROP CONSTRAINT technician_area_wildcards_native_fk;
ALTER TABLE technician_radius_assignments
    DROP CONSTRAINT technician_radius_assignments_native_fk;
ALTER TABLE technician_district_assignments
    DROP CONSTRAINT technician_district_assignments_native_fk;
ALTER TABLE technician_work_schedules
    DROP CONSTRAINT technician_work_schedules_native_fk;
ALTER TABLE technician_time_off
    DROP CONSTRAINT technician_time_off_native_fk;
ALTER TABLE technician_base_locations
    DROP CONSTRAINT technician_base_locations_native_fk;
ALTER TABLE technician_profiles
    DROP CONSTRAINT technician_profiles_native_fk;

ALTER TABLE technician_profiles
    ADD CONSTRAINT technician_profiles_native_fk
    FOREIGN KEY (company_id, technician_uuid)
    REFERENCES technicians(company_id, id) ON DELETE RESTRICT NOT VALID;
ALTER TABLE technician_base_locations
    ADD CONSTRAINT technician_base_locations_native_fk
    FOREIGN KEY (company_id, technician_uuid)
    REFERENCES technicians(company_id, id) ON DELETE RESTRICT NOT VALID;
ALTER TABLE technician_time_off
    ADD CONSTRAINT technician_time_off_native_fk
    FOREIGN KEY (company_id, technician_uuid)
    REFERENCES technicians(company_id, id) ON DELETE RESTRICT NOT VALID;
ALTER TABLE technician_work_schedules
    ADD CONSTRAINT technician_work_schedules_native_fk
    FOREIGN KEY (company_id, technician_uuid)
    REFERENCES technicians(company_id, id) ON DELETE RESTRICT NOT VALID;
ALTER TABLE technician_work_schedule_days
    ADD CONSTRAINT technician_work_schedule_days_native_fk
    FOREIGN KEY (company_id, technician_uuid)
    REFERENCES technician_work_schedules(company_id, technician_uuid)
    ON DELETE CASCADE NOT VALID;
ALTER TABLE technician_district_assignments
    ADD CONSTRAINT technician_district_assignments_native_fk
    FOREIGN KEY (company_id, technician_uuid)
    REFERENCES technicians(company_id, id) ON DELETE RESTRICT NOT VALID;
ALTER TABLE technician_radius_assignments
    ADD CONSTRAINT technician_radius_assignments_native_fk
    FOREIGN KEY (company_id, technician_uuid)
    REFERENCES technicians(company_id, id) ON DELETE RESTRICT NOT VALID;
ALTER TABLE technician_area_wildcards
    ADD CONSTRAINT technician_area_wildcards_native_fk
    FOREIGN KEY (company_id, technician_uuid)
    REFERENCES technicians(company_id, id) ON DELETE RESTRICT NOT VALID;

DROP INDEX IF EXISTS uq_technician_base_locations_company_default;
ALTER TABLE technician_base_locations
    DROP CONSTRAINT IF EXISTS technician_base_locations_owner_check,
    DROP CONSTRAINT IF EXISTS technician_base_locations_id_key,
    DROP COLUMN IF EXISTS is_company_default,
    DROP COLUMN IF EXISTS id;
