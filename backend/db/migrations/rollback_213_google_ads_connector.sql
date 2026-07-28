-- =============================================================================
-- Rollback 213: LEAD-CHANNEL-ANALYTICS-001 Chunk 1b, Phase A
-- =============================================================================

DELETE FROM marketplace_apps
WHERE app_key = 'google-ads';

DROP TRIGGER IF EXISTS trg_lead_source_performance_daily_updated_at
    ON lead_source_performance_daily;
DROP TRIGGER IF EXISTS trg_google_ads_connections_updated_at
    ON google_ads_connections;

DROP TABLE IF EXISTS lead_source_performance_daily;
DROP TABLE IF EXISTS google_ads_connections;

DELETE FROM lead_source_channels
WHERE channel_key = 'google_ads';
