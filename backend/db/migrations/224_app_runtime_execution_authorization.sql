-- Migration 224 — APP-STUDIO final gap closure: authoritative execution admission.

ALTER TABLE app_runs
    ADD COLUMN IF NOT EXISTS execution_authorized_at TIMESTAMPTZ;

ALTER TABLE app_runtime_installation_controls
    ADD COLUMN IF NOT EXISTS daily_run_limit INTEGER NOT NULL DEFAULT 1000
        CHECK (daily_run_limit > 0),
    ADD COLUMN IF NOT EXISTS daily_wall_ms_limit BIGINT NOT NULL DEFAULT 600000
        CHECK (daily_wall_ms_limit > 0);

ALTER TABLE app_runtime_usage
    ADD COLUMN IF NOT EXISTS runs_started INTEGER NOT NULL DEFAULT 0
        CHECK (runs_started >= 0),
    ADD COLUMN IF NOT EXISTS daily_run_limit INTEGER NOT NULL DEFAULT 1000
        CHECK (daily_run_limit > 0),
    ADD COLUMN IF NOT EXISTS wall_ms_used BIGINT NOT NULL DEFAULT 0
        CHECK (wall_ms_used >= 0),
    ADD COLUMN IF NOT EXISTS daily_wall_ms_limit BIGINT NOT NULL DEFAULT 600000
        CHECK (daily_wall_ms_limit > 0);

ALTER TABLE app_runtime_usage
    DROP CONSTRAINT IF EXISTS chk_app_runtime_usage_run_limit;

ALTER TABLE app_runtime_usage
    ADD CONSTRAINT chk_app_runtime_usage_run_limit
        CHECK (runs_started <= daily_run_limit);

CREATE INDEX IF NOT EXISTS idx_app_runs_execution_authorized
    ON app_runs(company_id, installation_id, execution_authorized_at)
    WHERE execution_authorized_at IS NOT NULL;

COMMENT ON COLUMN app_runs.execution_authorized_at IS
    'One-time CRM admission proving the live run token, artifact hash, consent, and delegated authority before isolate compilation.';
COMMENT ON COLUMN app_runtime_installation_controls.daily_run_limit IS
    'UTC daily execution-start ceiling; exceeding it atomically suspends the installation.';
COMMENT ON COLUMN app_runtime_installation_controls.daily_wall_ms_limit IS
    'UTC daily runner wall-time ceiling in milliseconds; exceeding it atomically suspends the installation.';
