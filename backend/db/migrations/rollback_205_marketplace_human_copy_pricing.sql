-- Rollback 205: remove the pricing layer introduced by the authoritative copy
-- migration. Display copy is deliberately retained: reverting user-facing text
-- to stale seed wording would recreate the replay bug this migration fixes.

UPDATE marketplace_apps
SET metadata = COALESCE(metadata, '{}'::jsonb) - 'pricing',
    updated_at = NOW()
WHERE app_key IN (
    'chatgpt-crm-mcp',
    'lead-generator',
    'yelp-leads',
    'pro-referral-leads',
    'rely-leads',
    'nsa-leads',
    'lhg-leads',
    'mail-secretary',
    'vapi-ai',
    'stripe-payments',
    'smart-slot-engine',
    'google-email',
    'telephony-twilio',
    'ai-repair-advisor',
    'outbound-lead-caller',
    'outbound-parts-caller',
    'inspector',
    'call-qa-agent',
    'rate-me'
);
