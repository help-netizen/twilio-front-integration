-- =============================================================================
-- Rollback migration 174: CRM-expert assistant storage and spend controls.
-- =============================================================================

DROP TABLE IF EXISTS assistant_usage_counters;
DROP TABLE IF EXISTS assistant_transcripts;
