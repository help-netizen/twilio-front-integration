-- Rollback 166 — revert yelp_conversations.lead_uuid to UUID.
-- WARNING: this FAILS if any row holds a short-code lead_uuid (which is the norm
-- for real Yelp leads, e.g. "72JR1E") — reverting is only safe on an empty table.
-- Provided for symmetry; in practice you do NOT want to go back to UUID.
ALTER TABLE yelp_conversations
    ALTER COLUMN lead_uuid TYPE uuid USING lead_uuid::uuid;
