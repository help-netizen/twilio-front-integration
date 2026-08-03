-- Migration 233 — APP-DATA-001 Phase G: separately-metered app runtime writes.

ALTER TABLE app_runs
    ADD COLUMN IF NOT EXISTS write_calls_made INTEGER NOT NULL DEFAULT 0;

ALTER TABLE app_runs
    DROP CONSTRAINT IF EXISTS chk_app_runs_write_calls_made;

ALTER TABLE app_runs
    ADD CONSTRAINT chk_app_runs_write_calls_made CHECK (
        write_calls_made BETWEEN 0 AND 3
    );

COMMENT ON COLUMN app_runs.write_calls_made IS
    'Authoritative APP-DATA-001 Phase G write calls consumed by this run; separately capped at three.';
