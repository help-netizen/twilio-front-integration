-- 008: Add zenbooker_job_id to leads table
ALTER TABLE leads ADD COLUMN IF NOT EXISTS zenbooker_job_id TEXT;
