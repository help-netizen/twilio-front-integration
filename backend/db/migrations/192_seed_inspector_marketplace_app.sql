-- INSPECTOR-AGENT-001: gate-only internal Marketplace app.

INSERT INTO marketplace_apps (
    app_key, name, provider_name, category, app_type,
    short_description, long_description,
    requested_scopes, provisioning_mode, status, support_email, metadata
) VALUES (
    'inspector',
    'Inspector',
    'Albusto',
    'ai',
    'internal',
    'Reviews stalled jobs and leads and creates focused dispatcher follow-up tasks.',
    'Inspector runs once each company-local day after noon. It reviews eligible Jobs and Leads, active notes, recent communications, workflow activity, estimates, invoices, and payments. When follow-up is warranted, it creates one unassigned task on the source record. Inspector never contacts customers or changes business records.',
    '["jobs:read", "leads:read", "notes:read", "communications:read", "finance:read", "tasks:create"]'::JSONB,
    'none',
    'published',
    'support@albusto.com',
    '{
      "access_summary": ["Read eligible Jobs and Leads", "Review notes, recent communications, and financial summaries", "Create unassigned follow-up tasks"],
      "requires_credential_input": false,
      "setup_path": "/settings/integrations?tab=marketplace&app=inspector",
      "assistant": {
        "what_it_does": "Reviews past-dated Jobs and inactive Leads once daily and creates a focused dispatcher task when the supplied operational, communication, and finance evidence shows follow-up is needed.",
        "prerequisites": ["Published Job and Lead workflows", "A company timezone", "Gemini provider access configured by the Albusto deployment"],
        "setup_steps": ["Settings → Integrations → Marketplace → Inspector → Connect", "Open Setup to choose ignored Job and Lead statuses and review the agent instruction", "Save settings; Inspector runs after noon in the company timezone"],
        "outcome": "Dispatchers receive one deduplicated, unassigned task on each stalled Job or Lead that needs action.",
        "recommend_when": ["User wants daily follow-up checks for stalled Jobs or Leads", "User wants operational notes cross-checked against estimates, invoices, and payments", "User wants legitimate future holds respected instead of repeatedly flagged"],
        "gotchas": ["Inspector is advisory and never contacts customers or changes statuses", "An existing open Inspector task suppresses another task, including after its due date is snoozed", "Records without an existing contact timeline appear in Tasks and on the entity but not Pulse Action Required"]
      }
    }'::JSONB
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
