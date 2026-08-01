-- Migration 222 — APP-GAP-FIX-001: runtime accounting and builder retention.

ALTER TABLE app_installation_principals
    DROP CONSTRAINT IF EXISTS fk_app_runtime_principal_delegator_membership;

ALTER TABLE app_runs
    DROP CONSTRAINT IF EXISTS app_runs_status_check;

ALTER TABLE app_runs
    ADD CONSTRAINT app_runs_status_check
        CHECK (status IN ('issued', 'exhausted', 'completed', 'failed', 'revoked')),
    ADD COLUMN IF NOT EXISTS wall_ms BIGINT CHECK (wall_ms IS NULL OR wall_ms >= 0),
    ADD COLUMN IF NOT EXISTS gateway_calls_made INTEGER
        CHECK (gateway_calls_made IS NULL OR gateway_calls_made >= 0),
    ADD COLUMN IF NOT EXISTS result_bytes INTEGER
        CHECK (result_bytes IS NULL OR result_bytes >= 0),
    ADD COLUMN IF NOT EXISTS error_code TEXT,
    ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS app_runtime_installation_controls (
    company_id                  UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    app_id                      BIGINT NOT NULL REFERENCES marketplace_apps(id) ON DELETE CASCADE,
    installation_id             BIGINT NOT NULL,
    daily_gateway_call_limit    INTEGER NOT NULL DEFAULT 1000
                                    CHECK (daily_gateway_call_limit > 0),
    suspended_at                TIMESTAMPTZ,
    suspension_reason           TEXT,
    updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (company_id, app_id, installation_id),
    CONSTRAINT fk_app_runtime_controls_installation
        FOREIGN KEY (company_id, app_id, installation_id)
        REFERENCES marketplace_installations(company_id, app_id, id) ON DELETE CASCADE,
    CONSTRAINT chk_app_runtime_controls_suspension CHECK (
        (suspended_at IS NULL AND suspension_reason IS NULL)
        OR (suspended_at IS NOT NULL AND suspension_reason IS NOT NULL)
    )
);

CREATE INDEX IF NOT EXISTS idx_app_runtime_controls_suspended
    ON app_runtime_installation_controls(company_id, installation_id)
    WHERE suspended_at IS NOT NULL;

INSERT INTO app_runtime_installation_controls (company_id, app_id, installation_id)
SELECT principal.company_id, principal.app_id, principal.installation_id
FROM app_installation_principals principal
ON CONFLICT (company_id, app_id, installation_id) DO NOTHING;

CREATE OR REPLACE FUNCTION app_runtime_create_installation_control()
RETURNS TRIGGER AS $$
BEGIN
    INSERT INTO app_runtime_installation_controls (company_id, app_id, installation_id)
    VALUES (NEW.company_id, NEW.app_id, NEW.installation_id)
    ON CONFLICT (company_id, app_id, installation_id) DO NOTHING;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_app_runtime_create_installation_control
    ON app_installation_principals;
CREATE TRIGGER trg_app_runtime_create_installation_control
    AFTER INSERT ON app_installation_principals
    FOR EACH ROW EXECUTE FUNCTION app_runtime_create_installation_control();

CREATE TABLE IF NOT EXISTS app_runtime_usage (
    company_id                  UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    app_id                      BIGINT NOT NULL REFERENCES marketplace_apps(id) ON DELETE CASCADE,
    installation_id             BIGINT NOT NULL,
    usage_date                  DATE NOT NULL,
    gateway_calls_used          INTEGER NOT NULL DEFAULT 0 CHECK (gateway_calls_used >= 0),
    daily_gateway_call_limit    INTEGER NOT NULL CHECK (daily_gateway_call_limit > 0),
    updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (company_id, app_id, installation_id, usage_date),
    CONSTRAINT fk_app_runtime_usage_installation
        FOREIGN KEY (company_id, app_id, installation_id)
        REFERENCES marketplace_installations(company_id, app_id, id) ON DELETE CASCADE,
    CONSTRAINT chk_app_runtime_usage_within_limit
        CHECK (gateway_calls_used <= daily_gateway_call_limit)
);

ALTER TABLE app_build_messages
    ADD COLUMN IF NOT EXISTS retention_expires_at TIMESTAMPTZ;

UPDATE app_build_messages
SET retention_expires_at = created_at + INTERVAL '365 days'
WHERE retention_expires_at IS NULL;

ALTER TABLE app_build_messages
    ALTER COLUMN retention_expires_at SET DEFAULT (NOW() + INTERVAL '365 days'),
    ALTER COLUMN retention_expires_at SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_app_build_messages_retention
    ON app_build_messages(company_id, retention_expires_at, id);

COMMENT ON TABLE app_runtime_installation_controls IS
    'Persistent per-installation runtime ceiling and fail-closed auto-suspension state.';
COMMENT ON TABLE app_runtime_usage IS
    'UTC daily per-installation gateway usage enforced atomically in PostgreSQL.';
COMMENT ON COLUMN app_build_messages.retention_expires_at IS
    'Configured retention deadline for scrubbed builder message content; chat rows remain.';
