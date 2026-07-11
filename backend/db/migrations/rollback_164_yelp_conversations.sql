-- =============================================================================
-- Rollback migration 164 — YELP-CONVO-BOOKING-001 yelp_conversations.
-- Drops the durable conversation table + the linking column on the claim ledger.
-- Idempotent (DROP … IF EXISTS); leaves no orphaned index/constraint/enum. The
-- UNIQUE(company_id, conversation_id) index is dropped with the table. Re-applying
-- the forward migration afterwards succeeds (its guards are IF NOT EXISTS).
-- =============================================================================

DROP TABLE IF EXISTS yelp_conversations;

ALTER TABLE yelp_lead_events
    DROP COLUMN IF EXISTS conversation_id;
