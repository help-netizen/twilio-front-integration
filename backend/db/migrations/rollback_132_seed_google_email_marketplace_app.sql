-- =============================================================================
-- Rollback 132: remove the Google Email marketplace app and revert
-- mail-secretary's dependency CTA back to /settings/email. Idempotent.
-- =============================================================================

DELETE FROM marketplace_apps WHERE app_key = 'google-email';

UPDATE marketplace_apps
SET metadata = jsonb_set(
        metadata,
        '{dependency_cta,path}',
        '"/settings/email"'
    ),
    updated_at = NOW()
WHERE app_key = 'mail-secretary'
  AND metadata #>> '{dependency_cta,path}' IS DISTINCT FROM '/settings/email';
