-- =============================================================================
-- Rollback 150: drop the device_tokens table (its UNIQUE constraint and the
-- (company_id, crm_user_id) index are dropped implicitly with the table) created
-- by migration 150.
--
-- device_tokens rows are ephemeral APNs registrations, not source-of-truth data:
-- the native client re-registers on the next cold-start (POST /api/devices), so
-- dropping the table only means pushes stop until the table (and clients) are
-- back. pushService fails soft when APNs env / the table are absent — the primary
-- reassign/reschedule paths are unaffected. Idempotent (IF EXISTS).
-- =============================================================================

DROP TABLE IF EXISTS device_tokens;
