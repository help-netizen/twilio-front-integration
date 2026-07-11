-- =============================================================================
-- 166_yelp_conversations_lead_uuid_text.sql
-- YELP-CONVO-BOOKING-001 hotfix — yelp_conversations.lead_uuid must be TEXT.
-- =============================================================================
-- Migration 164 declared `yelp_conversations.lead_uuid` as type UUID. But a
-- lead's "uuid" (leads.uuid / lead.UUID) is a SHORT CODE (e.g. "72JR1E"), NOT a
-- Postgres uuid. So the first real Yelp lead made upsertConversation throw
--   invalid input syntax for type uuid: "72JR1E"
-- which yelpLeadService swallows as best-effort → the yelp_conversations row was
-- never created → the turn-0 greeting handler skipped 'no_conversation' → the
-- customer never received the conversational greeting. (Latent since CONVO was
-- dark-launched; surfaced on the first live lead 2026-07-11.)
--
-- Applied as a prod hotfix 2026-07-11 while the table was empty; this codifies it
-- for every environment. Idempotent: re-running against an already-TEXT column is
-- a no-op. Safe on data: any existing short-code value casts cleanly to text.
-- =============================================================================

ALTER TABLE yelp_conversations
    ALTER COLUMN lead_uuid TYPE text USING lead_uuid::text;
