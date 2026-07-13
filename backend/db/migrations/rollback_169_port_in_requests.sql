-- =============================================================================
-- Rollback migration 169 — TELEPHONY-WIZARD-UX-001 Twilio Port-In requests.
-- Both indexes are dropped with the table. Idempotent for rollback tooling.
-- =============================================================================

DROP TABLE IF EXISTS port_in_requests;
