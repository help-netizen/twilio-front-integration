-- =============================================================================
-- Migration 176: Seed the "Outbound Lead Caller" marketplace app
-- (OUTBOUND-LEAD-CALL-001). provisioning_mode='none' — pure gate (VAPI config is
-- server-env); connecting enables the lead.created auto-call trigger. Registered
-- in ensureMarketplaceSchema AFTER the 170 line (boot-reseed; 083's ON CONFLICT
-- DO UPDATE ordering rule). NO installation seed — connect is an owner action.
-- (Spec drafted this as 173; renumbered with the DDL shift → seed is now 176.)
-- =============================================================================

INSERT INTO marketplace_apps (
    app_key, name, provider_name, category, app_type,
    short_description, long_description,
    requested_scopes, provisioning_mode, status, support_email, metadata
) VALUES (
    'outbound-lead-caller',
    'Outbound Lead Caller',
    'Albusto',
    -- category 'ai' (VAPI AI / Repair Advisor precedent): this app CONSUMES
    -- leads, it is not a lead SOURCE — and the leadgen real-DB suite pins the
    -- lead_generation set to exactly the five per-source apps.
    'ai',
    'internal',
    'Sara calls new leads from your chosen sources within a minute and books them into the schedule.',
    'When connected, every new lead from an enabled source (for example Pro Referral) gets an automatic phone call from Sara, the AI scheduling assistant — immediately during business hours, or at the next business-day start. Sara references the customer''s request, offers real appointment windows ranked by the scheduling engine, and books the customer''s pick as a schedule hold on the lead. Unanswered calls retry up to three times; if the customer can''t be reached or declines, a dispatcher task is created on the lead. Every call appears live in the Pulse timeline with recording, transcript, and summary.',
    '[]'::jsonb,
    'none',
    'published',
    'support@albusto.com',
    '{
        "access_summary": ["Call new leads from enabled sources and offer appointment windows", "Write a schedule hold on the lead when the customer books", "Create a dispatcher task when the lead can''t be reached"],
        "requires_credential_input": false,
        "setup_path": "/settings/integrations/outbound-lead-caller"
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
