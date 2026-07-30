-- =============================================================================
-- Rollback 216: ROLE-PROVIDER-NO-PAYMENTS-001
--
-- Re-grant payments.view to every provider role (restores the standalone Payments
-- ledger access). Note: to fully revert you must also restore the ('payments.view')
-- lines removed from migrations 050 and 138, else the next deploy re-runs 138 and
-- the onboarding bootstrap re-reads 050 without the grant.
-- =============================================================================

INSERT INTO company_role_permissions (role_config_id, permission_key, is_allowed)
SELECT rc.id, 'payments.view', true
FROM company_role_configs rc
WHERE rc.role_key = 'provider'
ON CONFLICT (role_config_id, permission_key) DO UPDATE SET is_allowed = true;
