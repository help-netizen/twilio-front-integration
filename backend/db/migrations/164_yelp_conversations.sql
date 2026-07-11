-- =============================================================================
-- Migration 164: yelp_conversations — durable multi-turn state for
-- YELP-CONVO-BOOKING-001 (Phase A, T-YCB-A3).
--
-- One row per Yelp conversation, keyed by the STABLE conv-id parsed from the
-- message BODY (message_to_business_conversation/<id> on the first email,
-- %2Fthread%2F<id> on replies) — NOT the per-message-varying
-- reply+<hex>@messaging.yelp.com relay address (that address is stored per-turn as
-- last_reply_to = where THIS turn's reply is sent, and threads NOTHING).
--
--   • UNIQUE (company_id, conversation_id) is the threading invariant: every turn
--     of a dialog (first message + N replies, each arriving from a different relay
--     hex) collapses to ONE row via upsertConversation's ON CONFLICT.
--   • phase / status are the coarse guardrail + terminal outcome; the Phase-B LLM
--     brain re-reads collected + history each turn (this migration is plumbing only).
--   • offered_slots is the ONLY valid book target set (server-side book-guard basis);
--     chosen_slot is the double-book guard.
--
-- Also links the per-inbound claim ledger to the conversation:
--   ALTER yelp_lead_events ADD conversation_id — the claim row (mig 162) written by
--   the reused claimYelpLead() can now be associated with its conversation. The
--   status vocabulary additionally tolerates 'replied' (the post-send marker); no
--   CHECK/enum change is needed because yelp_lead_events.status is a free-text column.
--
-- Company-scoped: every yelpConversationQueries.* query filters company_id.
-- Additive, idempotent (IF NOT EXISTS), touches no existing rows. Reversible via
-- rollback_164_yelp_conversations.sql.
--
-- Migration number: max on disk = 163 (163_tasks_agent_retry.sql) across this and
-- every sibling worktree at build time → next free = 164.
-- =============================================================================

CREATE TABLE IF NOT EXISTS yelp_conversations (
    id                        BIGSERIAL   PRIMARY KEY,
    company_id                UUID        NOT NULL,
    conversation_id           TEXT        NOT NULL,
    lead_id                   BIGINT,
    lead_uuid                 UUID,
    phase                     TEXT        NOT NULL DEFAULT 'greet',
    status                    TEXT        NOT NULL DEFAULT 'open',
    collected                 JSONB       NOT NULL DEFAULT '{}'::jsonb,
    offered_slots             JSONB,
    chosen_slot               JSONB,
    last_reply_to             TEXT,
    last_thread_token         TEXT,
    turn_count                INTEGER     NOT NULL DEFAULT 0,
    last_inbound_message_id   TEXT,
    reply_sent_at             TIMESTAMPTZ,
    slot_held_at              TIMESTAMPTZ,
    created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (company_id, conversation_id)
);

-- Link the per-inbound claim ledger (mig 162) to its conversation. Additive column;
-- claimYelpLead() is reused as-is (writes NULL here in Phase A), and markReplied()
-- stamps status='replied' post-send.
ALTER TABLE yelp_lead_events
    ADD COLUMN IF NOT EXISTS conversation_id TEXT;

COMMENT ON TABLE yelp_conversations IS 'YELP-CONVO-BOOKING-001: durable per-conversation state, keyed UNIQUE(company_id, conversation_id) on the STABLE Yelp conv-id (body-embedded), not the varying reply+<hex> relay.';
COMMENT ON COLUMN yelp_conversations.conversation_id IS 'Stable Yelp conv-id parsed from the message body (message_to_business_conversation/<id> or %2Fthread%2F<id>). The threading key.';
COMMENT ON COLUMN yelp_conversations.last_reply_to IS 'Freshest reply+<hex>@messaging.yelp.com from the latest inbound — where THIS turn''s reply is sent. Per-turn only; never the thread key.';
COMMENT ON COLUMN yelp_conversations.offered_slots IS 'Last offer [{key,date,start,end,label}] — the ONLY valid book targets (server book-guard: slotKey ∈ offered_slots).';
COMMENT ON COLUMN yelp_conversations.chosen_slot IS 'Accepted slot; the double-book guard (status=book AND unchanged chosen_slot → skip re-hold).';
COMMENT ON COLUMN yelp_conversations.phase IS 'greet | collect | offer_slot | await_pick | booked | handoff_call | stalled (coarse guardrail).';
COMMENT ON COLUMN yelp_conversations.status IS 'open | book | call | closed (terminal outcome).';
COMMENT ON COLUMN yelp_lead_events.conversation_id IS 'YELP-CONVO-BOOKING-001: links a per-inbound claim (mig 162) to its yelp_conversations row.';
