-- Roll back migration 224. Safe to run repeatedly.

DROP INDEX IF EXISTS idx_app_runs_execution_authorized;

ALTER TABLE app_runtime_usage
    DROP CONSTRAINT IF EXISTS chk_app_runtime_usage_run_limit,
    DROP COLUMN IF EXISTS daily_wall_ms_limit,
    DROP COLUMN IF EXISTS wall_ms_used,
    DROP COLUMN IF EXISTS daily_run_limit,
    DROP COLUMN IF EXISTS runs_started;

ALTER TABLE app_runtime_installation_controls
    DROP COLUMN IF EXISTS daily_wall_ms_limit,
    DROP COLUMN IF EXISTS daily_run_limit;

ALTER TABLE app_runs
    DROP COLUMN IF EXISTS execution_authorized_at;
