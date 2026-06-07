-- =============================================================================
-- 089: Extend tasks for Sales CRM entity links (CRM-SALES-MCP-000)
-- Preserves existing Pulse thread task behavior while allowing sales tasks.
-- =============================================================================

ALTER TABLE tasks
    ALTER COLUMN thread_id DROP NOT NULL,
    ADD COLUMN IF NOT EXISTS account_id BIGINT REFERENCES crm_accounts(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS deal_id BIGINT REFERENCES crm_deals(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS contact_id BIGINT REFERENCES contacts(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_tasks_company_account_status
    ON tasks(company_id, account_id, status, due_at) WHERE account_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_tasks_company_deal_status
    ON tasks(company_id, deal_id, status, due_at) WHERE deal_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_tasks_company_contact_status
    ON tasks(company_id, contact_id, status, due_at) WHERE contact_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_tasks_company_owner_due
    ON tasks(company_id, owner_user_id, due_at) WHERE owner_user_id IS NOT NULL;

COMMENT ON COLUMN tasks.account_id IS 'CRM-SALES-MCP-000: optional Sales CRM account task link';
COMMENT ON COLUMN tasks.deal_id IS 'CRM-SALES-MCP-000: optional Sales CRM deal task link';
COMMENT ON COLUMN tasks.contact_id IS 'CRM-SALES-MCP-000: optional Sales CRM contact task link';
