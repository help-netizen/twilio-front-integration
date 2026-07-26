-- YELP-LEADS-001: publish the Yelp Leads catalog tile.
--
-- Like the five existing lead-generation apps, installation state is
-- informational in v1: the existing Yelp env flags remain the runtime source
-- of truth. This seed creates no installation and no credential.

INSERT INTO marketplace_apps (
    app_key,
    name,
    provider_name,
    category,
    app_type,
    short_description,
    long_description,
    logo_url,
    requested_scopes,
    provisioning_mode,
    status,
    support_email,
    docs_url,
    metadata
) VALUES (
    'yelp-leads',
    'Yelp Leads',
    'Albusto',
    'lead_generation',
    'internal',
    'Creates and responds to inbound leads from Yelp.',
    'Turns Yelp quote requests into Albusto leads and follows up through the customer''s Yelp conversation.',
    NULL,
    '["leads:create"]'::jsonb,
    'manual',
    'published',
    'support@albusto.com',
    '/settings/api-docs',
    '{
      "access_summary": ["Create leads"],
      "assistant": {
        "what_it_does": "Turns inbound Yelp quote requests into Albusto leads and sends a concise first reply in the Yelp conversation, offering the earliest available service window when a usable ZIP and scheduling capacity are available.",
        "prerequisites": ["Yelp quote-request emails are delivered to the company''s connected Google mailbox", "Yelp lead automation is enabled for the company''s controlled rollout", "Smart Slot Engine is connected for early appointment offers"],
        "setup_steps": ["Connect Google Email in Settings → Integrations", "Confirm Yelp quote-request emails arrive in that mailbox", "Ask Albusto support to enable Yelp lead automation for the company"],
        "outcome": "New Yelp requests become attributed CRM leads and receive a prompt professional response; eligible requests can receive an earliest-slot offer immediately.",
        "recommend_when": ["The company receives service quote requests through Yelp", "The team wants faster first response on Yelp leads", "The team wants Yelp inquiries captured as CRM leads"],
        "gotchas": ["Marketplace connection state is informational in v1; the controlled rollout flag remains the runtime source of truth", "Early slot offers require a valid ZIP, in-area territory, and available Smart Slot Engine recommendations", "If scheduling is unavailable, the reply asks for a phone number and service address instead of inventing a window"]
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
    logo_url = EXCLUDED.logo_url,
    requested_scopes = EXCLUDED.requested_scopes,
    provisioning_mode = EXCLUDED.provisioning_mode,
    status = EXCLUDED.status,
    support_email = EXCLUDED.support_email,
    docs_url = EXCLUDED.docs_url,
    metadata = EXCLUDED.metadata,
    updated_at = NOW();
