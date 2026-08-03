-- Roll back migration 233 (APP-DATA-001 Phase G). Safe to run repeatedly.

ALTER TABLE app_runs
    DROP CONSTRAINT IF EXISTS chk_app_runs_write_calls_made,
    DROP COLUMN IF EXISTS write_calls_made;
