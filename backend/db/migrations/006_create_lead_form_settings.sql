-- 006_create_lead_form_settings.sql
-- Lead Form customization: job types + custom metadata fields

-- ── Job Types (ordered list) ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS lead_job_types (
    id          BIGSERIAL   PRIMARY KEY,
    name        TEXT        NOT NULL UNIQUE,
    sort_order  INT         NOT NULL DEFAULT 0,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE lead_job_types IS 'Configurable list of job types for leads';

-- ── Custom Metadata Fields ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS lead_custom_fields (
    id           BIGSERIAL   PRIMARY KEY,
    display_name TEXT        NOT NULL,
    api_name     TEXT        NOT NULL UNIQUE,
    field_type   TEXT        NOT NULL DEFAULT 'text'
                             CHECK (field_type IN ('text', 'textarea', 'number', 'file', 'richtext')),
    is_system    BOOLEAN     NOT NULL DEFAULT false,
    sort_order   INT         NOT NULL DEFAULT 0,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE lead_custom_fields IS 'Lead form field definitions (system + custom)';

-- ── Seed system fields ──────────────────────────────────────────────────────
INSERT INTO lead_custom_fields (display_name, api_name, field_type, is_system, sort_order) VALUES
    ('Job Source',    'job_source',    'text',      true,  0),
    ('Created Date',  'created_date',  'text',      true,  1)
ON CONFLICT (api_name) DO NOTHING;

-- ── Seed default job types ──────────────────────────────────────────────────
INSERT INTO lead_job_types (name, sort_order) VALUES
    ('Plumbing',          0),
    ('HVAC',              1),
    ('Electrical',        2),
    ('Appliance Repair',  3)
ON CONFLICT (name) DO NOTHING;
