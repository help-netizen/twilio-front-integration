-- =============================================================================
-- Rollback 169: remove the four source-specific lead apps and restore the
-- original Lead Generator catalog copy. Also remove the corresponding
-- readMigration('169_split_lead_generator_marketplace_apps.sql') line from
-- ensureMarketplaceSchema before booting the application again.
--
-- Installations are deleted before their apps because the app FK is RESTRICT.
-- Credentials minted by other companies are not revoked or deleted: ON DELETE SET NULL
-- clears their marketplace app/installation links, leaving valid but
-- orphaned credentials that can be revoked through the integrations UI.
-- Installation event rows survive with their app and installation links null.
-- The original lead-generator installation and live api_integrations row are untouched.
-- This script also never touches rows belonging to any other marketplace app.
-- Every statement is idempotent.
-- =============================================================================

DELETE FROM marketplace_installations
WHERE app_id IN (
    SELECT id
    FROM marketplace_apps
    WHERE app_key IN ('pro-referral-leads', 'rely-leads', 'nsa-leads', 'lhg-leads')
);

DELETE FROM marketplace_apps
WHERE app_key IN ('pro-referral-leads', 'rely-leads', 'nsa-leads', 'lhg-leads');

UPDATE marketplace_apps
SET name = 'Lead Generator',
    short_description = 'Creates inbound leads from external campaigns.',
    long_description = 'Posts validated campaign leads into Blanc with source attribution.',
    updated_at = NOW()
WHERE app_key = 'lead-generator'
  AND (name IS DISTINCT FROM 'Lead Generator'
       OR short_description IS DISTINCT FROM 'Creates inbound leads from external campaigns.'
       OR long_description IS DISTINCT FROM 'Posts validated campaign leads into Blanc with source attribution.');
