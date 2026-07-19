-- Rollback ZIP-POLYGONS-001 place-ID cache fields.

ALTER TABLE zip_geocache
    DROP COLUMN IF EXISTS place_id_resolved_at,
    DROP COLUMN IF EXISTS google_place_id;
