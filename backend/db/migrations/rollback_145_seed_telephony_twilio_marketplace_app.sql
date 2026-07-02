-- =============================================================================
-- Rollback 145: remove the "Telephony — Twilio" marketplace app tile.
-- FK-safe by construction: the app is derived-connection — installApp rejects
-- it with 409 DERIVED_CONNECTION_APP, so marketplace_installations rows for it
-- never exist (marketplace_installation_events.app_id is ON DELETE SET NULL).
-- Idempotent.
-- =============================================================================

DELETE FROM marketplace_apps WHERE app_key = 'telephony-twilio';
