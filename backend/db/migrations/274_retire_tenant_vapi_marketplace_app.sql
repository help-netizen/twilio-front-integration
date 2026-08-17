-- VAPI-AGENCY-001 T5: the provider is an internal execution plane, not a
-- tenant-installable Marketplace app. Older seed migrations are replayed by
-- ensureMarketplaceSchema, so this retirement seed must be replayed after them.

UPDATE marketplace_apps
SET status = 'disabled',
    metadata = jsonb_set(
        COALESCE(metadata, '{}'::jsonb),
        '{assistant}',
        jsonb_build_object(
            'what_it_does', 'Legacy internal voice execution adapter; not a tenant-installable app.',
            'prerequisites', jsonb_build_array('Platform voice provisioning and an approved company rollout'),
            'setup_steps', jsonb_build_array('Platform operators provision voice resources outside the tenant Marketplace'),
            'outcome', 'The legacy provider app remains unavailable to tenants.',
            'recommend_when', jsonb_build_array('Never recommend this retired app to a tenant'),
            'gotchas', jsonb_build_array('Provider identity, credentials, assistants, and SIP resources are platform-only')
        ),
        true
    ),
    updated_at = now()
WHERE app_key = 'vapi-ai';

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM marketplace_apps
        WHERE app_key = 'vapi-ai'
          AND status = 'disabled'
    ) THEN
        RAISE EXCEPTION
            'VAPI_AGENCY_274_LEGACY_APP_REQUIRED: expected the retired vapi-ai Marketplace row';
    END IF;
END $$;
