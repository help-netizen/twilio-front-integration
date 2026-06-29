-- =============================================================================
-- Migration 137: jobs.city (TILE-CITY-001).
-- Mobile job/schedule tiles want to show "Customer, City" instead of the full
-- street address. Store a dedicated city value on the job so the tile doesn't
-- have to parse the address string at render time. Additive & idempotent.
--
-- Going forward, clean city values come from ZenBooker sync (service_address.city)
-- and the manual-create path (structured address.city). The backfill below is a
-- best-effort HEURISTIC for pre-existing rows only: it assumes addresses shaped
-- like "street, city, state zip" and takes the 2nd comma-separated segment. It is
-- intentionally conservative (only fills NULL city on rows with >= 2 commas) and
-- re-runnable.
-- =============================================================================

ALTER TABLE jobs ADD COLUMN IF NOT EXISTS city TEXT;

-- Heuristic backfill for existing rows: "street, city, state zip" → city.
-- Only touches rows that still have no city and whose address has at least two
-- commas (so we don't mangle single-line / partial addresses). Re-runnable: once
-- city is set the row is skipped on subsequent runs.
UPDATE jobs
SET city = NULLIF(btrim(split_part(address, ',', 2)), '')
WHERE city IS NULL
  AND address LIKE '%,%,%';
