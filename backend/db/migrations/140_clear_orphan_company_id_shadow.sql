-- =============================================================================
-- Migration 140: ONBOARD-FIX-001 (SEC) — neutralize the crm_users.company_id
-- "shadow" that enabled cross-tenant exposure.
--
-- Migration 012 backfilled crm_users.company_id → the seed company
-- (00000000-0000-0000-0000-000000000001, "Boston Masters") for every NULL row.
-- Combined with the (now-removed) requireCompanyAccess fallback
-- `req.authz?.company?.id || req.user?.company_id`, any user carrying that shadow
-- but with NO active membership resolved to the seed company and could read its
-- data. Tenant scope is now membership-only (company_memberships); the shadow
-- column is no longer consulted for access.
--
-- This migration clears crm_users.company_id wherever it is NOT backed by a real
-- active membership in that same company, so no future code path can leak on it.
-- It preserves the shadow where it correctly mirrors an active membership.
-- Idempotent / re-runnable. Logs how many rows it touched.
-- =============================================================================
DO $$
DECLARE
    affected INTEGER;
BEGIN
    SELECT count(*) INTO affected
    FROM crm_users u
    WHERE u.company_id IS NOT NULL
      AND NOT EXISTS (
          SELECT 1 FROM company_memberships m
          WHERE m.user_id = u.id
            AND m.company_id = u.company_id
            AND m.status = 'active'
      );

    RAISE NOTICE 'ONBOARD-FIX-001: clearing crm_users.company_id for % user(s) with no matching active membership', affected;

    UPDATE crm_users u
    SET company_id = NULL, updated_at = now()
    WHERE u.company_id IS NOT NULL
      AND NOT EXISTS (
          SELECT 1 FROM company_memberships m
          WHERE m.user_id = u.id
            AND m.company_id = u.company_id
            AND m.status = 'active'
      );
END $$;
