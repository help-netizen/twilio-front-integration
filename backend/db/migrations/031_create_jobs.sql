-- =============================================================================
-- Migration 031: Create jobs table (local Blanc storage + Zenbooker sync)
-- =============================================================================

CREATE TABLE IF NOT EXISTS jobs (
    id                  BIGSERIAL PRIMARY KEY,
    lead_id             BIGINT REFERENCES leads(id) ON DELETE SET NULL,
    contact_id          BIGINT REFERENCES contacts(id) ON DELETE SET NULL,
    zenbooker_job_id    TEXT UNIQUE,

    -- FSM
    blanc_status        VARCHAR(80) NOT NULL DEFAULT 'Submitted',
    zb_status           VARCHAR(40) DEFAULT 'scheduled',
    zb_rescheduled      BOOLEAN NOT NULL DEFAULT false,
    zb_canceled         BOOLEAN NOT NULL DEFAULT false,

    -- Cached Zenbooker data
    job_number          TEXT,
    service_name        TEXT,
    start_date          TIMESTAMPTZ,
    end_date            TIMESTAMPTZ,
    customer_name       TEXT,
    customer_phone      TEXT,
    customer_email      TEXT,
    address             TEXT,
    territory           TEXT,
    invoice_total       TEXT,
    invoice_status      TEXT,
    assigned_techs      JSONB DEFAULT '[]',
    notes               JSONB DEFAULT '[]',
    zb_raw              JSONB DEFAULT '{}',

    company_id          UUID,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_jobs_lead_id ON jobs(lead_id);
CREATE INDEX IF NOT EXISTS idx_jobs_contact_id ON jobs(contact_id);
CREATE INDEX IF NOT EXISTS idx_jobs_zenbooker_job_id ON jobs(zenbooker_job_id);
CREATE INDEX IF NOT EXISTS idx_jobs_blanc_status ON jobs(blanc_status);
CREATE INDEX IF NOT EXISTS idx_jobs_start_date ON jobs(start_date DESC);
CREATE INDEX IF NOT EXISTS idx_jobs_created_at ON jobs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_jobs_company_id ON jobs(company_id);

COMMENT ON TABLE jobs IS 'Local Blanc jobs storage with Zenbooker sync';

-- Auto-update trigger
CREATE TRIGGER trg_jobs_updated_at BEFORE UPDATE ON jobs
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
