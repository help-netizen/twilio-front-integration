-- Rollback ASSISTANT-BOT-001 metadata.assistant backfill.
-- Removes ONLY the assistant key; all other metadata is preserved. Idempotent.
UPDATE marketplace_apps
SET metadata = metadata - 'assistant', updated_at = NOW()
WHERE app_key IN (
  'lead-generator', 'pro-referral-leads', 'rely-leads', 'nsa-leads', 'lhg-leads',
  'mail-secretary', 'vapi-ai', 'stripe-payments', 'smart-slot-engine',
  'google-email', 'telephony-twilio', 'ai-repair-advisor'
);
