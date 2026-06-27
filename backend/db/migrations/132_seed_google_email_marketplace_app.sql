-- =============================================================================
-- Migration 132: Seed Google Email marketplace app (SEND-DOC-001 PART B).
-- provisioning_mode='none' — there is NO install row. The app's connected state
-- derives from the real Gmail mailbox (emailMailboxService), and its lifecycle
-- IS the OAuth connect/disconnect. Clicking the card routes to setup_path.
-- Mirrors seeds 088 (vapi-ai) / 116 (stripe-payments) / 126 (smart-slot-engine).
--
-- Also repoints mail-secretary's dependency CTA (FR-B6) from the retired
-- /settings/email page to the new Google Email marketplace setup path.
-- Idempotent: ON CONFLICT upsert + jsonb_set UPDATE are both safe to re-run.
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
    'google-email',
    'Google Email',
    'Albusto',
    'communication',
    'internal',
    'Connect your Google/Gmail account to send & receive email in Albusto.',
    'Connect your company''s Google/Gmail account to send and receive email directly from Albusto. Once connected, email send is enabled across the app and incoming replies thread onto the contact timeline. Connecting and disconnecting is handled by Google sign-in — there are no credentials to manage.',
    '["email:send", "email:read"]'::jsonb,
    'none',
    'published',
    'support@albusto.com',
    '{
        "access_summary": ["Send email from the connected Gmail mailbox", "Read incoming Gmail messages for the timeline"],
        "requires_credential_input": false,
        "setup_path": "/settings/integrations/google-email",
        "manages_gmail_connection": true
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

-- FR-B6: repoint mail-secretary's "Connect Gmail" CTA from the retired
-- /settings/email page to the Google Email marketplace setup path. Keeps the
-- existing label ("Connect Gmail"); only the path changes. jsonb_set is a no-op
-- on re-run once the path already matches.
UPDATE marketplace_apps
SET metadata = jsonb_set(
        metadata,
        '{dependency_cta,path}',
        '"/settings/integrations/google-email"'
    ),
    updated_at = NOW()
WHERE app_key = 'mail-secretary'
  AND metadata #>> '{dependency_cta,path}' IS DISTINCT FROM '/settings/integrations/google-email';
