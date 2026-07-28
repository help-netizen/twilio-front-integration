-- =============================================================================
-- Rollback 212: LEAD-CHANNEL-ANALYTICS-001 Chunk 1a
-- =============================================================================

DROP TRIGGER IF EXISTS trg_jobs_capture_funnel_milestones ON jobs;
DROP TRIGGER IF EXISTS trg_leads_capture_conversion_milestone ON leads;

DROP FUNCTION IF EXISTS capture_job_funnel_milestones();
DROP FUNCTION IF EXISTS capture_lead_conversion_milestone();

DROP INDEX IF EXISTS idx_calls_company_contact_started_analytics;
DROP INDEX IF EXISTS idx_jobs_company_lead_analytics;
DROP INDEX IF EXISTS idx_leads_company_contact_created_analytics;
DROP INDEX IF EXISTS idx_leads_company_created_at_analytics;

ALTER TABLE jobs
    DROP COLUMN IF EXISTS repair_done_at,
    DROP COLUMN IF EXISTS visit_completed_at;

ALTER TABLE leads
    DROP COLUMN IF EXISTS converted_at;

DROP TABLE IF EXISTS lead_source_aliases;
DROP TABLE IF EXISTS lead_source_channels;
