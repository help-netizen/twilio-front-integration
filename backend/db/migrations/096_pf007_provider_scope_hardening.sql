-- ============================================================================
-- 096: PF007-HARDENING-001 / TASK-RBAC-001
-- Provider bridge + internal assignee mirror foundation.
--
-- Ownership model:
--   * company_user_profiles.zenbooker_team_member_id is an INTEGRATION BRIDGE
--     only — it maps an external Zenbooker team member to a tenant membership.
--     It is never an authorization source by itself.
--   * jobs.assigned_provider_user_ids mirrors job assignment as internal
--     crm_users.id values (uuid strings). All visibility checks must use this
--     internal mirror, scoped by jobs.company_id.
--
-- NOTE: tasks.md references migration number 080; that number was already
-- taken by 080_seed_analytics_scope.sql, so this migration ships as 096.
-- ============================================================================

-- 1. Provider bridge on the tenant user profile
ALTER TABLE company_user_profiles
    ADD COLUMN IF NOT EXISTS zenbooker_team_member_id TEXT;

COMMENT ON COLUMN company_user_profiles.zenbooker_team_member_id IS
    'Integration bridge to Zenbooker team member id. Not an authorization source; ownership is always crm_users.id.';

-- Lookup index for bridge resolution during job sync (company scope is applied
-- through the membership join at query time).
CREATE INDEX IF NOT EXISTS idx_user_profiles_zb_team_member
    ON company_user_profiles (zenbooker_team_member_id)
    WHERE zenbooker_team_member_id IS NOT NULL;

-- 2. Internal assignee mirror on jobs (crm_users.id uuid strings)
ALTER TABLE jobs
    ADD COLUMN IF NOT EXISTS assigned_provider_user_ids JSONB NOT NULL DEFAULT '[]'::jsonb;

COMMENT ON COLUMN jobs.assigned_provider_user_ids IS
    'Internal mirror of job assignment: array of crm_users.id (uuid strings) resolved from assigned_techs via the company-scoped provider bridge.';

-- Containment queries: assigned_provider_user_ids @> '["<crm_user_id>"]'
CREATE INDEX IF NOT EXISTS idx_jobs_assigned_provider_user_ids
    ON jobs USING gin (assigned_provider_user_ids jsonb_path_ops);

-- Company-scoped provider visibility list queries
CREATE INDEX IF NOT EXISTS idx_jobs_company_start_date
    ON jobs (company_id, start_date DESC);

-- 3. Backfill the mirror from existing data (idempotent).
-- Resolves each job's external assigned_techs[].id through the provider bridge
-- within the SAME company. Jobs without resolvable mappings stay '[]' — an
-- unmapped external provider id must not grant visibility to anyone.
UPDATE jobs j
SET assigned_provider_user_ids = sub.user_ids,
    updated_at = NOW()
FROM (
    SELECT j2.id AS job_id,
           COALESCE(
               jsonb_agg(DISTINCT to_jsonb(m.user_id::text))
                   FILTER (WHERE m.user_id IS NOT NULL),
               '[]'::jsonb
           ) AS user_ids
    FROM jobs j2
    LEFT JOIN LATERAL jsonb_array_elements(
        CASE WHEN jsonb_typeof(j2.assigned_techs) = 'array'
             THEN j2.assigned_techs ELSE '[]'::jsonb END
    ) AS tech(value) ON TRUE
    LEFT JOIN company_user_profiles p
        ON p.zenbooker_team_member_id = tech.value->>'id'
    LEFT JOIN company_memberships m
        ON m.id = p.membership_id
       AND m.company_id = j2.company_id
       AND m.status = 'active'
    GROUP BY j2.id
) sub
WHERE j.id = sub.job_id
  AND j.assigned_provider_user_ids IS DISTINCT FROM sub.user_ids;
