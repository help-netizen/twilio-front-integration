-- =============================================================================
-- Migration 212: Report → Estimate marketplace app (REPORT-TO-ESTIMATE-001 T2).
--
-- The app is enabled by default for every existing company. The installation
-- deliberately does NOT persist the default instruction: the effective default
-- lives only in aiEstimateService.DEFAULT_INSTRUCTION, so unedited companies
-- automatically receive future prompt improvements.
--
-- Replay safety:
-- - the catalog row is an idempotent upsert;
-- - any installation history (including disconnected/revoked) prevents a
--   default row from being recreated, so a deliberate disconnect stays OFF;
-- - the partial-index ON CONFLICT clause protects a concurrent active insert.
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
    'report-to-estimate',
    'Report → Estimate',
    'Albusto',
    'ai',
    'internal',
    'Turn a service report into a Price Book-grounded estimate or invoice draft.',
    'Report → Estimate reads a service report and builds an unsaved draft from your company''s Price Book. It prefers service groups, keeps catalog names and prices, and puts report-specific details in line descriptions. Company administrators can edit the generation instruction in the app settings.',
    '[]'::jsonb,
    'none',
    'published',
    'support@albusto.com',
    '{
        "setup_path": "/settings/integrations/report-to-estimate",
        "access_summary": [
            "Read service report text",
            "Read Price Book groups and items",
            "Generate unsaved estimate and invoice drafts"
        ],
        "requires_credential_input": false,
        "assistant": {
            "what_it_does": "Turns a service report into an unsaved estimate or invoice draft grounded in the company Price Book, including service groups, catalog items, quantities, prices, and report-specific line descriptions.",
            "prerequisites": ["A Price Book with groups or items gives the best results"],
            "setup_steps": ["Report → Estimate is enabled automatically", "Open Settings → Integrations → Report → Estimate to review or edit the company instruction", "Use the AI draft action from an estimate or invoice report workflow"],
            "outcome": "The team gets a Price Book-grounded draft to review instead of manually rebuilding the service report as line items.",
            "recommend_when": ["User wants to turn technician or service reports into estimate drafts", "User wants AI output to reuse Price Book groups, items, and prices"],
            "gotchas": ["The generated document is an unsaved draft and still needs human review", "Disconnecting the app disables generation but preserves the company instruction for a later reconnect"]
        }
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

INSERT INTO marketplace_installations (
    company_id,
    app_id,
    status,
    installed_at,
    metadata
)
SELECT
    company.id,
    app.id,
    'connected',
    NOW(),
    '{"seeded_by":"REPORT-TO-ESTIMATE-001"}'::jsonb
FROM companies company
JOIN marketplace_apps app
  ON app.app_key = 'report-to-estimate'
WHERE NOT EXISTS (
    SELECT 1
    FROM marketplace_installations existing
    WHERE existing.company_id = company.id
      AND existing.app_id = app.id
)
ON CONFLICT (company_id, app_id)
    WHERE status IN ('connected', 'provisioning_failed')
DO NOTHING;
