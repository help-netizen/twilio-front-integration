-- =============================================================================
-- Rollback 252: ELOCAL-ATTRIBUTION-001
-- =============================================================================

WITH merged_aliases AS (
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
     AND duplicate.metadata->>'elocal_attribution_001_merged' = 'true'
    WHERE canonical.channel_key = 'elocal'
)
UPDATE lead_source_aliases alias
SET channel_id = merged.duplicate_id,
    updated_at = NOW()
FROM merged_aliases merged
WHERE alias.company_id = merged.company_id
  AND alias.channel_id = merged.canonical_id
  AND (
      (merged.duplicate_key = 'source_04a1ea464d394d519efd30a5988341f8'
       AND alias.normalized_source = 'elocal')
      OR
      (merged.duplicate_key = 'source_88cdf671ddacd95240fc98b1eef48ec2'
       AND alias.normalized_source = 'elocals')
  );

UPDATE lead_source_channels
SET is_active = true,
    metadata = COALESCE(metadata, '{}'::JSONB)
        - 'merged_into_channel_key'
        - 'elocal_attribution_001_merged',
    updated_at = NOW()
WHERE channel_key IN (
    'source_04a1ea464d394d519efd30a5988341f8',
    'source_88cdf671ddacd95240fc98b1eef48ec2'
)
  AND metadata->>'elocal_attribution_001_merged' = 'true';

DROP TRIGGER IF EXISTS trg_elocal_job_attributions_updated_at
    ON elocal_job_attributions;
DROP TRIGGER IF EXISTS trg_elocal_leads_updated_at ON elocal_leads;
DROP TRIGGER IF EXISTS trg_elocal_connections_updated_at ON elocal_connections;

DROP TABLE IF EXISTS elocal_job_attributions;
DROP TABLE IF EXISTS elocal_leads;
DROP TABLE IF EXISTS elocal_connections;

DELETE FROM lead_source_channels
WHERE channel_key = 'elocal'
  AND metadata->>'elocal_attribution_001_created' = 'true';
