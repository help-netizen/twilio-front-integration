-- Roll back TECH-ID-CANON-001 T4. Reconstructed legacy values are UUID text;
-- historical Zenbooker strings remain available in technician_external_identities.

ALTER TABLE technician_profiles ADD COLUMN tech_id TEXT;
ALTER TABLE technician_base_locations ADD COLUMN tech_id TEXT;
ALTER TABLE technician_time_off ADD COLUMN technician_id TEXT;
ALTER TABLE technician_work_schedules ADD COLUMN technician_id TEXT;
ALTER TABLE technician_work_schedule_days ADD COLUMN technician_id TEXT;
ALTER TABLE technician_district_assignments ADD COLUMN technician_id TEXT;
ALTER TABLE technician_radius_assignments ADD COLUMN technician_id TEXT;
ALTER TABLE technician_area_wildcards ADD COLUMN technician_id TEXT;

UPDATE technician_profiles SET tech_id = technician_uuid::text;
UPDATE technician_base_locations
SET tech_id = CASE WHEN is_company_default THEN '__company__' ELSE technician_uuid::text END;
UPDATE technician_time_off SET technician_id = technician_uuid::text;
UPDATE technician_work_schedules SET technician_id = technician_uuid::text;
UPDATE technician_work_schedule_days SET technician_id = technician_uuid::text;
UPDATE technician_district_assignments SET technician_id = technician_uuid::text;
UPDATE technician_radius_assignments SET technician_id = technician_uuid::text;
UPDATE technician_area_wildcards SET technician_id = technician_uuid::text;

ALTER TABLE technician_profiles ALTER COLUMN tech_id SET NOT NULL;
ALTER TABLE technician_base_locations ALTER COLUMN tech_id SET NOT NULL;
ALTER TABLE technician_time_off ALTER COLUMN technician_id SET NOT NULL;
ALTER TABLE technician_work_schedules ALTER COLUMN technician_id SET NOT NULL;
ALTER TABLE technician_work_schedule_days ALTER COLUMN technician_id SET NOT NULL;
ALTER TABLE technician_district_assignments ALTER COLUMN technician_id SET NOT NULL;
ALTER TABLE technician_radius_assignments ALTER COLUMN technician_id SET NOT NULL;
ALTER TABLE technician_area_wildcards ALTER COLUMN technician_id SET NOT NULL;

ALTER TABLE technician_work_schedule_days
    DROP CONSTRAINT technician_work_schedule_days_native_fk,
    DROP CONSTRAINT technician_work_schedule_days_pkey;
ALTER TABLE technician_work_schedules
    DROP CONSTRAINT technician_work_schedules_pkey;
ALTER TABLE technician_district_assignments
    DROP CONSTRAINT technician_district_assignments_pkey;
ALTER TABLE technician_radius_assignments
    DROP CONSTRAINT technician_radius_assignments_pkey;
ALTER TABLE technician_area_wildcards
    DROP CONSTRAINT technician_area_wildcards_pkey;
ALTER TABLE technician_profiles
    DROP CONSTRAINT technician_profiles_company_technician_key;
ALTER TABLE technician_base_locations
    DROP CONSTRAINT technician_base_locations_pkey;

ALTER TABLE technician_profiles
    ADD CONSTRAINT technician_profiles_company_id_tech_id_key
    UNIQUE (company_id, tech_id);
CREATE UNIQUE INDEX uq_technician_profiles_native
    ON technician_profiles (company_id, technician_uuid)
    WHERE technician_uuid IS NOT NULL;

ALTER TABLE technician_base_locations
    ADD CONSTRAINT technician_base_locations_id_key UNIQUE (id),
    ADD CONSTRAINT technician_base_locations_pkey PRIMARY KEY (company_id, tech_id);

CREATE INDEX idx_tech_time_off_lookup
    ON technician_time_off (company_id, technician_id, starts_at);

ALTER TABLE technician_work_schedules
    ADD CONSTRAINT technician_work_schedules_pkey
    PRIMARY KEY (company_id, technician_id);
CREATE UNIQUE INDEX uq_technician_work_schedules_native
    ON technician_work_schedules (company_id, technician_uuid);
ALTER TABLE technician_work_schedule_days
    ADD CONSTRAINT technician_work_schedule_days_pkey
    PRIMARY KEY (company_id, technician_id, day_of_week),
    ADD CONSTRAINT technician_work_schedule_days_schedule_fk
    FOREIGN KEY (company_id, technician_id)
    REFERENCES technician_work_schedules(company_id, technician_id)
    ON DELETE CASCADE,
    ADD CONSTRAINT technician_work_schedule_days_native_fk
    FOREIGN KEY (company_id, technician_uuid)
    REFERENCES technician_work_schedules(company_id, technician_uuid)
    ON DELETE CASCADE;
CREATE UNIQUE INDEX uq_technician_work_schedule_days_native
    ON technician_work_schedule_days (company_id, technician_uuid, day_of_week)
    WHERE technician_uuid IS NOT NULL;

ALTER TABLE technician_district_assignments
    ADD CONSTRAINT technician_district_assignments_pkey
    PRIMARY KEY (company_id, technician_id, district_name);
CREATE UNIQUE INDEX uq_technician_district_assignments_native
    ON technician_district_assignments (company_id, technician_uuid, district_name)
    WHERE technician_uuid IS NOT NULL;

ALTER TABLE technician_radius_assignments
    ADD CONSTRAINT technician_radius_assignments_pkey
    PRIMARY KEY (company_id, technician_id, radius_id);
CREATE UNIQUE INDEX uq_technician_radius_assignments_native
    ON technician_radius_assignments (company_id, technician_uuid, radius_id)
    WHERE technician_uuid IS NOT NULL;

ALTER TABLE technician_area_wildcards
    ADD CONSTRAINT technician_area_wildcards_pkey
    PRIMARY KEY (company_id, technician_id);
CREATE UNIQUE INDEX uq_technician_area_wildcards_native
    ON technician_area_wildcards (company_id, technician_uuid)
    WHERE technician_uuid IS NOT NULL;
