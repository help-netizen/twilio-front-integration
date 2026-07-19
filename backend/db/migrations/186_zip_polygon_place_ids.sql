-- ZIP-POLYGONS-001: persist Google's public ZIP boundary identifiers alongside
-- the existing global ZIP geography cache. Place IDs contain no tenant data
-- and Google explicitly permits storing them for later reuse.

ALTER TABLE zip_geocache
    ADD COLUMN IF NOT EXISTS google_place_id TEXT,
    ADD COLUMN IF NOT EXISTS place_id_resolved_at TIMESTAMPTZ;

COMMENT ON COLUMN zip_geocache.google_place_id IS
    'ZIP-POLYGONS-001 Google postal-code Place ID used to join DDS boundary features; global public geography, not tenant data.';
COMMENT ON COLUMN zip_geocache.place_id_resolved_at IS
    'When google_place_id was last obtained from Google; IDs older than 12 months are eligible for refresh.';
