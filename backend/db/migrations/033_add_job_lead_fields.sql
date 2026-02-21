-- =============================================================================
-- Migration 033: Add lead-like fields to jobs table (unification)
-- =============================================================================

ALTER TABLE jobs ADD COLUMN IF NOT EXISTS job_type VARCHAR(80);
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS job_source VARCHAR(80);
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS description TEXT;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}';
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS comments TEXT;

COMMENT ON COLUMN jobs.job_type IS 'Job type (same as lead job_type, from settings)';
COMMENT ON COLUMN jobs.job_source IS 'Job source (eLocals, ServiceDirect, etc.)';
COMMENT ON COLUMN jobs.description IS 'Job description / notes';
COMMENT ON COLUMN jobs.metadata IS 'Custom metadata fields from lead_custom_fields settings';
COMMENT ON COLUMN jobs.comments IS 'Internal comments';
