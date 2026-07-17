-- =============================================================================
-- Migration 087: Seed Mail Secretary marketplace module.
-- =============================================================================

INSERT INTO marketplace_apps (
    app_key,
    name,
    provider_name,
    category,
    app_type,
    short_description,
    long_description,
    requested_scopes,
    provisioning_mode,
    status,
    support_email,
    privacy_url,
    docs_url,
    metadata
) VALUES (
    'mail-secretary',
    'Mail Secretary',
    'Blanc Labs',
    'ai',
    'internal',
    'Surfaces only emails that need attention or action.',
    'Mail Secretary analyzes the connected Gmail mailbox through Blanc-controlled pipelines. It stores Gmail message references and derived triage results, not raw email bodies.',
    '["email:read"]'::jsonb,
    'none',
    'published',
    'support@blanc.local',
    'https://blanc.local/privacy',
    '/settings/api-docs',
    '{
        "access_summary": ["Read connected Gmail mailbox metadata and message content for triage"],
        "requires_connected_gmail": true,
        "dependency_cta": {
            "label": "Connect Gmail",
            "path": "/settings/email"
        },
        "data_retention": {
            "stores_raw_email": false,
            "persistent_reference": "Gmail message id and thread id",
            "stores_derived_results": true
        },
        "pipeline_phase": "fetch_gmail_message"
    }'::jsonb
)
ON CONFLICT (app_key) DO UPDATE SET
    name = EXCLUDED.name,
    provider_name = EXCLUDED.provider_name,
    category = EXCLUDED.category,
    app_type = EXCLUDED.app_type,
    short_description = EXCLUDED.short_description,
    long_description = EXCLUDED.long_description,
    requested_scopes = EXCLUDED.requested_scopes,
    provisioning_mode = EXCLUDED.provisioning_mode,
    status = EXCLUDED.status,
    support_email = EXCLUDED.support_email,
    privacy_url = EXCLUDED.privacy_url,
    docs_url = EXCLUDED.docs_url,
    metadata = EXCLUDED.metadata,
    updated_at = NOW();
