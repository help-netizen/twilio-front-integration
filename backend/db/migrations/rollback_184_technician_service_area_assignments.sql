-- Rollback 184: remove technician service-area assignments.
DROP TABLE IF EXISTS technician_radius_assignments;
DROP TABLE IF EXISTS technician_district_assignments;

ALTER TABLE territory_radii
    DROP CONSTRAINT IF EXISTS territory_radii_company_id_id_key;
