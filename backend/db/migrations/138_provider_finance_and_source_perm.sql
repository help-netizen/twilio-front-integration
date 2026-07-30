-- =============================================================================
-- Migration 138: PROVIDER-FINANCE-001 + SOURCE-PERM-001
--
-- Backfill for EXISTING companies (050 covers new companies via the onboarding
-- bootstrap that re-reads 050 wholesale). Idempotent / re-runnable — existing
-- roles never auto-inherit new permission keys, so each grant is explicit.
--
--   A) provider (Technician): self-serve finance — view/create/send estimates &
--      invoices, and collect via every surface (online, offline, keyed, terminal).
--      Deliberately NO payments.refund. ROLE-PROVIDER-NO-PAYMENTS-001: also NO
--      payments.view — the standalone Payments ledger is hidden from providers;
--      the job finance panel reads payments under financial_data.view instead.
--      (payments.collect_terminal was already granted to provider by mig 118;
--       repeated here for a self-contained backfill — ON CONFLICT makes it a no-op.)
--   B) NEW permission key lead_source.view → tenant_admin, manager, dispatcher.
--      NOT granted to provider — that is how the marketing source is hidden
--      from field technicians.
-- =============================================================================

-- ─── A) Provider finance grants ──────────────────────────────────────────────
INSERT INTO company_role_permissions (role_config_id, permission_key, is_allowed)
SELECT rc.id, p.key, true
FROM company_role_configs rc
CROSS JOIN (VALUES
    ('financial_data.view'),
    ('estimates.view'), ('estimates.create'), ('estimates.send'),
    ('invoices.view'), ('invoices.create'), ('invoices.send'),
    ('payments.collect_online'), ('payments.collect_offline'),
    ('payments.collect_keyed'), ('payments.collect_terminal')
) AS p(key)
WHERE rc.role_key = 'provider'
ON CONFLICT (role_config_id, permission_key) DO NOTHING;

-- ─── B) lead_source.view for the office roles (NOT provider) ──────────────────
INSERT INTO company_role_permissions (role_config_id, permission_key, is_allowed)
SELECT rc.id, p.key, true
FROM company_role_configs rc
CROSS JOIN (VALUES
    ('lead_source.view')
) AS p(key)
WHERE rc.role_key IN ('tenant_admin', 'manager', 'dispatcher')
ON CONFLICT (role_config_id, permission_key) DO NOTHING;
