-- =============================================================================
-- Migration 004: Create leads + lead_team_assignments tables
-- Self-contained Workiz-compatible leads storage
-- =============================================================================

-- 1. leads — Main leads table
CREATE TABLE IF NOT EXISTS leads (
    id                  BIGSERIAL PRIMARY KEY,
    uuid                VARCHAR(20) NOT NULL UNIQUE,
    serial_id           SERIAL,
    status              VARCHAR(80) NOT NULL DEFAULT 'Submitted',
    sub_status          VARCHAR(80),
    lead_lost           BOOLEAN NOT NULL DEFAULT false,

    -- Contact
    first_name          VARCHAR(80),
    last_name           VARCHAR(80),
    company             VARCHAR(120),
    phone               VARCHAR(30),
    phone_ext           VARCHAR(10),
    second_phone        VARCHAR(30),
    second_phone_ext    VARCHAR(10),
    email               VARCHAR(200),

    -- Address
    address             VARCHAR(200),
    unit                VARCHAR(20),
    city                VARCHAR(80),
    state               VARCHAR(80),
    postal_code         VARCHAR(20),
    country             VARCHAR(10),
    latitude            NUMERIC(10,7),
    longitude           NUMERIC(10,7),

    -- Job
    job_type            VARCHAR(80),
    job_source          VARCHAR(80),
    referral_company    VARCHAR(120),
    timezone            VARCHAR(50),
    lead_notes          TEXT,
    comments            TEXT,
    tags                TEXT[],

    -- Dates
    lead_date_time      TIMESTAMPTZ,
    lead_end_date_time  TIMESTAMPTZ,
    payment_due_date    TIMESTAMPTZ,

    -- Converted
    converted_to_job    BOOLEAN NOT NULL DEFAULT false,

    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_leads_status ON leads(status);
CREATE INDEX IF NOT EXISTS idx_leads_lead_lost ON leads(lead_lost);
CREATE INDEX IF NOT EXISTS idx_leads_lead_date_time ON leads(lead_date_time DESC);
CREATE INDEX IF NOT EXISTS idx_leads_phone ON leads(phone) WHERE phone IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_leads_serial_id ON leads(serial_id);
CREATE INDEX IF NOT EXISTS idx_leads_created_at ON leads(created_at DESC);

COMMENT ON TABLE leads IS 'Self-contained leads storage (Workiz-compatible schema)';

-- 2. lead_team_assignments — Many-to-many team/user assignments
CREATE TABLE IF NOT EXISTS lead_team_assignments (
    id          BIGSERIAL PRIMARY KEY,
    lead_id     BIGINT NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
    user_name   TEXT NOT NULL,
    assigned_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_lead_team ON lead_team_assignments(lead_id, user_name);

COMMENT ON TABLE lead_team_assignments IS 'Team/user assignments for leads';

-- 3. Auto-update trigger (reuses existing function from v3_schema)
CREATE TRIGGER trg_leads_updated_at BEFORE UPDATE ON leads
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
