-- Roll back migration 223 (APP-MOD-001). Safe to run repeatedly.

DROP TRIGGER IF EXISTS trg_app_version_transition ON app_versions;
DROP FUNCTION IF EXISTS app_version_enforce_transition();
DROP INDEX IF EXISTS idx_app_versions_review_queue;

ALTER TABLE app_versions
    DROP CONSTRAINT IF EXISTS chk_app_versions_rejection_reason,
    DROP CONSTRAINT IF EXISTS app_versions_status_check;

UPDATE app_versions
SET status = 'draft',
    reviewed_by = NULL,
    reviewed_at = NULL,
    updated_at = NOW()
WHERE status = 'rejected';

ALTER TABLE app_versions
    ADD CONSTRAINT app_versions_status_check
        CHECK (status IN (
            'draft', 'submitted', 'in_review', 'approved', 'published', 'revoked'
        )),
    DROP COLUMN IF EXISTS rejection_reason,
    DROP COLUMN IF EXISTS submitted_at;

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
