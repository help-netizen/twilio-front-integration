-- =============================================================================
-- Migration 143: LIST-PAGINATION-001 — normalized inbound from_email index
--
-- The unified Pulse sidebar page (GET /api/calls/by-contact →
-- getUnifiedTimelinePage) resolves email → contact under "Scope A" by joining
-- inbound email_messages to contact_emails on the NORMALIZED sender address:
--     contact_emails.email_normalized = lower(trim(email_messages.from_email))
--
-- migration 079 already indexes the RAW column (idx_email_messages_company_from
-- ON email_messages(company_id, from_email)), but that index cannot serve the
-- lower(trim(...)) expression. This adds the matching functional index so the
-- email_by_contact CTE's join is index-supported for every company timeline.
--
-- Additive, idempotent (IF NOT EXISTS), and touches no data. Reversible via
-- rollback_143_list_pagination_email_from_normalized.sql.
-- =============================================================================

CREATE INDEX IF NOT EXISTS idx_email_messages_from_normalized
  ON email_messages (company_id, (lower(trim(from_email))));
