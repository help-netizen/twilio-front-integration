-- =============================================================================
-- Migration 252: ELOCAL-ATTRIBUTION-001
--
-- Tenant-owned eLocal connection state, deduplicated provider calls, and
-- deterministic windowed one-owner-per-job attribution.
-- =============================================================================

CREATE TABLE IF NOT EXISTS elocal_connections (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id              UUID NOT NULL UNIQUE
                                REFERENCES companies(id) ON DELETE CASCADE,
    channel_id              UUID NOT NULL,
    campaign_ids            TEXT[] NOT NULL,
    api_key_reference       TEXT NOT NULL DEFAULT 'ELOCAL_API_KEY',
    status                  TEXT NOT NULL DEFAULT 'connected'
                                CHECK (status IN ('connected', 'disconnected')),
    last_sync_status        TEXT NOT NULL DEFAULT 'pending',
    synced_from_date        DATE,
    synced_through_date     DATE,
    last_sync_started_at    TIMESTAMPTZ,
    last_sync_finished_at   TIMESTAMPTZ,
    last_synced_at          TIMESTAMPTZ,
    last_matched_at         TIMESTAMPTZ,
    sync_lease_expires_at   TIMESTAMPTZ,
    last_call_count         INTEGER,
    last_web_lead_count     INTEGER,
    last_error_code         TEXT,
    last_error              TEXT,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT elocal_connections_company_id_id_unique
        UNIQUE (company_id, id),
    CONSTRAINT elocal_connections_company_channel_fk
        FOREIGN KEY (company_id, channel_id)
        REFERENCES lead_source_channels(company_id, id)
        ON DELETE RESTRICT,
    CONSTRAINT elocal_connections_campaigns_not_empty
        CHECK (CARDINALITY(campaign_ids) > 0),
    CONSTRAINT elocal_connections_key_reference_not_blank
        CHECK (BTRIM(api_key_reference) <> '')
);

CREATE INDEX IF NOT EXISTS idx_elocal_connections_due
    ON elocal_connections(status, last_sync_status, last_synced_at);

CREATE TABLE IF NOT EXISTS elocal_leads (
    id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id                  UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    connection_id               UUID NOT NULL,
    campaign_id                 TEXT NOT NULL,
    external_call_id            TEXT NOT NULL,
    caller_phone_e164           TEXT,
    normalized_phone            TEXT,
    cost_cents                  BIGINT NOT NULL DEFAULT 0 CHECK (cost_cents >= 0),
    supply_event_status         TEXT NOT NULL,
    supply_event_status_reason  TEXT,
    billable                    BOOLEAN NOT NULL DEFAULT false,
    call_at                     TIMESTAMPTZ NOT NULL,
    service_zip_code            TEXT,
    service_city                TEXT,
    service_state_abbr          TEXT,
    campaign_name               TEXT,
    category_name               TEXT,
    call_duration_seconds       INTEGER,
    call_quality_tags           JSONB NOT NULL DEFAULT '[]'::JSONB,
    forwarding_number           TEXT,
    external_campaign_id        TEXT,
    lead_source_id              TEXT,
    match_status                TEXT NOT NULL DEFAULT 'pending'
                                CHECK (match_status IN (
                                    'pending',
                                    'matched',
                                    'diagnostic',
                                    'ambiguous',
                                    'unmatched',
                                    'no_phone'
                                )),
    matched_contact_id          BIGINT,
    matched_lead_id             BIGINT,
    matched_call_id             BIGINT,
    match_method                TEXT CHECK (match_method IN (
                                    'nearby_call_contact',
                                    'nearby_call_phone',
                                    'nearby_crm_lead_contact',
                                    'phone_only'
                                )),
    match_confidence            SMALLINT CHECK (
                                    match_confidence BETWEEN 0 AND 100
                                ),
    matched_at                  TIMESTAMPTZ,
    last_match_attempt_at       TIMESTAMPTZ,
    match_version               INTEGER NOT NULL DEFAULT 1,
    first_seen_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT elocal_leads_company_id_id_unique
        UNIQUE (company_id, id),
    CONSTRAINT elocal_leads_company_call_unique
        UNIQUE (company_id, external_call_id),
    CONSTRAINT elocal_leads_company_connection_fk
        FOREIGN KEY (company_id, connection_id)
        REFERENCES elocal_connections(company_id, id)
        ON DELETE CASCADE,
    CONSTRAINT elocal_leads_company_contact_fk
        FOREIGN KEY (matched_contact_id)
        REFERENCES contacts(id)
        ON DELETE SET NULL,
    CONSTRAINT elocal_leads_company_lead_fk
        FOREIGN KEY (matched_lead_id)
        REFERENCES leads(id)
        ON DELETE SET NULL,
    CONSTRAINT elocal_leads_company_call_fk
        FOREIGN KEY (matched_call_id)
        REFERENCES calls(id)
        ON DELETE SET NULL,
    CONSTRAINT elocal_leads_external_call_not_blank
        CHECK (BTRIM(external_call_id) <> ''),
    CONSTRAINT elocal_leads_campaign_not_blank
        CHECK (BTRIM(campaign_id) <> ''),
    CONSTRAINT elocal_leads_phone_e164
        CHECK (caller_phone_e164 IS NULL OR caller_phone_e164 ~ '^[+]1[0-9]{10}$'),
    CONSTRAINT elocal_leads_normalized_phone
        CHECK (normalized_phone IS NULL OR normalized_phone ~ '^[0-9]{10}$'),
    CONSTRAINT elocal_leads_phone_pair
        CHECK (
            (caller_phone_e164 IS NULL AND normalized_phone IS NULL)
            OR caller_phone_e164 = '+1' || normalized_phone
        ),
    CONSTRAINT elocal_leads_billable_status_consistent
        CHECK (billable = (supply_event_status = 'BILLABLE'))
);

CREATE INDEX IF NOT EXISTS idx_elocal_leads_company_call_at
    ON elocal_leads(company_id, call_at);
CREATE INDEX IF NOT EXISTS idx_elocal_leads_company_phone_call_at
    ON elocal_leads(company_id, normalized_phone, call_at)
    WHERE normalized_phone IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_elocal_leads_company_match_status
    ON elocal_leads(company_id, match_status, call_at);

CREATE TABLE IF NOT EXISTS elocal_job_attributions (
    company_id          UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    elocal_lead_id      UUID NOT NULL,
    matched_job_id      BIGINT NOT NULL,
    matched_contact_id  BIGINT,
    evidence_call_id    BIGINT,
    evidence_lead_id    BIGINT,
    match_method        TEXT NOT NULL CHECK (match_method IN (
                            'nearby_call_contact',
                            'nearby_call_phone',
                            'nearby_crm_lead_contact'
                        )),
    match_confidence    SMALLINT NOT NULL CHECK (
                            match_confidence BETWEEN 90 AND 100
                        ),
    matched_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (company_id, elocal_lead_id, matched_job_id),
    CONSTRAINT elocal_job_attributions_one_owner
        UNIQUE (company_id, matched_job_id),
    CONSTRAINT elocal_job_attributions_lead_fk
        FOREIGN KEY (company_id, elocal_lead_id)
        REFERENCES elocal_leads(company_id, id)
        ON DELETE CASCADE,
    CONSTRAINT elocal_job_attributions_job_fk
        FOREIGN KEY (matched_job_id)
        REFERENCES jobs(id)
        ON DELETE CASCADE,
    CONSTRAINT elocal_job_attributions_contact_fk
        FOREIGN KEY (matched_contact_id)
        REFERENCES contacts(id)
        ON DELETE SET NULL,
    CONSTRAINT elocal_job_attributions_call_fk
        FOREIGN KEY (evidence_call_id)
        REFERENCES calls(id)
        ON DELETE SET NULL,
    CONSTRAINT elocal_job_attributions_crm_lead_fk
        FOREIGN KEY (evidence_lead_id)
        REFERENCES leads(id)
        ON DELETE SET NULL
);

-- Migration 251 previously supplied the only matching composite indexes for
-- these CRM entities. Rebind every eLocal reference to provider-neutral primary
-- keys so replay repairs already-applied 252 schemas and either migration can
-- roll back without depending on the other's owned indexes.
ALTER TABLE elocal_leads
    DROP CONSTRAINT IF EXISTS elocal_leads_company_contact_fk,
    DROP CONSTRAINT IF EXISTS elocal_leads_company_lead_fk,
    DROP CONSTRAINT IF EXISTS elocal_leads_company_call_fk;
ALTER TABLE elocal_leads
    ADD CONSTRAINT elocal_leads_company_contact_fk
        FOREIGN KEY (matched_contact_id)
        REFERENCES contacts(id)
        ON DELETE SET NULL,
    ADD CONSTRAINT elocal_leads_company_lead_fk
        FOREIGN KEY (matched_lead_id)
        REFERENCES leads(id)
        ON DELETE SET NULL,
    ADD CONSTRAINT elocal_leads_company_call_fk
        FOREIGN KEY (matched_call_id)
        REFERENCES calls(id)
        ON DELETE SET NULL;

ALTER TABLE elocal_job_attributions
    DROP CONSTRAINT IF EXISTS elocal_job_attributions_job_fk,
    DROP CONSTRAINT IF EXISTS elocal_job_attributions_contact_fk,
    DROP CONSTRAINT IF EXISTS elocal_job_attributions_call_fk,
    DROP CONSTRAINT IF EXISTS elocal_job_attributions_crm_lead_fk;
ALTER TABLE elocal_job_attributions
    ADD CONSTRAINT elocal_job_attributions_job_fk
        FOREIGN KEY (matched_job_id)
        REFERENCES jobs(id)
        ON DELETE CASCADE,
    ADD CONSTRAINT elocal_job_attributions_contact_fk
        FOREIGN KEY (matched_contact_id)
        REFERENCES contacts(id)
        ON DELETE SET NULL,
    ADD CONSTRAINT elocal_job_attributions_call_fk
        FOREIGN KEY (evidence_call_id)
        REFERENCES calls(id)
        ON DELETE SET NULL,
    ADD CONSTRAINT elocal_job_attributions_crm_lead_fk
        FOREIGN KEY (evidence_lead_id)
        REFERENCES leads(id)
        ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_elocal_job_attributions_lead
    ON elocal_job_attributions(company_id, elocal_lead_id);
CREATE INDEX IF NOT EXISTS idx_elocal_job_attributions_contact
    ON elocal_job_attributions(company_id, matched_contact_id)
    WHERE matched_contact_id IS NOT NULL;

DROP TRIGGER IF EXISTS trg_elocal_connections_updated_at ON elocal_connections;
CREATE TRIGGER trg_elocal_connections_updated_at
    BEFORE UPDATE ON elocal_connections
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS trg_elocal_leads_updated_at ON elocal_leads;
CREATE TRIGGER trg_elocal_leads_updated_at
    BEFORE UPDATE ON elocal_leads
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS trg_elocal_job_attributions_updated_at
    ON elocal_job_attributions;
CREATE TRIGGER trg_elocal_job_attributions_updated_at
    BEFORE UPDATE ON elocal_job_attributions
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Migration 213 seeded one channel per historical raw source. Create a stable
-- eLocal channel only for tenants that already carry one of the two validated
-- historical eLocal identities, then rehome only those exact aliases.
WITH elocal_companies AS (
    SELECT DISTINCT company_id
    FROM lead_source_channels
    WHERE channel_key IN (
        'source_04a1ea464d394d519efd30a5988341f8',
        'source_88cdf671ddacd95240fc98b1eef48ec2'
    )
)
INSERT INTO lead_source_channels (
    company_id,
    channel_key,
    display_name,
    description,
    metadata,
    is_active
)
SELECT
    company_id,
    'elocal',
    'eLocal',
    'eLocal pay-per-call acquisition and spend',
    '{"system":true,"provider_key":"elocal","elocal_attribution_001_created":true}'::JSONB,
    true
FROM elocal_companies
ON CONFLICT (company_id, channel_key) DO UPDATE SET
    display_name = EXCLUDED.display_name,
    description = EXCLUDED.description,
    is_active = true,
    metadata = lead_source_channels.metadata
        || '{"system":true,"provider_key":"elocal"}'::JSONB,
    updated_at = NOW();

-- The validated all-campaign IDs belong to the tenant carrying both historical
-- eLocal identities. Seed only that exact legacy shape; future tenants use the
-- connection service and are never assigned another tenant's campaign IDs.
WITH validated_elocal_companies AS (
    SELECT company_id
    FROM lead_source_channels
    WHERE channel_key IN (
        'source_04a1ea464d394d519efd30a5988341f8',
        'source_88cdf671ddacd95240fc98b1eef48ec2'
    )
    GROUP BY company_id
    HAVING COUNT(DISTINCT channel_key) = 2
),
validated_connections AS (
    SELECT company.company_id, canonical.id AS channel_id
    FROM validated_elocal_companies company
    JOIN lead_source_channels canonical
      ON canonical.company_id = company.company_id
     AND canonical.channel_key = 'elocal'
)
INSERT INTO elocal_connections (
    company_id,
    channel_id,
    campaign_ids,
    api_key_reference,
    status,
    last_sync_status
)
SELECT
    company_id,
    channel_id,
    ARRAY[
        '3ffa28e6-f186-4301-abd6-5ec39d6e866b',
        '24e83932-12ce-4b13-9066-846f99f76c19'
    ]::TEXT[],
    'ELOCAL_API_KEY',
    'connected',
    'pending'
FROM validated_connections
ON CONFLICT (company_id) DO NOTHING;

WITH channel_pairs AS (
    SELECT
        canonical.company_id,
        canonical.id AS canonical_id,
        duplicate.id AS duplicate_id,
        duplicate.channel_key AS duplicate_key
    FROM lead_source_channels canonical
    JOIN lead_source_channels duplicate
      ON duplicate.company_id = canonical.company_id
     AND duplicate.channel_key IN (
        'source_04a1ea464d394d519efd30a5988341f8',
        'source_88cdf671ddacd95240fc98b1eef48ec2'
     )
    WHERE canonical.channel_key = 'elocal'
)
UPDATE lead_source_aliases alias
SET channel_id = pair.canonical_id,
    updated_at = NOW()
FROM channel_pairs pair
WHERE alias.company_id = pair.company_id
  AND alias.channel_id = pair.duplicate_id
  AND (
      (pair.duplicate_key = 'source_04a1ea464d394d519efd30a5988341f8'
       AND alias.normalized_source = 'elocal')
      OR
      (pair.duplicate_key = 'source_88cdf671ddacd95240fc98b1eef48ec2'
       AND alias.normalized_source = 'elocals')
  );

UPDATE lead_source_channels
SET is_active = false,
    metadata = COALESCE(metadata, '{}'::JSONB) || jsonb_build_object(
        'merged_into_channel_key', 'elocal',
        'elocal_attribution_001_merged', true
    ),
    updated_at = NOW()
WHERE channel_key IN (
    'source_04a1ea464d394d519efd30a5988341f8',
    'source_88cdf671ddacd95240fc98b1eef48ec2'
)
  AND EXISTS (
      SELECT 1
      FROM lead_source_channels canonical
      WHERE canonical.company_id = lead_source_channels.company_id
        AND canonical.channel_key = 'elocal'
  );

COMMENT ON TABLE elocal_connections IS
    'Tenant-owned eLocal campaign configuration and leased synchronization state.';
COMMENT ON TABLE elocal_leads IS
    'Deduplicated tenant-owned eLocal provider calls and their deterministic CRM match.';
COMMENT ON TABLE elocal_job_attributions IS
    'Windowed high-confidence eLocal-to-job ownership; each tenant job has at most one eLocal owner.';
