-- 245_lead_autoconvert_consistency.sql
-- LEAD-AUTOCONVERT-001: repair explicitly job-linked Leads, then enforce that
-- the string status and legacy converted_to_job flag cannot diverge.

-- Both zenbooker_job_id columns still exist on master. Use that provenance only
-- to attach an otherwise-unlinked Job, and only inside the same company. If more
-- than one Lead names the same historical id, the oldest Lead wins.
WITH zenbooker_matches AS (
    SELECT DISTINCT ON (j.id)
        j.id AS job_id,
        l.id AS lead_id,
        l.company_id
    FROM jobs j
    JOIN leads l
      ON l.company_id = j.company_id
     AND l.zenbooker_job_id IS NOT NULL
     AND l.zenbooker_job_id = j.zenbooker_job_id
    WHERE j.lead_id IS NULL
      AND j.zenbooker_job_id IS NOT NULL
    ORDER BY j.id, l.id ASC
)
UPDATE jobs j
SET lead_id = matches.lead_id
FROM zenbooker_matches matches
WHERE j.id = matches.job_id
  AND j.company_id = matches.company_id
  AND j.lead_id IS NULL;

-- At this point every backfill candidate is an explicit same-company
-- jobs.lead_id -> leads.id relation. Pick the oldest linked Job deterministically.
WITH candidates AS (
    SELECT DISTINCT ON (l.id)
        l.id AS lead_id,
        l.company_id,
        l.status AS previous_status,
        j.id AS job_id
    FROM leads l
    JOIN jobs j
      ON j.lead_id = l.id
     AND j.company_id = l.company_id
    WHERE lower(COALESCE(l.status, '')) <> 'lost'
      AND COALESCE(l.lead_lost, false) = false
      AND (
          l.status IS DISTINCT FROM 'Converted'
          OR l.converted_to_job IS DISTINCT FROM true
      )
    ORDER BY l.id, j.id ASC
), converted AS (
    UPDATE leads l
    SET status = 'Converted',
        converted_to_job = true
    FROM candidates c
    WHERE l.id = c.lead_id
      AND l.company_id = c.company_id
    RETURNING l.id, l.company_id, c.previous_status, c.job_id
)
INSERT INTO audit_log (
    actor_id,
    action,
    target_type,
    target_id,
    company_id,
    details
)
SELECT
    NULL,
    activity.action,
    'lead',
    converted.id::text,
    converted.company_id,
    jsonb_build_object(
        'actor_type', 'system',
        'actor_label', 'Lead auto-convert backfill',
        'source', 'crm',
        'parent_type', NULL,
        'parent_id', NULL,
        'summary', jsonb_build_object(
            'job_id', converted.job_id,
            'status', 'Converted',
            'previous_status', converted.previous_status
        )
    )
FROM converted
CROSS JOIN (VALUES ('lead.converted'), ('lead.status_changed')) AS activity(action);

-- Repair legacy rows that did not qualify for job-linked conversion so the
-- constraint can be installed without inventing conversions for unlinked Leads.
UPDATE leads
SET converted_to_job = true
WHERE status = 'Converted'
  AND converted_to_job IS DISTINCT FROM true;

UPDATE leads
SET converted_to_job = false
WHERE status IS DISTINCT FROM 'Converted'
  AND converted_to_job IS DISTINCT FROM false;

DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM leads
        WHERE (status = 'Converted') IS DISTINCT FROM converted_to_job
    ) THEN
        RAISE EXCEPTION 'LEAD-AUTOCONVERT-001: legacy conversion divergence remains';
    END IF;
END $$;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conrelid = 'leads'::regclass
          AND conname = 'chk_leads_conversion_consistency'
    ) THEN
        ALTER TABLE leads
            ADD CONSTRAINT chk_leads_conversion_consistency
            CHECK ((status = 'Converted') = converted_to_job);
    END IF;
END $$;
