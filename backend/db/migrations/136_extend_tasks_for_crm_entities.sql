-- =============================================================================
-- 136: Extend tasks for cross-entity CRM links (TASKS-001)
-- Adds Job / Lead / Estimate / Invoice parent FKs + an author column, and seeds
-- the tasks.* RBAC keys. `contact_id` already exists (089 → contacts).
--
-- No "exactly one parent" CHECK on purpose: it would break existing Pulse
-- (thread_id) and Sales CRM (account_id/deal_id/contact_id) rows. The /api/tasks
-- API enforces exactly-one-parent at the application layer for the 5 supported
-- types. The task text lives in the existing NOT NULL `title` column (exposed to
-- the API as `description`); `due_at` is the deadline (date+time).
-- =============================================================================

ALTER TABLE tasks
    ADD COLUMN IF NOT EXISTS job_id         BIGINT REFERENCES jobs(id)      ON DELETE CASCADE,
    ADD COLUMN IF NOT EXISTS lead_id        BIGINT REFERENCES leads(id)     ON DELETE CASCADE,
    ADD COLUMN IF NOT EXISTS estimate_id    BIGINT REFERENCES estimates(id) ON DELETE CASCADE,
    ADD COLUMN IF NOT EXISTS invoice_id     BIGINT REFERENCES invoices(id)  ON DELETE CASCADE,
    ADD COLUMN IF NOT EXISTS author_user_id UUID   REFERENCES crm_users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_tasks_company_job_due
    ON tasks(company_id, job_id, status, due_at) WHERE job_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tasks_company_lead_due
    ON tasks(company_id, lead_id, status, due_at) WHERE lead_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tasks_company_estimate_due
    ON tasks(company_id, estimate_id, status, due_at) WHERE estimate_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tasks_company_invoice_due
    ON tasks(company_id, invoice_id, status, due_at) WHERE invoice_id IS NOT NULL;

COMMENT ON COLUMN tasks.job_id IS 'TASKS-001: parent job';
COMMENT ON COLUMN tasks.lead_id IS 'TASKS-001: parent lead';
COMMENT ON COLUMN tasks.estimate_id IS 'TASKS-001: parent estimate';
COMMENT ON COLUMN tasks.invoice_id IS 'TASKS-001: parent invoice';
COMMENT ON COLUMN tasks.author_user_id IS 'TASKS-001: task author (FK crm_users.id)';

-- ─── RBAC: tasks.view / tasks.create / tasks.manage ──────────────────────────
-- admin / manager / dispatcher → all three.
INSERT INTO company_role_permissions (role_config_id, permission_key, is_allowed)
SELECT rc.id, p.key, true
FROM company_role_configs rc
CROSS JOIN (VALUES ('tasks.view'), ('tasks.create'), ('tasks.manage')) AS p(key)
WHERE rc.role_key IN ('tenant_admin', 'manager', 'dispatcher')
ON CONFLICT (role_config_id, permission_key) DO NOTHING;

-- provider (Technician) → view + create only. Acts on OWN tasks via the route's
-- ownership check; without tasks.manage the global list is scoped to own tasks.
INSERT INTO company_role_permissions (role_config_id, permission_key, is_allowed)
SELECT rc.id, p.key, true
FROM company_role_configs rc
CROSS JOIN (VALUES ('tasks.view'), ('tasks.create')) AS p(key)
WHERE rc.role_key = 'provider'
ON CONFLICT (role_config_id, permission_key) DO NOTHING;
