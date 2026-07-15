-- =============================================================================
-- Migration 178: Rate Me token attribution timestamps.
-- =============================================================================

ALTER TABLE rate_tokens ADD COLUMN IF NOT EXISTS opened_at TIMESTAMPTZ NULL;
ALTER TABLE rate_tokens ADD COLUMN IF NOT EXISTS google_click_at TIMESTAMPTZ NULL;
ALTER TABLE rate_tokens ADD COLUMN IF NOT EXISTS sent_at TIMESTAMPTZ NULL;
ALTER TABLE rate_tokens ADD COLUMN IF NOT EXISTS sent_via TEXT NULL;
