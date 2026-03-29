-- Migration 070: Add tags column to jobs table
-- Required by scheduleQueries.js which selects j.tags
-- Was missing from original schema

ALTER TABLE jobs ADD COLUMN IF NOT EXISTS tags TEXT[] DEFAULT ARRAY[]::TEXT[];

COMMENT ON COLUMN jobs.tags IS 'Array of tag labels associated with the job';
