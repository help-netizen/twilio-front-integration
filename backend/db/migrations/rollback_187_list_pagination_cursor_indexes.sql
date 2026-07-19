-- Rollback 187: remove unified list cursor pagination indexes.

DROP INDEX IF EXISTS idx_lpu_leads_company_created_id;
DROP INDEX IF EXISTS idx_lpu_jobs_company_start_id;
DROP INDEX IF EXISTS idx_lpu_jobs_company_created_id;
DROP INDEX IF EXISTS idx_lpu_tasks_company_status_due_created_id;
DROP INDEX IF EXISTS idx_lpu_contacts_company_id;
DROP INDEX IF EXISTS idx_lpu_zb_payments_company_date_id;
