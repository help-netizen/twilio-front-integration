-- Migration 187: stable default-order indexes for unified list cursor pagination.

CREATE INDEX IF NOT EXISTS idx_lpu_leads_company_created_id
    ON leads (company_id, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_lpu_jobs_company_start_id
    ON jobs (company_id, start_date DESC NULLS LAST, id DESC);

CREATE INDEX IF NOT EXISTS idx_lpu_jobs_company_created_id
    ON jobs (company_id, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_lpu_tasks_company_status_due_created_id
    ON tasks (company_id, status, due_at ASC NULLS LAST, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_lpu_contacts_company_id
    ON contacts (company_id, id DESC);

CREATE INDEX IF NOT EXISTS idx_lpu_zb_payments_company_date_id
    ON zb_payments (company_id, payment_date DESC NULLS LAST, id DESC);
