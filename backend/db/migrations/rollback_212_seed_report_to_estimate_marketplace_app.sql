-- Rollback 212 removes only the Report → Estimate catalog/install state.
-- The app uses provisioning_mode='none', so there are no credentials to revoke.
-- Installation/event foreign keys clear through the marketplace schema's
-- existing ON DELETE behavior.

DELETE FROM marketplace_installations installation
USING marketplace_apps app
WHERE installation.app_id = app.id
  AND app.app_key = 'report-to-estimate';

DELETE FROM marketplace_apps
WHERE app_key = 'report-to-estimate';
