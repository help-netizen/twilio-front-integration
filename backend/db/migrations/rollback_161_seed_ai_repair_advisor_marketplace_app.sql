-- =============================================================================
-- Rollback 161: remove the "AI Repair Advisor" marketplace app tile.
-- Idempotent (no-op if already absent). marketplace_installation_events.app_id
-- and api_integrations.marketplace_app_id are ON DELETE SET NULL, so those
-- references clear cleanly. marketplace_installations.app_id is ON DELETE
-- RESTRICT — this rollback presumes the app has been disconnected first (no
-- active installation rows), which holds for the seed-smoke scenario (TC-RA-072).
-- =============================================================================

DELETE FROM marketplace_apps WHERE app_key = 'ai-repair-advisor';
