-- =============================================================================
-- Migration 126: Seed Smart Slot Engine marketplace app (SLOT-ENGINE-001 Phase 2).
-- provisioning_mode='none' — Albusto proxies every engine call, so there is no
-- pushed credential. Connecting the app is a pure gate: when installed, the
-- schedule "slot recommendations" feature lights up. Setup lives on the
-- technicians settings page (where base locations are managed). Mirrors seed 116.
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
    'smart-slot-engine',
    'Smart Slot Engine',
    'Albusto',
    'scheduling',
    'internal',
    'Recommend the best arrival time-frame and technician for a new job.',
    'Rank arrival time-frames and technicians for a new job using travel distance, existing schedule, and technician base locations. Albusto sends a live snapshot to the engine and shows the top recommendations right in the dispatcher — no credentials to manage. Set each technician''s base location on the Technicians settings page to get the most accurate routing.',
    '[]'::jsonb,
    'none',
    'published',
    'support@albusto.com',
    '{
        "access_summary": ["Recommend arrival time-frames and technicians", "Read scheduled jobs and technician base locations"],
        "requires_credential_input": false,
        "setup_path": "/settings/technicians"
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
