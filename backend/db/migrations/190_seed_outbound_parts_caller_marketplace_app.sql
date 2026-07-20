-- AGENT-CALL-WINDOW-001 — dedicated marketplace app for the parts-finish caller.
-- Gate-only internal app; connecting exposes its own settings page and schedule.

INSERT INTO marketplace_apps (
    app_key, name, provider_name, category, app_type,
    short_description, long_description,
    requested_scopes, provisioning_mode, status, support_email, metadata
) VALUES (
    'outbound-parts-caller',
    'Outbound Parts Caller',
    'Albusto',
    'ai',
    'internal',
    'Sara calls customers when a part arrives and schedules the return visit.',
    'When connected, Sara automatically calls the customer after a job reaches Part arrived, offers available return-visit windows, and schedules the finish visit. Unanswered calls follow the existing retry policy. Calls are initialized only inside this app''s schedule, which inherits Company schedule unless you set a custom window here.',
    '[]'::jsonb,
    'none',
    'published',
    'support@albusto.com',
    '{
      "access_summary": ["Call customers whose parts have arrived", "Offer available finish-visit windows", "Schedule the customer-selected return visit"],
      "requires_credential_input": false,
      "setup_path": "/settings/integrations/outbound-parts-caller",
      "assistant": {
        "what_it_does": "Calls customers when ordered parts arrive, offers available return-visit windows, and schedules the finish visit.",
        "prerequisites": ["Jobs must reach the Part arrived status with a callable customer phone number"],
        "setup_steps": ["Settings → Integrations → Outbound Parts Caller → Connect", "Open Setup and choose whether its calling schedule follows Company schedule or uses a custom window"],
        "outcome": "Customers are contacted and scheduled for a return visit without a dispatcher placing each call manually.",
        "recommend_when": ["User wants automatic customer follow-up when parts arrive", "User wants the parts scheduling robot to have its own outbound calling hours"],
        "gotchas": ["The default schedule inherits Company schedule", "A call deferred by the schedule does not consume an attempt", "Inbound Telephony group hours are separate and do not control this robot"]
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
