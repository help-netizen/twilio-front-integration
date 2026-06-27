-- Rollback for Migration 135: structured base address (ADDR-UX-001).
-- Drop the structured address columns; lat/lng/label/address are untouched.

ALTER TABLE technician_base_locations
    DROP COLUMN IF EXISTS street,
    DROP COLUMN IF EXISTS apt,
    DROP COLUMN IF EXISTS city,
    DROP COLUMN IF EXISTS state,
    DROP COLUMN IF EXISTS zip;
