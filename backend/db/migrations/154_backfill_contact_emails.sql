-- =============================================================================
-- Migration 154: EMAIL-UNREAD-001 — backfill contact_emails from contacts.email.
--
-- The Pulse unified list (and the mark-read email clearing) resolve a contact's
-- email threads through contact_emails. Contacts whose address lives ONLY in
-- contacts.email (Mail-Secretary-created contacts before this fix, plus any
-- legacy rows) never surface email signals in the list. Idempotent backfill:
-- every contact with a primary email gets its contact_emails row.
-- =============================================================================

INSERT INTO contact_emails (contact_id, email, email_normalized, is_primary)
SELECT c.id, lower(trim(c.email)), lower(trim(c.email)), true
FROM contacts c
WHERE c.email IS NOT NULL
  AND trim(c.email) <> ''
ON CONFLICT (contact_id, email_normalized) DO NOTHING;
