-- Migration 220 — APP-GW-001: App Studio Phase 1 read-only runtime gateway.

CREATE UNIQUE INDEX IF NOT EXISTS uq_marketplace_installations_company_app_id
    ON marketplace_installations(company_id, app_id, id);

CREATE TABLE IF NOT EXISTS app_versions (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    app_id              BIGINT NOT NULL REFERENCES marketplace_apps(id) ON DELETE CASCADE,
    version_number      TEXT NOT NULL,
    source_code         TEXT NOT NULL,
    source_sha256       CHAR(64) NOT NULL CHECK (source_sha256 ~ '^[0-9a-f]{64}$'),
    scanner_report      JSONB NOT NULL DEFAULT '{}'::jsonb,
    status              TEXT NOT NULL DEFAULT 'draft'
                            CHECK (status IN (
                                'draft', 'submitted', 'in_review', 'approved',
                                'published', 'revoked'
                            )),
    created_by          UUID REFERENCES crm_users(id) ON DELETE SET NULL,
    reviewed_by         UUID REFERENCES crm_users(id) ON DELETE SET NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    reviewed_at         TIMESTAMPTZ,
    published_at        TIMESTAMPTZ,
    CONSTRAINT uq_app_versions_app_number UNIQUE (app_id, version_number),
    CONSTRAINT uq_app_versions_app_id UNIQUE (app_id, id),
    CONSTRAINT chk_app_versions_scanner_report_object
        CHECK (jsonb_typeof(scanner_report) = 'object')
);

CREATE INDEX IF NOT EXISTS idx_app_versions_app_status
    ON app_versions(app_id, status);

CREATE OR REPLACE FUNCTION app_runtime_protect_version_artifact()
RETURNS TRIGGER AS $$
BEGIN
    IF OLD.status <> 'draft' AND (
        NEW.id IS DISTINCT FROM OLD.id
        OR NEW.app_id IS DISTINCT FROM OLD.app_id
        OR NEW.version_number IS DISTINCT FROM OLD.version_number
        OR NEW.source_code IS DISTINCT FROM OLD.source_code
        OR NEW.source_sha256 IS DISTINCT FROM OLD.source_sha256
    ) THEN
        RAISE EXCEPTION 'APP_VERSION_ARTIFACT_IMMUTABLE';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_app_versions_artifact_immutable ON app_versions;
CREATE TRIGGER trg_app_versions_artifact_immutable
    BEFORE UPDATE ON app_versions
    FOR EACH ROW EXECUTE FUNCTION app_runtime_protect_version_artifact();

CREATE TABLE IF NOT EXISTS app_version_tools (
    version_id          UUID NOT NULL REFERENCES app_versions(id) ON DELETE CASCADE,
    tool_name           TEXT NOT NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (version_id, tool_name)
);

CREATE INDEX IF NOT EXISTS idx_app_version_tools_name
    ON app_version_tools(tool_name, version_id);

CREATE OR REPLACE FUNCTION app_runtime_protect_version_tools()
RETURNS TRIGGER AS $$
DECLARE
    version_status TEXT;
BEGIN
    IF TG_OP IN ('UPDATE', 'DELETE') THEN
        SELECT status INTO version_status
        FROM app_versions
        WHERE id = OLD.version_id;
        IF version_status IS NOT NULL AND version_status <> 'draft' THEN
            RAISE EXCEPTION 'APP_VERSION_TOOLS_IMMUTABLE';
        END IF;
    END IF;

    IF TG_OP IN ('INSERT', 'UPDATE') THEN
        SELECT status INTO version_status
        FROM app_versions
        WHERE id = NEW.version_id;
        IF version_status IS NOT NULL AND version_status <> 'draft' THEN
            RAISE EXCEPTION 'APP_VERSION_TOOLS_IMMUTABLE';
        END IF;
    END IF;

    IF TG_OP = 'DELETE' THEN
        RETURN OLD;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_app_version_tools_immutable ON app_version_tools;
CREATE TRIGGER trg_app_version_tools_immutable
    BEFORE INSERT OR UPDATE OR DELETE ON app_version_tools
    FOR EACH ROW EXECUTE FUNCTION app_runtime_protect_version_tools();

CREATE TABLE IF NOT EXISTS app_installation_principals (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id              UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    app_id                  BIGINT NOT NULL REFERENCES marketplace_apps(id) ON DELETE CASCADE,
    installation_id         BIGINT NOT NULL UNIQUE,
    agent_user_id           UUID NOT NULL UNIQUE,
    delegated_by_user_id    UUID NOT NULL,
    status                  TEXT NOT NULL DEFAULT 'active'
                                CHECK (status IN ('active', 'revoked')),
    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    revoked_at              TIMESTAMPTZ,
    CONSTRAINT fk_app_runtime_principal_installation
        FOREIGN KEY (company_id, app_id, installation_id)
        REFERENCES marketplace_installations(company_id, app_id, id) ON DELETE CASCADE,
    CONSTRAINT fk_app_runtime_principal_agent
        FOREIGN KEY (company_id, agent_user_id)
        REFERENCES crm_users(company_id, id) ON DELETE RESTRICT,
    CONSTRAINT fk_app_runtime_principal_delegator_membership
        FOREIGN KEY (delegated_by_user_id, company_id)
        REFERENCES company_memberships(user_id, company_id) ON DELETE RESTRICT,
    CONSTRAINT uq_app_runtime_principal_context
        UNIQUE (company_id, app_id, installation_id, id)
);

CREATE INDEX IF NOT EXISTS idx_app_runtime_principals_delegator
    ON app_installation_principals(company_id, delegated_by_user_id);

CREATE TABLE IF NOT EXISTS app_runs (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id              UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    app_id                  BIGINT NOT NULL REFERENCES marketplace_apps(id) ON DELETE CASCADE,
    installation_id         BIGINT NOT NULL,
    version_id              UUID NOT NULL,
    principal_id            UUID NOT NULL,
    artifact_sha256         CHAR(64) NOT NULL CHECK (artifact_sha256 ~ '^[0-9a-f]{64}$'),
    nonce_sha256            CHAR(64) NOT NULL CHECK (nonce_sha256 ~ '^[0-9a-f]{64}$'),
    status                  TEXT NOT NULL DEFAULT 'issued'
                                CHECK (status IN ('issued', 'exhausted', 'revoked')),
    gateway_calls_used      INTEGER NOT NULL DEFAULT 0 CHECK (gateway_calls_used >= 0),
    gateway_call_limit      INTEGER NOT NULL DEFAULT 5 CHECK (gateway_call_limit > 0),
    issued_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at              TIMESTAMPTZ NOT NULL,
    revoked_at              TIMESTAMPTZ,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_app_runs_usage_within_limit
        CHECK (gateway_calls_used <= gateway_call_limit),
    CONSTRAINT chk_app_runs_expiry_after_issue
        CHECK (expires_at > issued_at),
    CONSTRAINT fk_app_runs_installation
        FOREIGN KEY (company_id, app_id, installation_id)
        REFERENCES marketplace_installations(company_id, app_id, id) ON DELETE CASCADE,
    CONSTRAINT fk_app_runs_version
        FOREIGN KEY (app_id, version_id)
        REFERENCES app_versions(app_id, id) ON DELETE RESTRICT,
    CONSTRAINT fk_app_runs_principal
        FOREIGN KEY (company_id, app_id, installation_id, principal_id)
        REFERENCES app_installation_principals(company_id, app_id, installation_id, id)
        ON DELETE RESTRICT,
    CONSTRAINT uq_app_runs_audit_context
        UNIQUE (company_id, app_id, installation_id, id)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_app_runs_nonce_digest
    ON app_runs(nonce_sha256);

CREATE INDEX IF NOT EXISTS idx_app_runs_installation_status
    ON app_runs(company_id, installation_id, status, expires_at);

ALTER TABLE audit_log
    ADD COLUMN IF NOT EXISTS app_id BIGINT,
    ADD COLUMN IF NOT EXISTS installation_id BIGINT,
    ADD COLUMN IF NOT EXISTS app_run_id UUID;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'chk_audit_log_app_runtime_linkage'
          AND conrelid = 'audit_log'::regclass
    ) THEN
        ALTER TABLE audit_log
            ADD CONSTRAINT chk_audit_log_app_runtime_linkage CHECK (
                (app_id IS NULL AND installation_id IS NULL AND app_run_id IS NULL)
                OR
                (company_id IS NOT NULL AND app_id IS NOT NULL
                    AND installation_id IS NOT NULL AND app_run_id IS NOT NULL)
            );
    END IF;
END $$;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'fk_audit_log_app_runtime_run'
          AND conrelid = 'audit_log'::regclass
    ) THEN
        ALTER TABLE audit_log
            ADD CONSTRAINT fk_audit_log_app_runtime_run
            FOREIGN KEY (company_id, app_id, installation_id, app_run_id)
            REFERENCES app_runs(company_id, app_id, installation_id, id)
            ON DELETE RESTRICT;
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_audit_log_app_runtime
    ON audit_log(company_id, app_id, installation_id, app_run_id, created_at DESC)
    WHERE app_run_id IS NOT NULL;

COMMENT ON TABLE app_versions IS
    'Immutable versioned app artifacts; Phase 1 reads identity and status but does not execute source.';
COMMENT ON TABLE app_version_tools IS
    'Only tool allowlist that can grant a published app version runtime access.';
COMMENT ON TABLE app_installation_principals IS
    'One tenant-bound agent principal per Marketplace installation; authority remains delegated live.';
COMMENT ON TABLE app_runs IS
    'Short-lived app runtime run-token bindings and atomic gateway call budget.';
