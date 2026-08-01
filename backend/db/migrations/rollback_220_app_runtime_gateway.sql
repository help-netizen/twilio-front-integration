-- Roll back migration 220 (APP-GW-001). Safe to run repeatedly.

ALTER TABLE audit_log
    DROP CONSTRAINT IF EXISTS fk_audit_log_app_runtime_run,
    DROP CONSTRAINT IF EXISTS chk_audit_log_app_runtime_linkage;

DROP INDEX IF EXISTS idx_audit_log_app_runtime;

ALTER TABLE audit_log
    DROP COLUMN IF EXISTS app_run_id,
    DROP COLUMN IF EXISTS installation_id,
    DROP COLUMN IF EXISTS app_id;

DROP TABLE IF EXISTS app_runs;
DROP TABLE IF EXISTS app_installation_principals;
DROP TABLE IF EXISTS app_version_tools;
DROP TABLE IF EXISTS app_versions;

DROP FUNCTION IF EXISTS app_runtime_protect_version_tools();
DROP FUNCTION IF EXISTS app_runtime_protect_version_artifact();

DROP INDEX IF EXISTS uq_marketplace_installations_company_app_id;
