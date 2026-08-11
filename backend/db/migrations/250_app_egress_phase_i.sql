-- Migration 250 — APP-EGRESS-001 Phase I: write-only installation secrets and egress metering.

CREATE TABLE IF NOT EXISTS app_installation_secrets (
    company_id         UUID NOT NULL,
    installation_id   BIGINT NOT NULL,
    connection_name   TEXT NOT NULL,
    ciphertext         TEXT NOT NULL,
    set_by             UUID NOT NULL,
    set_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (company_id, installation_id, connection_name),
    CONSTRAINT fk_app_installation_secrets_installation
        FOREIGN KEY (company_id, installation_id)
        REFERENCES marketplace_installations(company_id, id) ON DELETE CASCADE,
    CONSTRAINT fk_app_installation_secrets_set_by
        FOREIGN KEY (company_id, set_by)
        REFERENCES crm_users(company_id, id) ON DELETE RESTRICT,
    CONSTRAINT chk_app_installation_secrets_connection_name
        CHECK (connection_name ~ '^[a-z][a-z0-9_]{0,31}$')
);

ALTER TABLE app_runs
    ADD COLUMN IF NOT EXISTS egress_calls_made INTEGER NOT NULL DEFAULT 0;

ALTER TABLE app_runs
    DROP CONSTRAINT IF EXISTS chk_app_runs_egress_calls_made;

ALTER TABLE app_runs
    ADD CONSTRAINT chk_app_runs_egress_calls_made CHECK (
        egress_calls_made BETWEEN 0 AND 5
    );

COMMENT ON TABLE app_installation_secrets IS
    'Write-only AES-256-GCM credentials for accepted APP-EGRESS-001 connections.';
COMMENT ON COLUMN app_installation_secrets.ciphertext IS
    'APP_SECRETS_KEY encrypted iv:tag:ciphertext envelope; plaintext is never returned.';
COMMENT ON COLUMN app_runs.egress_calls_made IS
    'Authoritative separately-budgeted APP-EGRESS-001 calls consumed by this run.';
