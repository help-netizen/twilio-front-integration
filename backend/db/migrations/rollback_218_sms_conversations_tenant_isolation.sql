-- Rollback 218: restore the legacy global active-pair uniqueness rule.
--
-- This intentionally does not reverse company_id corrections: the prior owner
-- values are not recoverable, and restoring a known-wrong tenant attribution
-- would reintroduce a data leak. The global index recreation fails closed if
-- different companies have since created the same active pair.

DROP INDEX IF EXISTS uniq_sms_active_pair;

CREATE UNIQUE INDEX IF NOT EXISTS uniq_sms_active_pair
ON sms_conversations(customer_e164, proxy_e164)
WHERE state = 'active'
  AND customer_e164 IS NOT NULL
  AND proxy_e164 IS NOT NULL;
