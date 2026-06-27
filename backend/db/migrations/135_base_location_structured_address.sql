-- =============================================================================
-- Migration 135: structured base address (ADDR-UX-001).
-- The base-address editors (CompanyBaseAddress + per-tech base) need to pre-fill
-- their edit form exactly, so we store the address as structured fields in addition
-- to the existing composed string + lat/lng/label. Additive & idempotent; the
-- slot engine keeps using lat/lng/address unchanged.
-- =============================================================================

ALTER TABLE technician_base_locations
    ADD COLUMN IF NOT EXISTS street TEXT,
    ADD COLUMN IF NOT EXISTS apt    TEXT,
    ADD COLUMN IF NOT EXISTS city   TEXT,
    ADD COLUMN IF NOT EXISTS state  TEXT,
    ADD COLUMN IF NOT EXISTS zip    TEXT;
