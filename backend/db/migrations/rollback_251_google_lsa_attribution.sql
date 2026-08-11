-- =============================================================================
-- Rollback 251: GOOGLE-LSA-ATTRIBUTION-001 T1/T2
-- =============================================================================

UPDATE marketplace_apps
SET short_description =
        'Connect Google Ads to import daily campaign spend into Albusto analytics.',
    long_description =
        'Connects one company Google Ads account and imports daily campaign cost, impressions, clicks, and conversions. Albusto automatically backfills historical spend and refreshes recent days so Google restatements are reflected.',
    metadata = COALESCE(metadata, '{}'::JSONB) || jsonb_build_object(
        'access_summary', jsonb_build_array(
            'Read Google Ads account currency and timezone',
            'Read daily campaign performance and spend'
        ),
        'assistant', jsonb_build_object(
            'what_it_does', 'Imports daily Google Ads campaign spend and performance into Albusto so acquisition analytics can show channel cost and return.',
            'prerequisites', jsonb_build_array(
                'A Google Ads account billed in USD',
                'Google Ads API access enabled for the Albusto deployment',
                'A Google account authorized to read the Ads customer'
            ),
            'setup_steps', jsonb_build_array(
                'Settings → Integrations → Google Ads',
                'Ask an Albusto administrator to complete the secure account authorization',
                'After connection, wait for the historical backfill to finish; recent spend then refreshes automatically'
            ),
            'outcome', 'Google Ads campaign spend, impressions, clicks, and conversions are synchronized daily for the company.',
            'recommend_when', jsonb_build_array(
                'User buys leads or traffic through Google Ads',
                'User wants campaign spend in acquisition analytics',
                'User wants Google Ads costs refreshed automatically'
            ),
            'gotchas', jsonb_build_array(
                'The first version supports USD accounts only',
                'A different Google Ads customer cannot replace an existing connection without an explicit migration',
                'Recent 30 days are re-read because Google may restate campaign results'
            )
        )
    ),
    updated_at = NOW()
WHERE app_key = 'google-ads';

WITH merged_duplicates AS (
    SELECT
        duplicate.company_id,
        duplicate.id AS duplicate_id,
        canonical.id AS canonical_id
    FROM lead_source_channels duplicate
    JOIN lead_source_channels canonical
      ON canonical.company_id = duplicate.company_id
     AND canonical.channel_key = 'google_ads'
    WHERE duplicate.channel_key = 'source_89e8a431de55c3822053e36c5eb21d06'
      AND duplicate.metadata->>'google_lsa_attribution_001_merged' = 'true'
)
UPDATE lead_source_aliases alias
SET channel_id = merged.duplicate_id,
    updated_at = NOW()
FROM merged_duplicates merged
WHERE alias.company_id = merged.company_id
  AND alias.channel_id = merged.canonical_id
  AND alias.normalized_source = 'google ads';

UPDATE lead_source_channels
SET is_active = true,
    metadata = COALESCE(metadata, '{}'::JSONB)
        - 'merged_into_channel_key'
        - 'google_lsa_attribution_001_merged',
    updated_at = NOW()
WHERE channel_key = 'source_89e8a431de55c3822053e36c5eb21d06'
  AND metadata->>'google_lsa_attribution_001_merged' = 'true';

DROP TRIGGER IF EXISTS trg_google_lsa_job_attributions_updated_at
    ON google_lsa_job_attributions;
DROP TRIGGER IF EXISTS trg_google_lsa_leads_updated_at ON google_lsa_leads;

DROP TABLE IF EXISTS google_lsa_job_attributions;
DROP TABLE IF EXISTS google_lsa_leads;

ALTER TABLE google_ads_connections
    DROP COLUMN IF EXISTS lsa_last_lead_count,
    DROP COLUMN IF EXISTS lsa_last_matched_at,
    DROP COLUMN IF EXISTS lsa_last_synced_at,
    DROP COLUMN IF EXISTS lsa_synced_through_at,
    DROP COLUMN IF EXISTS lsa_synced_from_at;

DROP INDEX IF EXISTS uq_calls_company_id_id_lsa;
DROP INDEX IF EXISTS uq_jobs_company_id_id_lsa;
DROP INDEX IF EXISTS uq_leads_company_id_id_lsa;
DROP INDEX IF EXISTS uq_contacts_company_id_id_lsa;
