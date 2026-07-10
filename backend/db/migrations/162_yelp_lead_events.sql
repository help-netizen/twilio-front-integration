-- =============================================================================
-- Migration 162: yelp_lead_events — the idempotency ledger for
-- YELP-LEAD-AUTORESPONDER-001 (Phase 1a, TASK-YLA-001).
--
-- One row per Yelp *new-lead* email the autoresponder claims. The row is the
-- releasable lock that guarantees **lead at-least-once, greeting at-most-once**:
--   • claimYelpLead()  INSERTs with ON CONFLICT (company_id, provider_message_id)
--                      DO NOTHING RETURNING id — the UNIQUE constraint (NOT app
--                      logic) is what makes a re-ingested push/poll a no-op.
--   • releaseClaim()   DELETEs the row ONLY when createLead throws, so the next
--                      poll re-scan re-attempts the lead.
--   • markGreeted()    stamps greeted_at + lead_id + thread_token after a
--                      best-effort greeting send (held, never released).
--   • threadAlreadyGreeted()  reads greeted rows by (company_id, thread_token)
--                      as a defense-in-depth one-reply-per-thread guard.
--
-- Company-scoped: uniqueness is per company_id (Phase 1a is single default
-- mailbox, but the key is tenant-safe for 1b multi-mailbox onboarding).
--
-- Additive, idempotent (IF NOT EXISTS), touches no existing data. Reversible via
-- rollback_162_yelp_lead_events.sql (DROP TABLE IF EXISTS).
-- Migration number: 161 was claimed by a parallel worktree at build time, so this
-- is 162 (next free integer).
-- =============================================================================

CREATE TABLE IF NOT EXISTS yelp_lead_events (
    id                            BIGSERIAL   PRIMARY KEY,
    company_id                    UUID        NOT NULL,
    provider_message_id           TEXT        NOT NULL,
    thread_token                  TEXT,
    lead_id                       BIGINT,
    greeting_provider_message_id  TEXT,
    status                        TEXT,
    greeted_at                    TIMESTAMPTZ,
    created_at                    TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (company_id, provider_message_id)
);

-- Defense-in-depth one-reply-per-thread lookup (threadAlreadyGreeted): find a
-- greeted row for a company's thread token. Partial — only greeted rows matter.
CREATE INDEX IF NOT EXISTS idx_yelp_lead_events_thread_greeted
    ON yelp_lead_events (company_id, thread_token)
    WHERE thread_token IS NOT NULL AND greeted_at IS NOT NULL;

COMMENT ON TABLE yelp_lead_events IS 'YELP-LEAD-AUTORESPONDER-001: idempotency ledger. UNIQUE(company_id, provider_message_id) = the claim lock (lead at-least-once, greeting at-most-once).';
COMMENT ON COLUMN yelp_lead_events.provider_message_id IS 'Gmail provider_message_id of the inbound Yelp new-lead email; the claim key.';
COMMENT ON COLUMN yelp_lead_events.thread_token IS 'Hex token from the reply+<hex>@messaging.yelp.com relay; written at markGreeted for one-reply-per-thread checks.';
COMMENT ON COLUMN yelp_lead_events.status IS 'claimed | greeted | handled_no_send (service-managed).';
