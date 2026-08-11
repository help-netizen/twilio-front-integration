-- =============================================================================
-- Migration 251: GOOGLE-LSA-ATTRIBUTION-001 T1/T2
--
-- Tenant-owned Google Local Services Ads leads, their deterministic CRM match,
-- and the windowed one-owner-per-job attribution boundary.
-- =============================================================================

ALTER TABLE google_ads_connections
    ADD COLUMN IF NOT EXISTS lsa_synced_from_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS lsa_synced_through_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS lsa_last_synced_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS lsa_last_matched_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS lsa_last_lead_count INTEGER;

-- Composite identities make every attribution FK enforce its tenant pairing.
CREATE UNIQUE INDEX IF NOT EXISTS uq_contacts_company_id_id_lsa
    ON contacts(company_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_leads_company_id_id_lsa
    ON leads(company_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_jobs_company_id_id_lsa
    ON jobs(company_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_calls_company_id_id_lsa
    ON calls(company_id, id);

CREATE TABLE IF NOT EXISTS google_lsa_leads (
    id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id                  UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    connection_id               UUID NOT NULL,
    external_account_id         TEXT NOT NULL,
    external_lead_id            TEXT NOT NULL,
    resource_name               TEXT NOT NULL,
    lead_type                   TEXT NOT NULL,
    phone_e164                  TEXT,
    normalized_phone            TEXT,
    provider_created_at         TIMESTAMPTZ NOT NULL,
    provider_creation_date_time TEXT NOT NULL,
    lead_charged                BOOLEAN NOT NULL DEFAULT false,
    lead_status                 TEXT,
    match_status                TEXT NOT NULL DEFAULT 'pending'
                                CHECK (match_status IN (
                                    'pending',
                                    'matched',
                                    'diagnostic',
                                    'ambiguous',
                                    'ineligible',
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
    CONSTRAINT google_lsa_leads_company_id_id_unique
        UNIQUE (company_id, id),
    CONSTRAINT google_lsa_leads_company_resource_unique
        UNIQUE (company_id, resource_name),
    CONSTRAINT google_lsa_leads_company_external_id_unique
        UNIQUE (company_id, external_account_id, external_lead_id),
    CONSTRAINT google_lsa_leads_company_connection_fk
        FOREIGN KEY (company_id, connection_id)
        REFERENCES google_ads_connections(company_id, id)
        ON DELETE CASCADE,
    CONSTRAINT google_lsa_leads_company_contact_fk
        FOREIGN KEY (company_id, matched_contact_id)
        REFERENCES contacts(company_id, id)
        ON DELETE SET NULL (matched_contact_id),
    CONSTRAINT google_lsa_leads_company_lead_fk
        FOREIGN KEY (company_id, matched_lead_id)
        REFERENCES leads(company_id, id)
        ON DELETE SET NULL (matched_lead_id),
    CONSTRAINT google_lsa_leads_company_call_fk
        FOREIGN KEY (company_id, matched_call_id)
        REFERENCES calls(company_id, id)
        ON DELETE SET NULL (matched_call_id),
    CONSTRAINT google_lsa_leads_external_id_not_blank
        CHECK (BTRIM(external_lead_id) <> ''),
    CONSTRAINT google_lsa_leads_resource_not_blank
        CHECK (BTRIM(resource_name) <> ''),
    CONSTRAINT google_lsa_leads_phone_e164
        CHECK (phone_e164 IS NULL OR phone_e164 ~ '^[+]1[0-9]{10}$'),
    CONSTRAINT google_lsa_leads_normalized_phone
        CHECK (normalized_phone IS NULL OR normalized_phone ~ '^[0-9]{10}$'),
    CONSTRAINT google_lsa_leads_phone_pair
        CHECK (
            (phone_e164 IS NULL AND normalized_phone IS NULL)
            OR phone_e164 = '+1' || normalized_phone
        )
);

-- Re-application also repairs a partially applied or drifted phone constraint.
ALTER TABLE google_lsa_leads
    DROP CONSTRAINT IF EXISTS google_lsa_leads_phone_e164;
ALTER TABLE google_lsa_leads
    ADD CONSTRAINT google_lsa_leads_phone_e164
    CHECK (phone_e164 IS NULL OR phone_e164 ~ '^[+]1[0-9]{10}$');

CREATE INDEX IF NOT EXISTS idx_google_lsa_leads_company_created
    ON google_lsa_leads(company_id, provider_created_at);
CREATE INDEX IF NOT EXISTS idx_google_lsa_leads_company_phone_created
    ON google_lsa_leads(company_id, normalized_phone, provider_created_at)
    WHERE normalized_phone IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_google_lsa_leads_company_match_status
    ON google_lsa_leads(company_id, match_status, provider_created_at);

CREATE TABLE IF NOT EXISTS google_lsa_job_attributions (
    company_id          UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    lsa_lead_id         UUID NOT NULL,
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
    PRIMARY KEY (company_id, lsa_lead_id, matched_job_id),
    CONSTRAINT google_lsa_job_attributions_one_owner
        UNIQUE (company_id, matched_job_id),
    CONSTRAINT google_lsa_job_attributions_lsa_fk
        FOREIGN KEY (company_id, lsa_lead_id)
        REFERENCES google_lsa_leads(company_id, id)
        ON DELETE CASCADE,
    CONSTRAINT google_lsa_job_attributions_job_fk
        FOREIGN KEY (company_id, matched_job_id)
        REFERENCES jobs(company_id, id)
        ON DELETE CASCADE,
    CONSTRAINT google_lsa_job_attributions_contact_fk
        FOREIGN KEY (company_id, matched_contact_id)
        REFERENCES contacts(company_id, id)
        ON DELETE SET NULL (matched_contact_id),
    CONSTRAINT google_lsa_job_attributions_call_fk
        FOREIGN KEY (company_id, evidence_call_id)
        REFERENCES calls(company_id, id)
        ON DELETE SET NULL (evidence_call_id),
    CONSTRAINT google_lsa_job_attributions_lead_fk
        FOREIGN KEY (company_id, evidence_lead_id)
        REFERENCES leads(company_id, id)
        ON DELETE SET NULL (evidence_lead_id)
);

CREATE INDEX IF NOT EXISTS idx_google_lsa_job_attributions_lsa
    ON google_lsa_job_attributions(company_id, lsa_lead_id);
CREATE INDEX IF NOT EXISTS idx_google_lsa_job_attributions_contact
    ON google_lsa_job_attributions(company_id, matched_contact_id)
    WHERE matched_contact_id IS NOT NULL;

DROP TRIGGER IF EXISTS trg_google_lsa_leads_updated_at ON google_lsa_leads;
CREATE TRIGGER trg_google_lsa_leads_updated_at
    BEFORE UPDATE ON google_lsa_leads
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS trg_google_lsa_job_attributions_updated_at
    ON google_lsa_job_attributions;
CREATE TRIGGER trg_google_lsa_job_attributions_updated_at
    BEFORE UPDATE ON google_lsa_job_attributions
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Migration 213 deterministically seeded a second Google Ads channel from the
-- historical raw source. Rehome only that known alias; never merge by label.
WITH channel_pairs AS (
    SELECT
        canonical.company_id,
        canonical.id AS canonical_id,
        duplicate.id AS duplicate_id
    FROM lead_source_channels canonical
    JOIN lead_source_channels duplicate
      ON duplicate.company_id = canonical.company_id
     AND duplicate.channel_key = 'source_89e8a431de55c3822053e36c5eb21d06'
    WHERE canonical.channel_key = 'google_ads'
)
UPDATE lead_source_aliases alias
SET channel_id = pair.canonical_id,
    updated_at = NOW()
FROM channel_pairs pair
WHERE alias.company_id = pair.company_id
  AND alias.channel_id = pair.duplicate_id
  AND alias.normalized_source = 'google ads';

UPDATE lead_source_channels
SET is_active = false,
    metadata = COALESCE(metadata, '{}'::JSONB) || jsonb_build_object(
        'merged_into_channel_key', 'google_ads',
        'google_lsa_attribution_001_merged', true
    ),
    updated_at = NOW()
WHERE channel_key = 'source_89e8a431de55c3822053e36c5eb21d06'
  AND EXISTS (
      SELECT 1
      FROM lead_source_channels canonical
      WHERE canonical.company_id = lead_source_channels.company_id
        AND canonical.channel_key = 'google_ads'
  );

UPDATE marketplace_apps
SET short_description =
        'Connect Google Ads to import campaign spend and attribute Local Services Ads phone leads.',
    long_description =
        'Imports Google Ads campaign performance and Local Services Ads leads. Albusto matches high-confidence phone-call leads to CRM contacts and windowed jobs while retaining the provider lead for auditable acquisition and lifetime-value reporting.',
    metadata = COALESCE(metadata, '{}'::JSONB) || jsonb_build_object(
        'access_summary', jsonb_build_array(
            'Read Google Ads account currency and timezone',
            'Read daily campaign performance and spend',
            'Read Local Services Ads lead type, status, charged state, creation time, and caller phone number'
        ),
        'assistant', jsonb_build_object(
            'what_it_does', 'Imports Google Ads spend and Local Services Ads leads, then matches high-confidence phone calls to CRM customers and jobs for acquisition reporting.',
            'prerequisites', jsonb_build_array(
                'A Google Ads account billed in USD',
                'Google Ads API access enabled for the Albusto deployment',
                'A Google account authorized to read the Ads customer and Local Services Ads leads'
            ),
            'setup_steps', jsonb_build_array(
                'Open Settings, then Integrations, then Google Ads',
                'Ask an Albusto administrator to complete the secure account authorization',
                'Wait for the historical spend and Local Services Ads lead synchronization to finish'
            ),
            'outcome', 'Google Ads spend and high-confidence Local Services Ads phone-call attribution are synchronized for the company.',
            'recommend_when', jsonb_build_array(
                'The company buys phone leads through Google Local Services Ads',
                'The user wants Google Ads costs and resulting jobs compared',
                'The user wants auditable phone-call acquisition matching'
            ),
            'gotchas', jsonb_build_array(
                'Only Local Services Ads PHONE_CALL leads are matched in the first version',
                'Phone-only matches without nearby call or CRM lead evidence are not attributed',
                'Recent job attribution can change until the 90-day acquisition window closes'
            )
        )
    ),
    updated_at = NOW()
WHERE app_key = 'google-ads';

COMMENT ON TABLE google_lsa_leads IS
    'Tenant-owned Google Local Services Ads leads and their best deterministic CRM match.';
COMMENT ON TABLE google_lsa_job_attributions IS
    'Windowed high-confidence LSA-to-job ownership; each tenant job has at most one LSA owner.';
