-- =============================================================================
-- Migration 168: radius-based service territories — SERVICE-TERR-002 (T1.1).
--
-- Companies retain their existing ZIP-list territory data while choosing one
-- active containment mode. Radius centers snapshot their geocoded coordinates
-- at creation time. zip_geocache is intentionally global because it contains
-- only public ZIP geography and no tenant data.
--
-- Additive and idempotent (IF NOT EXISTS). Reversible via
-- rollback_168_service_territory_radius.sql.
-- =============================================================================

CREATE TABLE IF NOT EXISTS company_territory_settings (
    company_id  UUID PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
    active_mode TEXT NOT NULL DEFAULT 'list' CHECK (active_mode IN ('list', 'radius')),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS territory_radii (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id   UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    zip          VARCHAR(10) NOT NULL,
    lat          NUMERIC(9,6) NOT NULL,
    lon          NUMERIC(9,6) NOT NULL,
    radius_miles NUMERIC(5,1) NOT NULL CHECK (radius_miles > 0 AND radius_miles <= 200),
    position     INT NOT NULL DEFAULT 0,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_territory_radii_company_id
    ON territory_radii (company_id);

CREATE TABLE IF NOT EXISTS zip_geocache (
    zip          VARCHAR(10) PRIMARY KEY,
    lat          NUMERIC(9,6),
    lon          NUMERIC(9,6),
    city         TEXT,
    state        TEXT,
    geocoded_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE company_territory_settings IS 'SERVICE-TERR-002: active service-territory containment mode per company; a missing row means list mode.';
COMMENT ON TABLE territory_radii IS 'SERVICE-TERR-002: company-scoped radius centers with geocode coordinates snapshotted at creation time.';
COMMENT ON TABLE zip_geocache IS 'SERVICE-TERR-002 documented tenant-scope exception: global cache of public ZIP geography only; intentionally has no company_id and contains no tenant data.';
COMMENT ON COLUMN territory_radii.lat IS 'Latitude snapshot from ZIP geocoding at radius creation time.';
COMMENT ON COLUMN territory_radii.lon IS 'Longitude snapshot from ZIP geocoding at radius creation time.';
