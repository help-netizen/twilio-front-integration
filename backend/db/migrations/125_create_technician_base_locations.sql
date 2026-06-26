-- =============================================================================
-- Migration 125: technician_base_locations — per-tenant home/base coordinates for
-- each technician (SLOT-ENGINE-001 Phase 2). The slot engine anchors a tech's day
-- to this point; Albusto pushes it in the snapshot. Keyed by (company_id, tech_id);
-- tech_id mirrors jobs.assigned_techs[].id (the Zenbooker team-member id).
-- =============================================================================

CREATE TABLE IF NOT EXISTS technician_base_locations (
    company_id  UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    tech_id     TEXT NOT NULL,
    lat         DOUBLE PRECISION NOT NULL,
    lng         DOUBLE PRECISION NOT NULL,
    label       TEXT,
    address     TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (company_id, tech_id)
);

DROP TRIGGER IF EXISTS trg_technician_base_locations_updated_at ON technician_base_locations;
CREATE TRIGGER trg_technician_base_locations_updated_at
    BEFORE UPDATE ON technician_base_locations
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

COMMENT ON TABLE technician_base_locations IS 'Technician home/base coordinates pushed to the slot engine.';
