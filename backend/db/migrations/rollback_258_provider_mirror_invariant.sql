-- Roll back PROVIDER-MIRROR-INVARIANT-001 enforcement. Existing mirror values
-- remain intact; prior values cannot be reconstructed after the initial repair.

DROP TRIGGER IF EXISTS trg_memberships_provider_mirror_delete ON company_memberships;
DROP TRIGGER IF EXISTS trg_memberships_provider_mirror_update ON company_memberships;
DROP TRIGGER IF EXISTS trg_memberships_provider_mirror_insert ON company_memberships;

DROP TRIGGER IF EXISTS trg_technicians_provider_mirror_delete ON technicians;
DROP TRIGGER IF EXISTS trg_technicians_provider_mirror_update ON technicians;
DROP TRIGGER IF EXISTS trg_technicians_provider_mirror_insert ON technicians;

DROP TRIGGER IF EXISTS trg_external_identities_provider_mirror_delete
    ON technician_external_identities;
DROP TRIGGER IF EXISTS trg_external_identities_provider_mirror_update
    ON technician_external_identities;
DROP TRIGGER IF EXISTS trg_external_identities_provider_mirror_insert
    ON technician_external_identities;

DROP TRIGGER IF EXISTS trg_jobs_provider_mirror_update ON jobs;
DROP TRIGGER IF EXISTS trg_jobs_provider_mirror_insert ON jobs;

DROP FUNCTION IF EXISTS refresh_provider_mirror_from_memberships();
DROP FUNCTION IF EXISTS refresh_provider_mirror_from_technicians();
DROP FUNCTION IF EXISTS refresh_provider_mirror_from_external_identities();
DROP FUNCTION IF EXISTS enforce_job_provider_mirror();
DROP FUNCTION IF EXISTS refresh_job_provider_mirrors(UUID[], UUID[], TEXT[], BOOLEAN);
DROP FUNCTION IF EXISTS resolve_job_provider_user_ids(UUID, JSONB);

COMMENT ON COLUMN jobs.assigned_provider_user_ids IS
    'Internal mirror of job assignment: array of crm_users.id (uuid strings); application-maintained after rollback of migration 258.';
