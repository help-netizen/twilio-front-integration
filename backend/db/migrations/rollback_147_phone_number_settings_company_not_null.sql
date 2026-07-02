-- =============================================================================
-- Rollback 147: drop the NOT NULL constraint on
-- phone_number_settings.company_id ONLY.
--
-- Migration 147 was a ONE-WAY data migration: the backfilled company_id values
-- (group-rule backfill + DEFAULT-company assignment) are NOT reverted — the
-- prior value was NULL and is not recorded anywhere, so a SQL rollback cannot
-- reconstruct it. To genuinely undo the backfill you would need a
-- point-in-time restore from before 147 ran.
--
-- DROP NOT NULL on an already-nullable column is a no-op — idempotent.
-- =============================================================================

ALTER TABLE phone_number_settings ALTER COLUMN company_id DROP NOT NULL;
