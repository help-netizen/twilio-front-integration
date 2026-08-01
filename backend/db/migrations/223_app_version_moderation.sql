-- Migration 223 — APP-MOD-001: serialized moderation and version transitions.

ALTER TABLE app_versions
    DROP CONSTRAINT IF EXISTS app_versions_status_check;

ALTER TABLE app_versions
    ADD CONSTRAINT app_versions_status_check
        CHECK (status IN (
            'draft', 'submitted', 'in_review', 'approved', 'rejected',
            'published', 'revoked'
        )),
    ADD COLUMN IF NOT EXISTS submitted_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS rejection_reason TEXT;

ALTER TABLE app_versions
    DROP CONSTRAINT IF EXISTS chk_app_versions_rejection_reason;

ALTER TABLE app_versions
    ADD CONSTRAINT chk_app_versions_rejection_reason CHECK (
        (status = 'rejected'
            AND rejection_reason IS NOT NULL
            AND char_length(btrim(rejection_reason)) BETWEEN 1 AND 2000)
        OR (status <> 'rejected' AND rejection_reason IS NULL)
    );

CREATE INDEX IF NOT EXISTS idx_app_versions_review_queue
    ON app_versions(status, submitted_at, id)
    WHERE status IN ('submitted', 'in_review', 'approved', 'published');

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

CREATE OR REPLACE FUNCTION app_version_enforce_transition()
RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        IF NEW.status <> 'draft' THEN
            RAISE EXCEPTION 'APP_VERSION_INITIAL_STATUS_INVALID';
        END IF;
        RETURN NEW;
    END IF;

    IF NEW.status IS DISTINCT FROM OLD.status THEN
        IF current_setting('app.version_transition_service', true)
                IS DISTINCT FROM 'enabled' THEN
            RAISE EXCEPTION 'APP_VERSION_TRANSITION_SERVICE_REQUIRED';
        END IF;

        IF NOT (
            (OLD.status = 'draft' AND NEW.status = 'submitted')
            OR (OLD.status = 'submitted' AND NEW.status = 'in_review')
            OR (OLD.status = 'in_review' AND NEW.status = 'approved')
            OR (OLD.status = 'in_review' AND NEW.status = 'rejected')
            OR (OLD.status = 'approved' AND NEW.status = 'published')
            OR (OLD.status = 'published' AND NEW.status = 'revoked')
        ) THEN
            RAISE EXCEPTION 'APP_VERSION_TRANSITION_INVALID';
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_app_version_transition ON app_versions;
CREATE TRIGGER trg_app_version_transition
    BEFORE INSERT OR UPDATE OF status ON app_versions
    FOR EACH ROW EXECUTE FUNCTION app_version_enforce_transition();

CREATE OR REPLACE FUNCTION app_runtime_protect_version_tools()
RETURNS TRIGGER AS $$
DECLARE
    parent RECORD;
BEGIN
    FOR parent IN
        SELECT version.id, version.status
        FROM app_versions version
        WHERE version.id IN (
            CASE WHEN TG_OP IN ('UPDATE', 'DELETE') THEN OLD.version_id ELSE NULL END,
            CASE WHEN TG_OP IN ('INSERT', 'UPDATE') THEN NEW.version_id ELSE NULL END
        )
        ORDER BY version.id
        FOR UPDATE
    LOOP
        IF parent.status <> 'draft' THEN
            RAISE EXCEPTION 'APP_VERSION_TOOLS_IMMUTABLE';
        END IF;
    END LOOP;

    IF TG_OP = 'DELETE' THEN
        RETURN OLD;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

COMMENT ON COLUMN app_versions.submitted_at IS
    'Timestamp of the immutable artifact submission entering moderation.';
COMMENT ON COLUMN app_versions.rejection_reason IS
    'Required bounded super-admin reason retained on rejected evidence.';

