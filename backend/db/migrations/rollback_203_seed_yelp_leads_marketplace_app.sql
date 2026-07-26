-- Rollback 203: remove Yelp Leads catalog state. Installations are deleted
-- first because marketplace_installations.app_id uses ON DELETE RESTRICT.
-- Any separately minted api_integrations credential survives with its
-- marketplace links cleared by ON DELETE SET NULL.

DELETE FROM marketplace_installations
WHERE app_id = (
    SELECT id
    FROM marketplace_apps
    WHERE app_key = 'yelp-leads'
);

DELETE FROM marketplace_apps
WHERE app_key = 'yelp-leads';
