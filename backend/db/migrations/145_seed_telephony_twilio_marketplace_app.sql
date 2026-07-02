-- =============================================================================
-- Migration 145: Seed "Telephony — Twilio" marketplace app (ONBTEL-001 Part B).
-- provisioning_mode='none' — connect is the internal subaccount flow
-- (telephonyTenantService); no api_integrations key is ever issued.
-- metadata.derived_connection=true — the connected state is DERIVED from
-- company_telephony (marketplace_installations rows are NEVER created for this
-- app; installApp rejects it with 409 DERIVED_CONNECTION_APP). Clicking the
-- card routes to metadata.setup_path (the 3-step wizard).
-- Mirrors seeds 088 (vapi-ai) / 116 (stripe-payments) / 132 (google-email).
-- Idempotent: ON CONFLICT (app_key) DO UPDATE.
-- =============================================================================

INSERT INTO marketplace_apps (
    app_key,
    name,
    provider_name,
    category,
    app_type,
    short_description,
    requested_scopes,
    provisioning_mode,
    status,
    metadata
) VALUES (
    'telephony-twilio',
    'Telephony — Twilio',
    'Albusto',
    'telephony',
    'internal',
    'Business phone numbers, calls and texts for your company — powered by Twilio.',
    '[]'::jsonb,
    'none',
    'published',
    '{"setup_path":"/settings/integrations/telephony-twilio","derived_connection":true,"access_summary":["Buy and manage phone numbers","Route inbound calls and SMS"]}'::jsonb
)
ON CONFLICT (app_key) DO UPDATE SET
    name = EXCLUDED.name,
    provider_name = EXCLUDED.provider_name,
    category = EXCLUDED.category,
    app_type = EXCLUDED.app_type,
    short_description = EXCLUDED.short_description,
    requested_scopes = EXCLUDED.requested_scopes,
    provisioning_mode = EXCLUDED.provisioning_mode,
    status = EXCLUDED.status,
    metadata = EXCLUDED.metadata,
    updated_at = NOW();
