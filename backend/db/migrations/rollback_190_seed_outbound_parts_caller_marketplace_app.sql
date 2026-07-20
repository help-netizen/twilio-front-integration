-- Rollback AGENT-CALL-WINDOW-001 parts-caller marketplace catalog seed.
-- marketplace_installations.app_id is ON DELETE RESTRICT, so operational
-- rollback must remove this app's installation rows first.
DELETE FROM marketplace_apps WHERE app_key = 'outbound-parts-caller';
