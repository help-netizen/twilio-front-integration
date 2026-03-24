-- =============================================================================
-- Migration 041: Add lat/lng columns to jobs table
-- =============================================================================
-- The jobsService already reads/writes lat/lng but the columns were missing
-- from the original 031_create_jobs migration.

ALTER TABLE jobs ADD COLUMN IF NOT EXISTS lat DOUBLE PRECISION;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS lng DOUBLE PRECISION;
