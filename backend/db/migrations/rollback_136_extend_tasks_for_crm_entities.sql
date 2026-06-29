-- Rollback 136 — TASKS-001
DELETE FROM company_role_permissions WHERE permission_key IN ('tasks.view', 'tasks.create', 'tasks.manage');

DROP INDEX IF EXISTS idx_tasks_company_job_due;
DROP INDEX IF EXISTS idx_tasks_company_lead_due;
DROP INDEX IF EXISTS idx_tasks_company_estimate_due;
DROP INDEX IF EXISTS idx_tasks_company_invoice_due;

ALTER TABLE tasks
    DROP COLUMN IF EXISTS job_id,
    DROP COLUMN IF EXISTS lead_id,
    DROP COLUMN IF EXISTS estimate_id,
    DROP COLUMN IF EXISTS invoice_id,
    DROP COLUMN IF EXISTS author_user_id;
