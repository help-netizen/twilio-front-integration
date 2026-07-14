-- OUTBOUND-LEAD-CALL-001 rollback: remove the catalog tile (idempotent).
-- Presumes the app is disconnected first; marketplace_installations.app_id is ON DELETE RESTRICT.
DELETE FROM marketplace_apps WHERE app_key = 'outbound-lead-caller';
