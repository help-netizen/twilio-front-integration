-- =============================================================================
-- Rollback 130: drop the cross-tenant unique address index added by
-- 130_email_mailbox_address_unique.sql. Idempotent (IF EXISTS). Leaves 079's
-- uniq_email_mailbox_company_provider (one mailbox per company) intact.
-- =============================================================================

DROP INDEX IF EXISTS uniq_email_mailboxes_address;
