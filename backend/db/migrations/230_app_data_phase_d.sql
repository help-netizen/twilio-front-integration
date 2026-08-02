-- Migration 230 — APP-DATA-001 Phase D: per-installation application data.

ALTER TABLE app_versions
    ADD COLUMN IF NOT EXISTS data_collections JSONB NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE app_versions
    DROP CONSTRAINT IF EXISTS chk_app_versions_data_collections_envelope;

ALTER TABLE app_versions
    ADD CONSTRAINT chk_app_versions_data_collections_envelope CHECK (
        jsonb_typeof(data_collections) = 'array'
        AND jsonb_array_length(data_collections) <= 4
    );

ALTER TABLE app_runs
    ADD COLUMN IF NOT EXISTS data_calls_made INTEGER NOT NULL DEFAULT 0;

ALTER TABLE app_runs
    DROP CONSTRAINT IF EXISTS chk_app_runs_data_calls_made;

ALTER TABLE app_runs
    ADD CONSTRAINT chk_app_runs_data_calls_made CHECK (
        data_calls_made BETWEEN 0 AND 10
    );

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
        OR NEW.data_collections IS DISTINCT FROM OLD.data_collections
    ) THEN
        RAISE EXCEPTION 'APP_VERSION_ARTIFACT_IMMUTABLE';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TABLE IF NOT EXISTS app_data_rows (
    company_id         UUID NOT NULL,
    installation_id   BIGINT NOT NULL,
    collection        TEXT NOT NULL,
    row_key           TEXT NOT NULL,
    data              JSONB NOT NULL,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (company_id, installation_id, collection, row_key),
    CONSTRAINT fk_app_data_rows_installation
        FOREIGN KEY (company_id, installation_id)
        REFERENCES marketplace_installations(company_id, id) ON DELETE CASCADE,
    CONSTRAINT chk_app_data_rows_collection_length
        CHECK (char_length(collection) BETWEEN 1 AND 64),
    CONSTRAINT chk_app_data_rows_row_key_length
        CHECK (char_length(row_key) BETWEEN 1 AND 256),
    CONSTRAINT chk_app_data_rows_data_object
        CHECK (jsonb_typeof(data) = 'object')
);

CREATE INDEX IF NOT EXISTS idx_app_data_rows_listing
    ON app_data_rows(company_id, installation_id, collection, updated_at DESC);

COMMENT ON TABLE app_data_rows IS
    'APP-DATA-001 memory partitioned by company and Marketplace installation.';
COMMENT ON COLUMN app_versions.data_collections IS
    'Immutable validated per-version declarations for APP-DATA-001 collections.';
COMMENT ON COLUMN app_runs.data_calls_made IS
    'Authoritative separately-budgeted APP-DATA-001 calls consumed by this run.';
COMMENT ON COLUMN app_data_rows.data IS
    'The 20 MB installation limit uses sum(octet_length(data::text)) inside the write transaction.';
