-- 240_native_technician_directory.sql
-- ZB-DECOUPLE-001 Phase A: durable Albusto-native technician identity.
--
-- Legacy TEXT keys remain intact during dual-read. technician_uuid is the
-- canonical native identity once its row is populated.

CREATE TABLE IF NOT EXISTS technicians (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id   UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    display_name TEXT NOT NULL CHECK (BTRIM(display_name) <> ''),
    active       BOOLEAN NOT NULL DEFAULT TRUE,
    crm_user_id  UUID,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT technicians_company_id_id_key
        UNIQUE (company_id, id),

    -- Enforces that the linked CRM user belongs to this same company. Deleting
    -- the membership unlinks the technician without deleting technician history.
    CONSTRAINT technicians_crm_membership_fk
        FOREIGN KEY (crm_user_id, company_id)
        REFERENCES company_memberships(user_id, company_id)
        ON DELETE SET NULL (crm_user_id)
);

CREATE INDEX IF NOT EXISTS idx_technicians_company_active_name
    ON technicians (company_id, active, display_name, id);

CREATE UNIQUE INDEX IF NOT EXISTS uq_technicians_company_crm_user
    ON technicians (company_id, crm_user_id)
    WHERE crm_user_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS technician_external_identities (
    company_id    UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    source        TEXT NOT NULL CHECK (
        BTRIM(source) <> '' AND source = LOWER(source)
    ),
    external_id   TEXT NOT NULL CHECK (BTRIM(external_id) <> ''),
    technician_id UUID NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    PRIMARY KEY (company_id, source, external_id),

    CONSTRAINT technician_external_identities_technician_fk
        FOREIGN KEY (company_id, technician_id)
        REFERENCES technicians(company_id, id)
        ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_technician_external_identities_technician
    ON technician_external_identities (company_id, technician_id, source);

ALTER TABLE technician_profiles
    ADD COLUMN IF NOT EXISTS technician_uuid UUID;

ALTER TABLE technician_base_locations
    ADD COLUMN IF NOT EXISTS technician_uuid UUID;

ALTER TABLE technician_time_off
    ADD COLUMN IF NOT EXISTS technician_uuid UUID;

ALTER TABLE technician_work_schedules
    ADD COLUMN IF NOT EXISTS technician_uuid UUID;

-- Required even though it was omitted from the brief's table list: the child
-- table has its own copy of the legacy technician key.
ALTER TABLE technician_work_schedule_days
    ADD COLUMN IF NOT EXISTS technician_uuid UUID;

ALTER TABLE technician_district_assignments
    ADD COLUMN IF NOT EXISTS technician_uuid UUID;

ALTER TABLE technician_radius_assignments
    ADD COLUMN IF NOT EXISTS technician_uuid UUID;

ALTER TABLE technician_area_wildcards
    ADD COLUMN IF NOT EXISTS technician_uuid UUID;

CREATE UNIQUE INDEX IF NOT EXISTS uq_technician_profiles_native
    ON technician_profiles (company_id, technician_uuid)
    WHERE technician_uuid IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_technician_base_locations_native
    ON technician_base_locations (company_id, technician_uuid)
    WHERE technician_uuid IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_technician_time_off_native_lookup
    ON technician_time_off (company_id, technician_uuid, starts_at)
    WHERE technician_uuid IS NOT NULL;

-- Non-partial because technician_work_schedule_days needs to reference it.
-- PostgreSQL still allows multiple NULL technician_uuid values.
CREATE UNIQUE INDEX IF NOT EXISTS uq_technician_work_schedules_native
    ON technician_work_schedules (company_id, technician_uuid);

CREATE UNIQUE INDEX IF NOT EXISTS uq_technician_work_schedule_days_native
    ON technician_work_schedule_days
       (company_id, technician_uuid, day_of_week)
    WHERE technician_uuid IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_technician_district_assignments_native
    ON technician_district_assignments
       (company_id, technician_uuid, district_name)
    WHERE technician_uuid IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_technician_radius_assignments_native
    ON technician_radius_assignments
       (company_id, technician_uuid, radius_id)
    WHERE technician_uuid IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_technician_area_wildcards_native
    ON technician_area_wildcards (company_id, technician_uuid)
    WHERE technician_uuid IS NOT NULL;

DO $migration$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'technician_profiles_native_fk'
          AND conrelid = 'technician_profiles'::regclass
    ) THEN
        ALTER TABLE technician_profiles
            ADD CONSTRAINT technician_profiles_native_fk
            FOREIGN KEY (company_id, technician_uuid)
            REFERENCES technicians(company_id, id)
            ON DELETE RESTRICT NOT VALID;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'technician_base_locations_native_fk'
          AND conrelid = 'technician_base_locations'::regclass
    ) THEN
        ALTER TABLE technician_base_locations
            ADD CONSTRAINT technician_base_locations_native_fk
            FOREIGN KEY (company_id, technician_uuid)
            REFERENCES technicians(company_id, id)
            ON DELETE RESTRICT NOT VALID;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'technician_time_off_native_fk'
          AND conrelid = 'technician_time_off'::regclass
    ) THEN
        ALTER TABLE technician_time_off
            ADD CONSTRAINT technician_time_off_native_fk
            FOREIGN KEY (company_id, technician_uuid)
            REFERENCES technicians(company_id, id)
            ON DELETE RESTRICT NOT VALID;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'technician_work_schedules_native_fk'
          AND conrelid = 'technician_work_schedules'::regclass
    ) THEN
        ALTER TABLE technician_work_schedules
            ADD CONSTRAINT technician_work_schedules_native_fk
            FOREIGN KEY (company_id, technician_uuid)
            REFERENCES technicians(company_id, id)
            ON DELETE RESTRICT NOT VALID;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'technician_work_schedule_days_native_fk'
          AND conrelid = 'technician_work_schedule_days'::regclass
    ) THEN
        ALTER TABLE technician_work_schedule_days
            ADD CONSTRAINT technician_work_schedule_days_native_fk
            FOREIGN KEY (company_id, technician_uuid)
            REFERENCES technician_work_schedules(company_id, technician_uuid)
            ON DELETE CASCADE NOT VALID;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'technician_district_assignments_native_fk'
          AND conrelid = 'technician_district_assignments'::regclass
    ) THEN
        ALTER TABLE technician_district_assignments
            ADD CONSTRAINT technician_district_assignments_native_fk
            FOREIGN KEY (company_id, technician_uuid)
            REFERENCES technicians(company_id, id)
            ON DELETE RESTRICT NOT VALID;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'technician_radius_assignments_native_fk'
          AND conrelid = 'technician_radius_assignments'::regclass
    ) THEN
        ALTER TABLE technician_radius_assignments
            ADD CONSTRAINT technician_radius_assignments_native_fk
            FOREIGN KEY (company_id, technician_uuid)
            REFERENCES technicians(company_id, id)
            ON DELETE RESTRICT NOT VALID;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'technician_area_wildcards_native_fk'
          AND conrelid = 'technician_area_wildcards'::regclass
    ) THEN
        ALTER TABLE technician_area_wildcards
            ADD CONSTRAINT technician_area_wildcards_native_fk
            FOREIGN KEY (company_id, technician_uuid)
            REFERENCES technicians(company_id, id)
            ON DELETE RESTRICT NOT VALID;
    END IF;
END
$migration$;

COMMENT ON TABLE technicians IS
    'Albusto-native technician directory. active controls operational roster membership; rows are deactivated rather than deleted.';

COMMENT ON TABLE technician_external_identities IS
    'Tenant-scoped external identities mapped to Albusto technician UUIDs. Phase A source is zenbooker.';

COMMENT ON COLUMN technicians.crm_user_id IS
    'Optional crm_users.id linked through a membership in the same company. This is not the jobs authorization mirror.';

COMMENT ON COLUMN technician_area_wildcards.technician_uuid IS
    'Native technician identity for ZONE-STRICT eligibility. Legacy technician_id remains during dual-read.';
