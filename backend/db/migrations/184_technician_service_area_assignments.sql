-- =============================================================================
-- Migration 184: per-technician Albusto service-area assignments
-- (TECH-SCHEDULE-001, Phase B).
--
-- District and radius maps are deliberately independent. A technician with no
-- valid assignments in the active mode is a wildcard; no wildcard row is stored.
-- =============================================================================

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'territory_radii_company_id_id_key'
          AND conrelid = 'territory_radii'::regclass
    ) THEN
        ALTER TABLE territory_radii
            ADD CONSTRAINT territory_radii_company_id_id_key
            UNIQUE (company_id, id);
    END IF;
END $$;

CREATE TABLE IF NOT EXISTS technician_district_assignments (
    company_id    UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    technician_id TEXT NOT NULL,
    district_name TEXT NOT NULL,
    created_by    UUID REFERENCES crm_users(id) ON DELETE SET NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (company_id, technician_id, district_name)
);

CREATE INDEX IF NOT EXISTS idx_technician_district_assignments_target
    ON technician_district_assignments (company_id, district_name);

CREATE TABLE IF NOT EXISTS technician_radius_assignments (
    company_id    UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    technician_id TEXT NOT NULL,
    radius_id     UUID NOT NULL,
    created_by    UUID REFERENCES crm_users(id) ON DELETE SET NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (company_id, technician_id, radius_id),
    CONSTRAINT technician_radius_assignments_radius_fk
        FOREIGN KEY (company_id, radius_id)
        REFERENCES territory_radii(company_id, id)
        ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_technician_radius_assignments_target
    ON technician_radius_assignments (company_id, radius_id);
