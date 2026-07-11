-- =============================================================================
-- Rollback 165: yelp_timeline_dedup — YELP-TIMELINE-DEDUP-001
--
-- Drops the 3 additive columns + 2 indexes + the optional FK column and RESTORES
-- the original strict 2-key chk_timelines_identity (029_revise_timelines.sql:20-21).
-- After this, a contactless + phoneless timeline INSERT fails again (as it did
-- pre-165). Run only after re-pointing / removing any conv-id-only timeline rows,
-- or the restored CHECK's re-ADD will fail on those rows.
-- =============================================================================

-- 1. Restore the strict 2-key identity CHECK (drop the widened one first).
ALTER TABLE timelines DROP CONSTRAINT IF EXISTS chk_timelines_identity;
ALTER TABLE timelines ADD  CONSTRAINT chk_timelines_identity
  CHECK (contact_id IS NOT NULL OR phone_e164 IS NOT NULL);

-- 2. Drop the indexes.
DROP INDEX IF EXISTS idx_email_messages_timeline;
DROP INDEX IF EXISTS uq_timelines_yelp_convo;

-- 3. Drop the optional conversation → timeline link (guarded — the table may not
--    exist where mig 164 was never applied).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables
              WHERE table_schema = current_schema() AND table_name = 'yelp_conversations') THEN
    ALTER TABLE yelp_conversations DROP COLUMN IF EXISTS timeline_id;
  END IF;
END $$;

-- 4. Drop the additive columns.
ALTER TABLE timelines
  DROP COLUMN IF EXISTS yelp_conversation_id,
  DROP COLUMN IF EXISTS display_name,
  DROP COLUMN IF EXISTS external_source;
