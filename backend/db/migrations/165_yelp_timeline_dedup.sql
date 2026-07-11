-- =============================================================================
-- Migration 165: yelp_timeline_dedup — YELP-TIMELINE-DEDUP-001
--
-- The unit of Yelp de-duplication is the TIMELINE, not the contact. A Yelp
-- customer conversation reaches us as N inbound emails whose relay From
-- (reply+<hex>@messaging.yelp.com) VARIES per message while the customer-facing
-- conversation is stable. Keying on the sender fabricates a junk contact +
-- timeline per message. This migration keys ONE contactless timeline off the
-- STABLE Yelp conv-id (parsed from the body), so every message of one
-- conversation collapses onto ONE timeline and NO contact is ever created.
--
-- Additive + idempotent (IF NOT EXISTS throughout); touches no existing rows.
-- The widened chk_timelines_identity stays valid for every existing row (the
-- third disjunct is purely additive). Reversible via
-- rollback_165_yelp_timeline_dedup.sql.
--
-- Migration number: max on disk = 164 (164_yelp_conversations.sql) across this
-- and every sibling worktree at build time → next free = 165.
-- =============================================================================

-- 1. Stable conv-id key on the TIMELINE + the identity/label of a contactless
--    conversation. display_name is REQUIRED (not optional): a Phase-1a Yelp lead
--    has no phone, so the existing Pulse name mechanisms (co.full_name,
--    lead-by-phone, sms.friendly_name) yield no label — display_name carries it.
ALTER TABLE timelines
  ADD COLUMN IF NOT EXISTS yelp_conversation_id TEXT,
  ADD COLUMN IF NOT EXISTS display_name         TEXT,   -- customer name from parseYelpLead; COALESCEd, never nulled
  ADD COLUMN IF NOT EXISTS external_source      TEXT;   -- 'yelp' — badge + list-leg/cleanup target

-- 2. One timeline per conv-id per company — the upsert key of resolveYelpTimeline.
--    Partial (WHERE yelp_conversation_id IS NOT NULL) so it never constrains the
--    millions of non-Yelp timelines.
CREATE UNIQUE INDEX IF NOT EXISTS uq_timelines_yelp_convo
  ON timelines(company_id, yelp_conversation_id) WHERE yelp_conversation_id IS NOT NULL;

-- 3. [BLOCKER] Relax the identity CHECK (029_revise_timelines.sql:20-21) with a
--    third disjunct, or a contactless + phoneless conv-id timeline INSERT throws.
ALTER TABLE timelines DROP CONSTRAINT IF EXISTS chk_timelines_identity;
ALTER TABLE timelines ADD  CONSTRAINT chk_timelines_identity
  CHECK (contact_id IS NOT NULL OR phone_e164 IS NOT NULL OR yelp_conversation_id IS NOT NULL);

-- 4. Pulse read-path for CONTACTLESS email: a pre-aggregated group-by on
--    timeline_id (the email_by_timeline list leg + getTimelineEmailByTimeline).
CREATE INDEX IF NOT EXISTS idx_email_messages_timeline
  ON email_messages (company_id, timeline_id, gmail_internal_at) WHERE timeline_id IS NOT NULL;

-- 5. (optional) Link the durable conversation entity to its timeline. Guarded so
--    this migration does not hard-fail where yelp_conversations (mig 164) is not
--    yet applied — the column is a nicety, not load-bearing for the feature.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables
              WHERE table_schema = current_schema() AND table_name = 'yelp_conversations') THEN
    ALTER TABLE yelp_conversations
      ADD COLUMN IF NOT EXISTS timeline_id BIGINT REFERENCES timelines(id) ON DELETE SET NULL;
  END IF;
END $$;

COMMENT ON COLUMN timelines.yelp_conversation_id IS 'YELP-TIMELINE-DEDUP-001: the STABLE Yelp conv-id (body-embedded) this timeline threads on. NOT the varying reply+<hex> relay. Unique per (company_id, yelp_conversation_id).';
COMMENT ON COLUMN timelines.display_name IS 'YELP-TIMELINE-DEDUP-001: denormalized customer name for a contactless timeline (parseYelpLead). COALESCEd on upsert so a later name-less message never nulls a good name.';
COMMENT ON COLUMN timelines.external_source IS 'YELP-TIMELINE-DEDUP-001: origin channel of a contactless timeline (''yelp'') — drives the Pulse badge + the cleanup target.';
