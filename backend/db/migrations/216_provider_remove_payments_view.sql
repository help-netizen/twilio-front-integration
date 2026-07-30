-- =============================================================================
-- 216: ROLE-PROVIDER-NO-PAYMENTS-001 — hide the standalone Payments ledger from providers
--
-- The provider role no longer holds payments.view (removed from the 050 default seed
-- and the 138 backfill). This strips the grant from EXISTING provider roles across every
-- company so the change takes effect on already-provisioned tenants, not just new ones.
--
-- Idempotent / re-runnable: after the first run the rows are gone, so the DELETE is a
-- no-op. Providers keep financial_data.view + payments.collect_* — the job finance panel
-- reads a job's payments under financial_data.view (scoped to assigned jobs in the
-- payments route), so field payment collection is unaffected; only the company-wide
-- /payments ledger section + its API become inaccessible to providers.
-- =============================================================================

DELETE FROM company_role_permissions crp
USING company_role_configs rc
WHERE crp.role_config_id = rc.id
  AND rc.role_key = 'provider'
  AND crp.permission_key = 'payments.view';
