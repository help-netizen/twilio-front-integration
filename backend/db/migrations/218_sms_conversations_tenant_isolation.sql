-- Migration 218: scope active SMS conversation pairs to their owning company.
--
-- phone_number_settings.phone_number is globally unique and company_id is NOT
-- NULL (migrations 147/148), so the proxy DID is the authoritative tenant
-- binding for historical Conversations rows. Correct the conversation owner
-- where that binding exists, then align child messages before replacing the
-- legacy global active-pair unique index.

UPDATE sms_conversations conversation
SET company_id = number.company_id,
    updated_at = NOW()
FROM phone_number_settings number
WHERE conversation.proxy_e164 IS NOT NULL
  AND regexp_replace(conversation.proxy_e164, '\D', '', 'g') =
      regexp_replace(number.phone_number, '\D', '', 'g')
  AND conversation.company_id IS DISTINCT FROM number.company_id;

UPDATE sms_messages message
SET company_id = conversation.company_id,
    updated_at = NOW()
FROM sms_conversations conversation
WHERE message.conversation_id = conversation.id
  AND conversation.company_id IS NOT NULL
  AND message.company_id IS DISTINCT FROM conversation.company_id;

DROP INDEX IF EXISTS uniq_sms_active_pair;

CREATE UNIQUE INDEX IF NOT EXISTS uniq_sms_active_pair
ON sms_conversations(company_id, customer_e164, proxy_e164)
WHERE state = 'active'
  AND company_id IS NOT NULL
  AND customer_e164 IS NOT NULL
  AND proxy_e164 IS NOT NULL;
