-- =============================================================================
-- TENANT-ISO-002, stage 2a: make timeline ownership explicit and add the
-- tenant-aware orphan-phone uniqueness contract. Keep the legacy global index
-- until migration 263 is separately approved and run.
--
-- Two-tier ownership ladder:
--   Tier 1 — authoritative relationships. Existing timelines.company_id and
--     company_id reached through contact/call/email/task/Yelp foreign keys are
--     facts. Contradictory Tier-1 companies ABORT before any ownership write.
--   Tier 2 — phone heuristic. Consulted only when a timeline has no Tier-1
--     evidence. Exactly one candidate company is accepted. Multiple candidate
--     companies are legal (the same customer phone may exist in two tenants):
--     emit a NOTICE and leave the row for the legacy-data branch.
--   Final — evidence-free or phone-ambiguous pre-multitenant rows are explicitly
--     bound to ABC Homes as DATA, once, never as a runtime fallback.
--
-- Idempotent. Existing explicit values are not guessed over. Only contradictory
-- authoritative relationships are treated as cross-tenant contamination.
-- =============================================================================

-- No LOCK TABLE and no explicit transaction here, deliberately. Both staging and
-- production apply migrations with `psql -f` in autocommit, where LOCK TABLE is
-- rejected outright ("can only be used in transaction blocks") and would in any
-- case be released the moment its own statement committed. Wrapping the file in
-- BEGIN/COMMIT is not an option either: the migration's DB test applies it inside
-- its own transaction for isolation, and a COMMIT in here would commit the test's
-- fixtures out from under it.
--
-- What still holds: the conflict check below runs BEFORE any ownership write, so
-- under ON_ERROR_STOP a contradiction aborts the run without having touched a row.
-- What is given up: if a timeline is inserted concurrently between the backfill and
-- SET NOT NULL, that statement fails — loudly, and the file is idempotent, so the
-- fix is to re-run it.

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
DROP TABLE IF EXISTS pg_temp.tenant_iso_262_link_evidence;
DROP TABLE IF EXISTS pg_temp.tenant_iso_262_phone_evidence;

CREATE TEMP TABLE tenant_iso_262_link_evidence (
    timeline_id BIGINT NOT NULL,
    company_id UUID NOT NULL,
    source TEXT NOT NULL
);

INSERT INTO tenant_iso_262_link_evidence (timeline_id, company_id, source)
SELECT id, company_id, 'timeline'
FROM timelines
WHERE company_id IS NOT NULL;

INSERT INTO tenant_iso_262_link_evidence (timeline_id, company_id, source)
SELECT timeline.id, contact.company_id, 'contact_fk'
FROM timelines timeline
JOIN contacts contact ON contact.id = timeline.contact_id
WHERE contact.company_id IS NOT NULL;

INSERT INTO tenant_iso_262_link_evidence (timeline_id, company_id, source)
SELECT conversation.timeline_id, conversation.company_id, 'yelp_conversation_fk'
FROM yelp_conversations conversation
WHERE conversation.timeline_id IS NOT NULL;

INSERT INTO tenant_iso_262_link_evidence (timeline_id, company_id, source)
SELECT call.timeline_id, call.company_id, 'call_fk'
FROM calls call
WHERE call.timeline_id IS NOT NULL
  AND call.company_id IS NOT NULL;

INSERT INTO tenant_iso_262_link_evidence (timeline_id, company_id, source)
SELECT message.timeline_id, message.company_id, 'email_message_fk'
FROM email_messages message
WHERE message.timeline_id IS NOT NULL
  AND message.company_id IS NOT NULL;

INSERT INTO tenant_iso_262_link_evidence (timeline_id, company_id, source)
SELECT task.thread_id, task.company_id, 'task_fk'
FROM tasks task
WHERE task.thread_id IS NOT NULL
  AND task.company_id IS NOT NULL;

DO $$
DECLARE
    conflict RECORD;
BEGIN
    SELECT timeline_id,
           array_agg(DISTINCT company_id ORDER BY company_id) AS companies,
           array_agg(DISTINCT source ORDER BY source) AS sources
    INTO conflict
    FROM tenant_iso_262_link_evidence
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

CREATE TEMP TABLE tenant_iso_262_phone_evidence (
    timeline_id BIGINT NOT NULL,
    company_id UUID NOT NULL,
    source TEXT NOT NULL
);

-- Phone is deliberately weaker than every Tier-1 source. Do not even collect
-- phone candidates for a timeline once an authoritative relationship exists.
INSERT INTO tenant_iso_262_phone_evidence (timeline_id, company_id, source)
SELECT DISTINCT timeline.id, contact.company_id, 'contact_phone'
FROM timelines timeline
JOIN contacts contact
  ON timeline.contact_id IS NULL
 AND timeline.phone_e164 IS NOT NULL
 AND NULLIF(regexp_replace(timeline.phone_e164, '[^0-9]', '', 'g'), '') IN (
        NULLIF(regexp_replace(contact.phone_e164, '[^0-9]', '', 'g'), ''),
        NULLIF(regexp_replace(contact.secondary_phone, '[^0-9]', '', 'g'), '')
    )
WHERE contact.company_id IS NOT NULL
  AND NOT EXISTS (
      SELECT 1
      FROM tenant_iso_262_link_evidence link
      WHERE link.timeline_id = timeline.id
  );

INSERT INTO tenant_iso_262_phone_evidence (timeline_id, company_id, source)
SELECT DISTINCT timeline.id, conversation.company_id, 'sms_phone'
FROM timelines timeline
JOIN sms_conversations conversation
  ON timeline.contact_id IS NULL
 AND timeline.phone_e164 IS NOT NULL
 AND NULLIF(regexp_replace(timeline.phone_e164, '[^0-9]', '', 'g'), '')
     = NULLIF(regexp_replace(conversation.customer_e164, '[^0-9]', '', 'g'), '')
WHERE conversation.company_id IS NOT NULL
  AND NOT EXISTS (
      SELECT 1
      FROM tenant_iso_262_link_evidence link
      WHERE link.timeline_id = timeline.id
  );

DO $$
DECLARE
    ambiguous_count BIGINT;
BEGIN
    SELECT count(*)
    INTO ambiguous_count
    FROM (
        SELECT timeline_id
        FROM tenant_iso_262_phone_evidence
        GROUP BY timeline_id
        HAVING count(DISTINCT company_id) > 1
    ) ambiguous;

    IF ambiguous_count > 0 THEN
        RAISE NOTICE
            'TENANT_ISO_262_PHONE_AMBIGUOUS: % timeline(s) have multiple phone-owner candidates; assigning them through the legacy ABC branch',
            ambiguous_count;
    END IF;
END $$;

-- Tier 1 wins unconditionally once its internal consistency is proven.
UPDATE timelines timeline
SET company_id = resolved.company_id
FROM (
    SELECT timeline_id, min(company_id::text)::uuid AS company_id
    FROM tenant_iso_262_link_evidence
    GROUP BY timeline_id
) resolved
WHERE timeline.id = resolved.timeline_id
  AND timeline.company_id IS NULL;

-- Tier 2 is accepted only when all phone candidates resolve to one company.
UPDATE timelines timeline
SET company_id = resolved.company_id
FROM (
    SELECT timeline_id, min(company_id::text)::uuid AS company_id
    FROM tenant_iso_262_phone_evidence
    GROUP BY timeline_id
    HAVING count(DISTINCT company_id) = 1
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

DROP TABLE tenant_iso_262_phone_evidence;
DROP TABLE tenant_iso_262_link_evidence;

-- On the first stage-2a run, uq_timelines_orphan_phone is deliberately retained.
-- A re-run after separately gated migration 263 is a no-op and does not recreate it.
