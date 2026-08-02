-- Roll back migration 230 (APP-DATA-001 Phase D). Safe to run repeatedly.

DROP INDEX IF EXISTS idx_app_data_rows_listing;
DROP TABLE IF EXISTS app_data_rows;

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
        OR NEW.suggested_schedule IS DISTINCT FROM OLD.suggested_schedule
    ) THEN
        RAISE EXCEPTION 'APP_VERSION_ARTIFACT_IMMUTABLE';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

ALTER TABLE app_runs
    DROP CONSTRAINT IF EXISTS chk_app_runs_data_calls_made,
    DROP COLUMN IF EXISTS data_calls_made;

ALTER TABLE app_versions
    DROP CONSTRAINT IF EXISTS chk_app_versions_data_collections_envelope,
    DROP COLUMN IF EXISTS data_collections;
