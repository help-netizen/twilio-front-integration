-- Migration 229 — APP-VIEW-001 Phase B: tenant schedules and version suggestions.

CREATE OR REPLACE FUNCTION app_schedule_cadence_valid(value JSONB)
RETURNS BOOLEAN
LANGUAGE SQL
IMMUTABLE
AS $$
    SELECT CASE
        WHEN jsonb_typeof(value) <> 'object'
          OR jsonb_typeof(value->'kind') <> 'string' THEN false
        WHEN value->>'kind' = 'every_minutes' THEN
            value - ARRAY['kind', 'n']::text[] = '{}'::jsonb
            AND jsonb_typeof(value->'n') = 'number'
            AND value->>'n' ~ '^[0-9]+$'
            AND (value->>'n')::integer BETWEEN 1 AND 1440
        WHEN value->>'kind' = 'hourly' THEN
            value - ARRAY['kind', 'minute']::text[] = '{}'::jsonb
            AND jsonb_typeof(value->'minute') = 'number'
            AND value->>'minute' ~ '^[0-9]+$'
            AND (value->>'minute')::integer BETWEEN 0 AND 59
        WHEN value->>'kind' = 'daily' THEN
            value - ARRAY['kind', 'at']::text[] = '{}'::jsonb
            AND jsonb_typeof(value->'at') = 'string'
            AND value->>'at' ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
        WHEN value->>'kind' = 'weekly' THEN
            value - ARRAY['kind', 'dow', 'at']::text[] = '{}'::jsonb
            AND jsonb_typeof(value->'dow') = 'number'
            AND value->>'dow' ~ '^[0-9]+$'
            AND (value->>'dow')::integer BETWEEN 0 AND 6
            AND jsonb_typeof(value->'at') = 'string'
            AND value->>'at' ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
        WHEN value->>'kind' = 'monthly' THEN
            value - ARRAY['kind', 'dom', 'at']::text[] = '{}'::jsonb
            AND jsonb_typeof(value->'dom') = 'number'
            AND value->>'dom' ~ '^[0-9]+$'
            AND (value->>'dom')::integer BETWEEN 1 AND 31
            AND jsonb_typeof(value->'at') = 'string'
            AND value->>'at' ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
        ELSE false
    END
$$;

ALTER TABLE app_versions
    ADD COLUMN IF NOT EXISTS suggested_schedule JSONB;

ALTER TABLE app_versions
    DROP CONSTRAINT IF EXISTS chk_app_versions_suggested_schedule;

ALTER TABLE app_versions
    ADD CONSTRAINT chk_app_versions_suggested_schedule CHECK (
        suggested_schedule IS NULL OR app_schedule_cadence_valid(suggested_schedule)
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
    ) THEN
        RAISE EXCEPTION 'APP_VERSION_ARTIFACT_IMMUTABLE';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TABLE IF NOT EXISTS app_installation_schedules (
    installation_id     BIGINT PRIMARY KEY,
    company_id          UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    enabled             BOOLEAN NOT NULL DEFAULT false,
    cadence             JSONB,
    next_run_at         TIMESTAMPTZ,
    last_run_at         TIMESTAMPTZ,
    last_status         TEXT CHECK (
        last_status IS NULL OR last_status IN (
            'pending', 'running', 'succeeded', 'failed', 'skipped',
            'suspended', 'disabled'
        )
    ),
    failure_count       INTEGER NOT NULL DEFAULT 0 CHECK (failure_count >= 0),
    suspended_reason    TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT fk_app_installation_schedules_installation
        FOREIGN KEY (company_id, installation_id)
        REFERENCES marketplace_installations(company_id, id) ON DELETE CASCADE,
    CONSTRAINT chk_app_installation_schedules_cadence
        CHECK (cadence IS NULL OR app_schedule_cadence_valid(cadence)),
    CONSTRAINT chk_app_installation_schedules_enabled
        CHECK (NOT enabled OR (cadence IS NOT NULL AND next_run_at IS NOT NULL)),
    CONSTRAINT chk_app_installation_schedules_suspension
        CHECK (suspended_reason IS NULL OR NOT enabled)
);

CREATE INDEX IF NOT EXISTS idx_app_installation_schedules_due
    ON app_installation_schedules(next_run_at, company_id, installation_id)
    WHERE enabled;

COMMENT ON TABLE app_installation_schedules IS
    'Company-timezone APP-VIEW-001 schedules; due windows are claimed once and never backfilled.';
COMMENT ON COLUMN app_versions.suggested_schedule IS
    'Optional immutable closed-vocabulary cadence suggested by this approved version.';
