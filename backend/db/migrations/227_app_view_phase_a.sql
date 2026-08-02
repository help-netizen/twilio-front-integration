-- Migration 227 — APP-VIEW-001 Phase A: trusted view results and latest pointer.

CREATE UNIQUE INDEX IF NOT EXISTS uq_marketplace_installations_company_id
    ON marketplace_installations(company_id, id);

CREATE UNIQUE INDEX IF NOT EXISTS uq_app_runs_company_installation_id
    ON app_runs(company_id, installation_id, id);

ALTER TABLE app_runs
    ADD COLUMN IF NOT EXISTS error_message TEXT;

ALTER TABLE app_runs
    DROP CONSTRAINT IF EXISTS chk_app_runs_error_message;

ALTER TABLE app_runs
    ADD CONSTRAINT chk_app_runs_error_message CHECK (
        error_message IS NULL OR char_length(error_message) BETWEEN 1 AND 500
    );

CREATE TABLE IF NOT EXISTS app_run_results (
    run_id              UUID PRIMARY KEY,
    company_id          UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    installation_id     BIGINT NOT NULL,
    view_document       JSONB NOT NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_app_run_results_context
        UNIQUE (company_id, installation_id, run_id),
    CONSTRAINT fk_app_run_results_installation
        FOREIGN KEY (company_id, installation_id)
        REFERENCES marketplace_installations(company_id, id) ON DELETE CASCADE,
    CONSTRAINT fk_app_run_results_run
        FOREIGN KEY (company_id, installation_id, run_id)
        REFERENCES app_runs(company_id, installation_id, id) ON DELETE CASCADE,
    CONSTRAINT chk_app_run_results_document_object
        CHECK (jsonb_typeof(view_document) = 'object'),
    CONSTRAINT chk_app_run_results_view_version
        CHECK (
            view_document ? 'view_version'
            AND view_document->'view_version' = '1'::jsonb
        )
);

CREATE INDEX IF NOT EXISTS idx_app_run_results_installation_created
    ON app_run_results(company_id, installation_id, created_at DESC, run_id DESC);

ALTER TABLE marketplace_installations
    ADD COLUMN IF NOT EXISTS latest_run_id UUID;

ALTER TABLE marketplace_installations
    DROP CONSTRAINT IF EXISTS fk_marketplace_installations_latest_run;

ALTER TABLE marketplace_installations
    ADD CONSTRAINT fk_marketplace_installations_latest_run
        FOREIGN KEY (company_id, id, latest_run_id)
        REFERENCES app_run_results(company_id, installation_id, run_id)
        DEFERRABLE INITIALLY DEFERRED;

COMMENT ON TABLE app_run_results IS
    'CRM-validated APP-VIEW-001 view documents; metering remains in app_runs.';
COMMENT ON COLUMN marketplace_installations.latest_run_id IS
    'Tenant-bound pointer to the newest successfully stored app view result.';
COMMENT ON COLUMN app_runs.error_message IS
    'Bounded human-readable failure reason safe to expose in app run history.';
