-- =============================================================================
-- Migration 169: Split the Lead Generator catalog into per-source lead apps.
-- The source-specific names and descriptions are draft marketplace copy.
-- =============================================================================

UPDATE marketplace_apps
SET name = 'Website Leads',
    short_description = 'Creates inbound leads from your company website.',
    long_description = 'Posts orders and form submissions from your company website into Albusto as leads with source attribution.',
    updated_at = NOW()
WHERE app_key = 'lead-generator'
  AND (name IS DISTINCT FROM 'Website Leads'
       OR short_description IS DISTINCT FROM 'Creates inbound leads from your company website.'
       OR long_description IS DISTINCT FROM 'Posts orders and form submissions from your company website into Albusto as leads with source attribution.');

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
    docs_url,
    metadata
) VALUES
(
    'pro-referral-leads',
    'Pro Referral Leads',
    'Albusto',
    'lead_generation',
    'internal',
    'Creates inbound leads from Pro Referral.',
    'Posts Pro Referral leads into Albusto with source attribution.',
    '["leads:create"]'::jsonb,
    'manual',
    'published',
    'support@albusto.com',
    '/settings/api-docs',
    '{"access_summary":["Create leads"]}'::jsonb
),
(
    'rely-leads',
    'Rely Leads',
    'Albusto',
    'lead_generation',
    'internal',
    'Creates inbound leads from Rely.',
    'Posts Rely leads into Albusto with source attribution.',
    '["leads:create"]'::jsonb,
    'manual',
    'published',
    'support@albusto.com',
    '/settings/api-docs',
    '{"access_summary":["Create leads"]}'::jsonb
),
(
    'nsa-leads',
    'NSA Leads',
    'Albusto',
    'lead_generation',
    'internal',
    'Creates inbound leads from NSA.',
    'Posts NSA leads into Albusto with source attribution.',
    '["leads:create"]'::jsonb,
    'manual',
    'published',
    'support@albusto.com',
    '/settings/api-docs',
    '{"access_summary":["Create leads"]}'::jsonb
),
(
    'lhg-leads',
    'LHG Leads',
    'Albusto',
    'lead_generation',
    'internal',
    'Creates inbound leads from LHG.',
    'Posts LHG leads into Albusto with source attribution.',
    '["leads:create"]'::jsonb,
    'manual',
    'published',
    'support@albusto.com',
    '/settings/api-docs',
    '{"access_summary":["Create leads"]}'::jsonb
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
    docs_url = EXCLUDED.docs_url,
    metadata = EXCLUDED.metadata,
    updated_at = NOW();

INSERT INTO marketplace_installations
    (company_id, app_id, api_integration_id, status, installed_at, metadata)
SELECT
    '00000000-0000-0000-0000-000000000001'::uuid,
    a.id,
    src.api_integration_id,
    'connected',
    NOW(),
    '{"seeded_by":"MARKETPLACE-LEADGEN-SPLIT-001","shared_credential":true}'::jsonb
FROM marketplace_apps a
CROSS JOIN LATERAL (
    SELECT mi.api_integration_id
    FROM marketplace_installations mi
    JOIN marketplace_apps lg ON lg.id = mi.app_id AND lg.app_key = 'lead-generator'
    WHERE mi.company_id = '00000000-0000-0000-0000-000000000001'::uuid
      AND mi.status = 'connected'
      AND mi.api_integration_id IS NOT NULL
    ORDER BY mi.created_at DESC
    LIMIT 1
) src
WHERE a.app_key IN ('pro-referral-leads', 'rely-leads', 'nsa-leads', 'lhg-leads')
  AND NOT EXISTS (
      SELECT 1 FROM marketplace_installations existing
      WHERE existing.company_id = '00000000-0000-0000-0000-000000000001'::uuid
        AND existing.app_id = a.id
  );
