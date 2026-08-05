-- ZONE-STRICT-001 — an unassigned technician is no longer offered everywhere.
--
-- Until now, absence of assignments WAS the wildcard: a technician with no
-- district (or radius) rows was eligible for every ZIP the company covers. That
-- is why the robot could offer a technician into an area he does not work — and
-- the failure direction was wrong: a renamed district silently turned a properly
-- configured technician into a company-wide one.
--
-- The wildcard becomes EXPLICIT. Presence of a row here means "this technician
-- works across the whole territory"; absence plus no assignments now means "do
-- not offer this technician at all". Owner decision, 2026-08-05.
--
-- Deliberately NOT backfilled: today exactly one ABC Homes technician has no
-- districts, and the point of the change is that he stops being offered outside
-- the areas he actually works. Seeding him as company-wide would preserve the
-- very behaviour we are removing.

CREATE TABLE IF NOT EXISTS technician_area_wildcards (
    company_id    UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    technician_id TEXT NOT NULL,
    created_by    UUID,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (company_id, technician_id)
);

COMMENT ON TABLE technician_area_wildcards IS
    'ZONE-STRICT-001: technicians explicitly marked as serving the whole company territory. '
    'Absence of a row is NOT a wildcard — an unassigned technician is simply not offered.';
