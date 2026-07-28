-- =============================================================================
-- Migration 212: LEAD-CHANNEL-ANALYTICS-001 Chunk 1a
--
-- Tenant-scoped canonical lead-source channels, raw-source aliases, and durable
-- lead/job funnel milestones.  Re-runnable: migrations are also replayed while
-- provisioning new companies.
-- =============================================================================

CREATE TABLE IF NOT EXISTS lead_source_channels (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id      UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    channel_key     TEXT NOT NULL,
    display_name    TEXT NOT NULL,
    description     TEXT,
    is_active       BOOLEAN NOT NULL DEFAULT true,
    metadata        JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT lead_source_channels_company_key_unique
        UNIQUE (company_id, channel_key),
    CONSTRAINT lead_source_channels_company_id_id_unique
        UNIQUE (company_id, id),
    CONSTRAINT lead_source_channels_key_not_blank
        CHECK (BTRIM(channel_key) <> ''),
    CONSTRAINT lead_source_channels_name_not_blank
        CHECK (BTRIM(display_name) <> '')
);

CREATE TABLE IF NOT EXISTS lead_source_aliases (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id          UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    channel_id          UUID NOT NULL,
    raw_source          TEXT NOT NULL,
    normalized_source   TEXT NOT NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT lead_source_aliases_company_source_unique
        UNIQUE (company_id, normalized_source),
    CONSTRAINT lead_source_aliases_company_channel_fk
        FOREIGN KEY (company_id, channel_id)
        REFERENCES lead_source_channels(company_id, id)
        ON DELETE CASCADE,
    CONSTRAINT lead_source_aliases_raw_not_blank
        CHECK (BTRIM(raw_source) <> ''),
    CONSTRAINT lead_source_aliases_normalized
        CHECK (normalized_source = LOWER(BTRIM(raw_source)))
);

CREATE INDEX IF NOT EXISTS idx_lead_source_channels_company_active
    ON lead_source_channels(company_id, is_active, display_name);

CREATE INDEX IF NOT EXISTS idx_lead_source_aliases_company_channel
    ON lead_source_aliases(company_id, channel_id);

COMMENT ON TABLE lead_source_channels IS
    'Tenant-owned canonical acquisition channels. Future ad connections and performance rows reference this stable identity.';
COMMENT ON TABLE lead_source_aliases IS
    'Tenant-owned mapping from normalized raw leads.job_source values to canonical channels; the raw lead value remains unchanged.';

-- Every company has a stable fallback identity. It is intentionally not an
-- alias target during the historical-source seed below.
INSERT INTO lead_source_channels (
    company_id,
    channel_key,
    display_name,
    description,
    metadata
)
SELECT
    c.id,
    'unattributed',
    'Unattributed',
    'Leads with no active canonical source mapping',
    '{"system":true}'::jsonb
FROM companies c
ON CONFLICT (company_id, channel_key) DO NOTHING;

-- Preserve all raw source values on leads. Existing distinct sources receive a
-- deterministic tenant-local channel so analytics is useful before a channel
-- management UI exists. A later alias edit can merge several raw values into
-- one canonical channel without rewriting historical leads.
WITH historical_sources AS (
    SELECT
        l.company_id,
        LOWER(BTRIM(l.job_source)) AS normalized_source,
        MIN(BTRIM(l.job_source)) AS display_name
    FROM leads l
    WHERE l.company_id IS NOT NULL
      AND NULLIF(BTRIM(l.job_source), '') IS NOT NULL
    GROUP BY l.company_id, LOWER(BTRIM(l.job_source))
)
INSERT INTO lead_source_channels (
    company_id,
    channel_key,
    display_name,
    description,
    metadata
)
SELECT
    hs.company_id,
    'source_' || MD5(hs.normalized_source),
    hs.display_name,
    'Canonical channel seeded from an existing raw lead source',
    jsonb_build_object('seeded_from_raw_source', true)
FROM historical_sources hs
ON CONFLICT (company_id, channel_key) DO NOTHING;

WITH historical_sources AS (
    SELECT
        l.company_id,
        LOWER(BTRIM(l.job_source)) AS normalized_source,
        MIN(BTRIM(l.job_source)) AS raw_source
    FROM leads l
    WHERE l.company_id IS NOT NULL
      AND NULLIF(BTRIM(l.job_source), '') IS NOT NULL
    GROUP BY l.company_id, LOWER(BTRIM(l.job_source))
)
INSERT INTO lead_source_aliases (
    company_id,
    channel_id,
    raw_source,
    normalized_source
)
SELECT
    hs.company_id,
    ch.id,
    hs.raw_source,
    hs.normalized_source
FROM historical_sources hs
JOIN lead_source_channels ch
  ON ch.company_id = hs.company_id
 AND ch.channel_key = 'source_' || MD5(hs.normalized_source)
ON CONFLICT (company_id, normalized_source) DO NOTHING;

-- Durable first-reached timestamps. These are columns rather than an event
-- table because each milestone is monotonic and singular for its entity.
ALTER TABLE leads
    ADD COLUMN IF NOT EXISTS converted_at TIMESTAMPTZ;

ALTER TABLE jobs
    ADD COLUMN IF NOT EXISTS visit_completed_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS repair_done_at TIMESTAMPTZ;

-- Existing rows predate durable capture. Prefer the linked job creation time
-- for conversion; otherwise use the best timestamp already present on the lead.
UPDATE leads l
SET converted_at = COALESCE(
    (
        SELECT MIN(j.created_at)
        FROM jobs j
        WHERE j.company_id = l.company_id
          AND j.lead_id = l.id
    ),
    l.updated_at,
    l.created_at
)
WHERE l.converted_at IS NULL
  AND (
      l.converted_to_job = true
      OR LOWER(BTRIM(COALESCE(l.status, ''))) = 'converted'
      OR EXISTS (
          SELECT 1
          FROM jobs linked_job
          WHERE linked_job.company_id = l.company_id
            AND linked_job.lead_id = l.id
      )
  );

-- The published job FSM makes Visit completed the predecessor of Job is Done.
-- A historical final job therefore implies both milestones, although its exact
-- old transition time is only approximated by the row's last update.
UPDATE jobs j
SET visit_completed_at = COALESCE(j.visit_completed_at, j.updated_at, j.created_at),
    repair_done_at = CASE
        WHEN LOWER(REPLACE(BTRIM(COALESCE(j.blanc_status, '')), '_', ' ')) = 'job is done'
        THEN COALESCE(j.repair_done_at, j.updated_at, j.created_at)
        ELSE j.repair_done_at
    END
WHERE j.company_id IS NOT NULL
  AND (
      (
          LOWER(REPLACE(BTRIM(COALESCE(j.blanc_status, '')), '_', ' '))
              = 'visit completed'
          AND j.visit_completed_at IS NULL
      )
      OR (
          LOWER(REPLACE(BTRIM(COALESCE(j.blanc_status, '')), '_', ' '))
              = 'job is done'
          AND (
              j.visit_completed_at IS NULL
              OR j.repair_done_at IS NULL
          )
      )
  );

CREATE OR REPLACE FUNCTION capture_lead_conversion_milestone()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.converted_at IS NULL
       AND (
           NEW.converted_to_job = true
           OR LOWER(BTRIM(COALESCE(NEW.status, ''))) = 'converted'
       )
    THEN
        NEW.converted_at := NOW();
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_leads_capture_conversion_milestone ON leads;
CREATE TRIGGER trg_leads_capture_conversion_milestone
    BEFORE INSERT OR UPDATE OF converted_to_job, status
    ON leads
    FOR EACH ROW
    EXECUTE FUNCTION capture_lead_conversion_milestone();

CREATE OR REPLACE FUNCTION capture_job_funnel_milestones()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    normalized_status TEXT;
BEGIN
    normalized_status :=
        LOWER(REPLACE(BTRIM(COALESCE(NEW.blanc_status, '')), '_', ' '));

    IF normalized_status IN ('visit completed', 'job is done')
       AND NEW.visit_completed_at IS NULL
    THEN
        NEW.visit_completed_at := NOW();
    END IF;

    IF normalized_status = 'job is done'
       AND NEW.repair_done_at IS NULL
    THEN
        NEW.repair_done_at := NOW();
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_jobs_capture_funnel_milestones ON jobs;
CREATE TRIGGER trg_jobs_capture_funnel_milestones
    BEFORE INSERT OR UPDATE OF blanc_status
    ON jobs
    FOR EACH ROW
    EXECUTE FUNCTION capture_job_funnel_milestones();

CREATE INDEX IF NOT EXISTS idx_leads_company_created_at_analytics
    ON leads(company_id, created_at);

CREATE INDEX IF NOT EXISTS idx_leads_company_contact_created_analytics
    ON leads(company_id, contact_id, created_at)
    WHERE contact_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_jobs_company_lead_analytics
    ON jobs(company_id, lead_id);

CREATE INDEX IF NOT EXISTS idx_calls_company_contact_started_analytics
    ON calls(company_id, contact_id, started_at)
    WHERE contact_id IS NOT NULL AND price IS NOT NULL;

COMMENT ON COLUMN leads.converted_at IS
    'First durable timestamp at which this lead reached the Converted milestone.';
COMMENT ON COLUMN jobs.visit_completed_at IS
    'First durable timestamp at which this job reached Visit completed (also implied by Job is Done).';
COMMENT ON COLUMN jobs.repair_done_at IS
    'First durable timestamp at which this job reached the final Job is Done milestone.';
