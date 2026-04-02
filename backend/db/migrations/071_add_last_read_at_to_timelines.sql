-- =============================================================================
-- 071: Add last_read_at to timelines (fixes mark-read 500 error)
-- =============================================================================

ALTER TABLE timelines ADD COLUMN IF NOT EXISTS last_read_at TIMESTAMPTZ;
