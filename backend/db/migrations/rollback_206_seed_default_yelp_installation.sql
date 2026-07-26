-- Rollback 206 removes only the default-company Yelp installation owned by
-- LEAD-INSTALL-GATE-001. The shared api_integrations credential and Yelp app
-- catalog row remain untouched.

DELETE FROM marketplace_installations installation
USING marketplace_apps app
WHERE installation.app_id = app.id
  AND app.app_key = 'yelp-leads'
  AND installation.company_id = '00000000-0000-0000-0000-000000000001'::uuid
  AND installation.api_integration_id = 1
  AND installation.metadata @> '{"seeded_by":"YELP-INSTALL-001","shared_credential":true}'::jsonb;
