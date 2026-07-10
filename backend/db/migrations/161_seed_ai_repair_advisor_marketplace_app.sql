-- =============================================================================
-- Migration 161: Seed AI Repair Advisor marketplace app (REPAIR-ADVISOR-001).
-- provisioning_mode='none' — Albusto proxies every knowledge-base call, so there
-- is no pushed credential. Connecting the app is a pure gate: when installed,
-- new human-created jobs get an auto-drafted diagnostic starting-point note from
-- the service-manual knowledge base. No setup page (pure gate). Mirrors seed 126.
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
    'ai-repair-advisor',
    'AI Repair Advisor',
    'Albusto',
    'operations',
    'internal',
    'Auto-draft a diagnostic starting point on every new job from the service-manual knowledge base.',
    'When connected, AI Repair Advisor reads each newly created job''s reported problem and appliance details, queries Albusto''s service-manual knowledge base, and appends a single diagnostic note — probable causes, diagnosis steps, and how to enter the unit''s diagnostic mode — so technicians arrive with a head start. It runs automatically in the background on new jobs; there is nothing to configure and no credentials to manage.',
    '[]'::jsonb,
    'none',
    'published',
    'support@albusto.com',
    '{
        "access_summary": ["Draft a diagnostic starting-point note on new jobs", "Read new job details (reported problem, appliance brand and model)"],
        "requires_credential_input": false
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
