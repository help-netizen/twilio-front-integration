-- =============================================================================
-- Rollback migration 168 — SERVICE-TERR-002 radius-based service territories.
-- Drops only the three tables introduced by migration 168. The radius index is
-- dropped with territory_radii. Idempotent (DROP TABLE IF EXISTS).
-- =============================================================================

DROP TABLE IF EXISTS zip_geocache;
DROP TABLE IF EXISTS territory_radii;
DROP TABLE IF EXISTS company_territory_settings;
