-- Roll back migration 229 (APP-VIEW-001 Phase B). Safe to run repeatedly.

DROP INDEX IF EXISTS idx_app_installation_schedules_due;
DROP TABLE IF EXISTS app_installation_schedules;

CREATE OR REPLACE FUNCTION app_runtime_protect_version_artifact()
RETURNS TRIGGER AS $$
BEGIN
    IF (OLD.status <> 'draft' OR NEW.status <> 'draft') AND (
        NEW.id IS DISTINCT FROM OLD.id
        OR NEW.app_id IS DISTINCT FROM OLD.app_id
        OR NEW.version_number IS DISTINCT FROM OLD.version_number
        OR NEW.source_code IS DISTINCT FROM OLD.source_code
        OR NEW.source_sha256 IS DISTINCT FROM OLD.source_sha256
        OR NEW.scanner_report IS DISTINCT FROM OLD.scanner_report
    ) THEN
        RAISE EXCEPTION 'APP_VERSION_ARTIFACT_IMMUTABLE';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

ALTER TABLE app_versions
    DROP CONSTRAINT IF EXISTS chk_app_versions_suggested_schedule,
    DROP COLUMN IF EXISTS suggested_schedule;

DROP FUNCTION IF EXISTS app_schedule_cadence_valid(JSONB);
