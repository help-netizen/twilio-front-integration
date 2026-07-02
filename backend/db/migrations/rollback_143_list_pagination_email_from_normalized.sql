-- =============================================================================
-- Rollback 143: LIST-PAGINATION-001 — normalized inbound from_email index
-- Drops exactly what 143 added. Idempotent (IF EXISTS).
-- =============================================================================

DROP INDEX IF EXISTS idx_email_messages_from_normalized;
