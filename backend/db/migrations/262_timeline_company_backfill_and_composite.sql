-- =============================================================================
-- TENANT-ISO-002, stage 2a: make timeline ownership explicit and add the
-- tenant-aware orphan-phone uniqueness contract. Keep the legacy global index
-- until migration 263 is separately approved and run.
--
-- Evidence ladder (all evidence is also cross-checked; disagreement ABORTS):
--   1. existing timelines.company_id
--   2. contacts.company_id through timelines.contact_id
--   3. yelp_conversations.company_id through timeline_id
--   4. calls.company_id through timeline_id
--   5. email_messages.company_id through timeline_id
--   6. tasks.company_id through thread_id
--   7. same-phone contact/SMS evidence, only when it resolves to one company
--   8. evidence-free pre-multitenant rows are explicitly bound to ABC Homes
--      as DATA, once, in this migration (never as a runtime fallback).
--
-- Idempotent. Existing explicit values are not guessed over. Any contradictory
-- evidence aborts the transaction before the first persistent write.
-- =============================================================================

LOCK TABLE timelines IN SHARE ROW EXCLUSIVE MODE;

DO $$
BEGIN
    IF to_regclass('public.uq_timelines_orphan_phone') IS NULL
       AND to_regclass('public.uq_timelines_company_orphan_phone') IS NULL THEN
        RAISE EXCEPTION 'TENANT_ISO_262_PREFLIGHT: neither orphan-phone uniqueness index exists';
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM companies
        WHERE id = '00000000-0000-0000-0000-000000000001'::uuid
    ) THEN
        RAISE EXCEPTION 'TENANT_ISO_262_PREFLIGHT: ABC Homes company row is missing';
    END IF;
END $$;

-- Do not use ON COMMIT DROP here: `psql -f` may autocommit each statement.
-- The explicit start/end drops also make a retry safe after a failed preflight.
DROP TABLE IF EXISTS pg_temp.tenant_iso_262_evidence;

CREATE TEMP TABLE tenant_iso_262_evidence (
    timeline_id BIGINT NOT NULL,
    company_id UUID NOT NULL,
    source TEXT NOT NULL
);

INSERT INTO tenant_iso_262_evidence (timeline_id, company_id, source)
SELECT id, company_id, 'timeline'
FROM timelines
WHERE company_id IS NOT NULL;

INSERT INTO tenant_iso_262_evidence (timeline_id, company_id, source)
SELECT timeline.id, contact.company_id, 'contact_fk'
FROM timelines timeline
JOIN contacts contact ON contact.id = timeline.contact_id
WHERE contact.company_id IS NOT NULL;

INSERT INTO tenant_iso_262_evidence (timeline_id, company_id, source)
SELECT conversation.timeline_id, conversation.company_id, 'yelp_conversation_fk'
FROM yelp_conversations conversation
WHERE conversation.timeline_id IS NOT NULL;

INSERT INTO tenant_iso_262_evidence (timeline_id, company_id, source)
SELECT call.timeline_id, call.company_id, 'call_fk'
FROM calls call
WHERE call.timeline_id IS NOT NULL
  AND call.company_id IS NOT NULL;

INSERT INTO tenant_iso_262_evidence (timeline_id, company_id, source)
SELECT message.timeline_id, message.company_id, 'email_message_fk'
FROM email_messages message
WHERE message.timeline_id IS NOT NULL
  AND message.company_id IS NOT NULL;

INSERT INTO tenant_iso_262_evidence (timeline_id, company_id, source)
SELECT task.thread_id, task.company_id, 'task_fk'
FROM tasks task
WHERE task.thread_id IS NOT NULL
  AND task.company_id IS NOT NULL;

INSERT INTO tenant_iso_262_evidence (timeline_id, company_id, source)
SELECT DISTINCT timeline.id, contact.company_id, 'contact_phone'
FROM timelines timeline
JOIN contacts contact
  ON timeline.contact_id IS NULL
 AND timeline.phone_e164 IS NOT NULL
 AND NULLIF(regexp_replace(timeline.phone_e164, '[^0-9]', '', 'g'), '') IN (
        NULLIF(regexp_replace(contact.phone_e164, '[^0-9]', '', 'g'), ''),
        NULLIF(regexp_replace(contact.secondary_phone, '[^0-9]', '', 'g'), '')
    )
WHERE contact.company_id IS NOT NULL;

INSERT INTO tenant_iso_262_evidence (timeline_id, company_id, source)
SELECT DISTINCT timeline.id, conversation.company_id, 'sms_phone'
FROM timelines timeline
JOIN sms_conversations conversation
  ON timeline.contact_id IS NULL
 AND timeline.phone_e164 IS NOT NULL
 AND NULLIF(regexp_replace(timeline.phone_e164, '[^0-9]', '', 'g'), '')
     = NULLIF(regexp_replace(conversation.customer_e164, '[^0-9]', '', 'g'), '')
WHERE conversation.company_id IS NOT NULL;

DO $$
DECLARE
    conflict RECORD;
BEGIN
    SELECT timeline_id,
           array_agg(DISTINCT company_id ORDER BY company_id) AS companies,
           array_agg(DISTINCT source ORDER BY source) AS sources
    INTO conflict
    FROM tenant_iso_262_evidence
    GROUP BY timeline_id
    HAVING count(DISTINCT company_id) > 1
    ORDER BY timeline_id
    LIMIT 1;

    IF FOUND THEN
        RAISE EXCEPTION
            'TENANT_ISO_262_CONFLICT: timeline % has contradictory companies % from %',
            conflict.timeline_id, conflict.companies, conflict.sources;
    END IF;
END $$;

UPDATE timelines timeline
SET company_id = resolved.company_id
FROM (
    SELECT timeline_id, min(company_id::text)::uuid AS company_id
    FROM tenant_iso_262_evidence
    GROUP BY timeline_id
) resolved
WHERE timeline.id = resolved.timeline_id
  AND timeline.company_id IS NULL;

UPDATE timelines
SET company_id = '00000000-0000-0000-0000-000000000001'::uuid
WHERE company_id IS NULL;

ALTER TABLE timelines
    ALTER COLUMN company_id SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_timelines_company_orphan_phone
    ON timelines(company_id, phone_e164)
    WHERE phone_e164 IS NOT NULL AND contact_id IS NULL;

DROP TABLE tenant_iso_262_evidence;

-- On the first stage-2a run, uq_timelines_orphan_phone is deliberately retained.
-- A re-run after separately gated migration 263 is a no-op and does not recreate it.
