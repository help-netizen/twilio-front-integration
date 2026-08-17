-- Roll back JOB-NUMBERING-001.

BEGIN;

DROP TRIGGER IF EXISTS trg_jobs_assign_identifiers ON jobs;
DROP FUNCTION IF EXISTS jobs_assign_identifiers();
DROP FUNCTION IF EXISTS job_public_code(BIGINT);

DROP TABLE IF EXISTS company_job_counters;

DROP INDEX IF EXISTS uq_jobs_company_job_seq;
DROP INDEX IF EXISTS uq_jobs_public_code;

ALTER TABLE jobs
    DROP COLUMN IF EXISTS job_seq,
    DROP COLUMN IF EXISTS public_code;

COMMIT;
