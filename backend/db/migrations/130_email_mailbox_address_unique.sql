-- =============================================================================
-- Migration 130: one Gmail address may be connected by at most ONE workspace
-- (EMAIL-001 / EMAIL-TIMELINE-001 multi-tenant ISOLATION). 079 already enforces
-- "max one Gmail mailbox per company" (uniq_email_mailbox_company_provider). This
-- adds the missing cross-tenant guard: the SAME email_address must not be
-- connectable by two different companies, or inbound push/poll → contact-timeline
-- projection could misroute one tenant's email into another tenant's workspace.
--
-- Case-insensitive on lower(email_address) to match getMailboxByEmail's
-- lower(email_address) = lower($1) resolution (Gmail addresses are case-insensitive).
-- A connectMailbox insert/upsert that lands on an address already held by a
-- DIFFERENT company now raises Postgres 23505; emailQueries.upsertMailbox catches
-- it and surfaces a 409 EMAIL_ALREADY_CONNECTED_ELSEWHERE (the existing
-- ON CONFLICT (company_id, provider) upsert still handles the SAME company
-- reconnecting — that path never trips this index).
--
-- Additive + reversible. Idempotent: IF NOT EXISTS, re-runnable by
-- apply_migrations.js (whole-file db.query). Touches nothing in 079/129.
--
-- NOTE: if the table ALREADY contains two rows with the same lower(email_address)
-- (a pre-existing duplicate from before this guard existed), the index build
-- fails — acceptable for this new feature: a single connected mailbox per address
-- is the supported state, and prod has at most one such mailbox today. Resolve any
-- duplicate (disconnect the stray) before applying, then re-run.
-- =============================================================================

CREATE UNIQUE INDEX IF NOT EXISTS uniq_email_mailboxes_address
  ON email_mailboxes (lower(email_address));
