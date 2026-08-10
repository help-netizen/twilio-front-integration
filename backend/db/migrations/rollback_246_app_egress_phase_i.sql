-- Roll back migration 246 (APP-EGRESS-001 Phase I). Safe to run repeatedly.

DROP TABLE IF EXISTS app_installation_secrets;

ALTER TABLE app_runs
    DROP CONSTRAINT IF EXISTS chk_app_runs_egress_calls_made,
    DROP COLUMN IF EXISTS egress_calls_made;
