-- =============================================================================
-- Rollback 178: remove Rate Me token attribution timestamps.
-- =============================================================================

ALTER TABLE rate_tokens DROP COLUMN IF EXISTS sent_via;
ALTER TABLE rate_tokens DROP COLUMN IF EXISTS sent_at;
ALTER TABLE rate_tokens DROP COLUMN IF EXISTS google_click_at;
ALTER TABLE rate_tokens DROP COLUMN IF EXISTS opened_at;
