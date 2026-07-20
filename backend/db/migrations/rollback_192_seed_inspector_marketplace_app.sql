-- Rollback INSPECTOR-AGENT-001 Marketplace seed. Safe to run repeatedly.

DELETE FROM marketplace_installations
WHERE app_id = (SELECT id FROM marketplace_apps WHERE app_key = 'inspector');

DELETE FROM marketplace_apps WHERE app_key = 'inspector';
