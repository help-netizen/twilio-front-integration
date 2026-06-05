-- =============================================================================
-- Migration 088: Seed VAPI AI marketplace module.
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
    metadata
) VALUES (
    'vapi-ai',
    'VAPI AI',
    'Blanc Labs',
    'telephony',
    'internal',
    'Route inbound calls to an AI voice agent powered by VAPI.',
    'VAPI AI enables AI-powered voice agents on your inbound call flows. Once connected, a VAPI AI node becomes available in the Call Flow Builder — route calls to it for automated greetings, intake, and qualification before transferring to a human agent.',
    '["calls:read"]'::jsonb,
    'none',
    'published',
    'support@blanc.local',
    '{
        "access_summary": ["Handle inbound calls via AI voice agent", "Read call metadata and routing context"],
        "requires_credential_input": true,
        "setup_path": "/settings/integrations/vapi-ai",
        "call_flow_node": "vapi_agent"
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
    metadata = EXCLUDED.metadata,
    updated_at = NOW();
