-- =============================================================================
-- Migration 110: Seed Stripe Payments marketplace app (F018 / STRIPE-PAY-001).
-- provisioning_mode='none' — the dedicated setup page drives all configuration
-- (mirrors VAPI seed 088). Click on the card routes to setup_path.
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
    'stripe-payments',
    'Stripe Payments',
    'Stripe',
    'payments',
    'external',
    'Accept invoice payments, keyed card payments, and Tap to Pay in the field.',
    'Connect your company''s Stripe account to collect customer payments directly from Albusto. Send invoice payment links, let customers pay online, and reconcile every payment in your unified ledger. Tenant customer payments are kept separate from your Albusto subscription billing.',
    '[]'::jsonb,
    'none',
    'published',
    'support@albusto.com',
    '{
        "access_summary": ["Collect customer payments via Stripe", "Read invoice balance and payment status"],
        "requires_credential_input": false,
        "setup_path": "/settings/integrations/stripe-payments",
        "integration_type": "tenant_customer_payments"
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
