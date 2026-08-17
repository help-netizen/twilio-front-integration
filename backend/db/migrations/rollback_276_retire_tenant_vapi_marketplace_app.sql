-- Rollback 276 republishes only the legacy catalog row. It does not restore the
-- deleted tenant management routes, frontend page, or provider credentials.

UPDATE marketplace_apps
SET status = 'published',
    metadata = jsonb_set(
        COALESCE(metadata, '{}'::jsonb),
        '{assistant}',
        jsonb_build_object(
            'what_it_does', 'Provides the legacy AI receptionist Marketplace entry.',
            'prerequisites', jsonb_build_array('A platform-provisioned voice configuration'),
            'setup_steps', jsonb_build_array('Contact platform support for voice provisioning'),
            'outcome', 'The legacy AI receptionist catalog entry is published.',
            'recommend_when', jsonb_build_array('A tenant asks about the legacy AI receptionist'),
            'gotchas', jsonb_build_array('Provider resources remain platform-managed')
        ),
        true
    ),
    updated_at = now()
WHERE app_key = 'vapi-ai';
