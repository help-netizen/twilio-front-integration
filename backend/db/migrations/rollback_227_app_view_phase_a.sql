-- Roll back migration 227 (APP-VIEW-001 Phase A). Safe to run repeatedly.

ALTER TABLE marketplace_installations
    DROP CONSTRAINT IF EXISTS fk_marketplace_installations_latest_run,
    DROP COLUMN IF EXISTS latest_run_id;

DROP INDEX IF EXISTS idx_app_run_results_installation_created;
DROP TABLE IF EXISTS app_run_results;

ALTER TABLE app_runs
    DROP CONSTRAINT IF EXISTS chk_app_runs_error_message,
    DROP COLUMN IF EXISTS error_message;

DROP INDEX IF EXISTS uq_app_runs_company_installation_id;
DROP INDEX IF EXISTS uq_marketplace_installations_company_id;
