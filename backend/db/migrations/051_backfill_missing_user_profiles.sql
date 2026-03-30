-- =============================================================================
-- Migration 051: Backfill missing company_user_profiles rows
--
-- Bug #5 fix: bootstrap paths in admin-companies.js created memberships
-- without a corresponding company_user_profiles row (introduced before
-- migration 048). This caused phone_calls_allowed checks to return NULL/false.
-- =============================================================================

INSERT INTO company_user_profiles (membership_id)
SELECT m.id
FROM company_memberships m
WHERE NOT EXISTS (
    SELECT 1 FROM company_user_profiles p WHERE p.membership_id = m.id
);
