-- PROVIDER-MIRROR-INVARIANT-001: make provider visibility a database invariant.
-- origin/master max was 257 immediately before this file was created (2026-08-12).

-- This is the only formula for the stored authorization mirror. It accepts both
-- canonical technicians.id UUIDs and legacy Zenbooker ids during the transition.
CREATE OR REPLACE FUNCTION resolve_job_provider_user_ids(
    p_company_id UUID,
    p_assigned_techs JSONB
)
RETURNS JSONB
LANGUAGE sql
STABLE
SET search_path FROM CURRENT
AS $function$
    WITH assignment_ids AS (
        SELECT DISTINCT assignment.value->>'id' AS assignment_id
        FROM jsonb_array_elements(
            CASE
                WHEN jsonb_typeof(p_assigned_techs) = 'array' THEN p_assigned_techs
                ELSE '[]'::jsonb
            END
        ) AS assignment(value)
        WHERE NULLIF(BTRIM(assignment.value->>'id'), '') IS NOT NULL
    ),
    resolved_technicians AS (
        SELECT technician.id, technician.crm_user_id
        FROM assignment_ids assignment
        JOIN technicians technician
          ON technician.company_id = p_company_id
         AND technician.id = CASE
                WHEN assignment.assignment_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                    THEN assignment.assignment_id::uuid
                ELSE NULL
             END
         AND technician.active = TRUE

        UNION

        SELECT technician.id, technician.crm_user_id
        FROM assignment_ids assignment
        JOIN technician_external_identities identity
          ON identity.company_id = p_company_id
         AND identity.source = 'zenbooker'
         AND identity.external_id = assignment.assignment_id
        JOIN technicians technician
          ON technician.company_id = identity.company_id
         AND technician.id = identity.technician_id
         AND technician.active = TRUE
    ),
    resolved_users AS (
        SELECT DISTINCT membership.user_id
        FROM resolved_technicians technician
        JOIN company_memberships membership
          ON membership.company_id = p_company_id
         AND membership.user_id = technician.crm_user_id
         AND membership.status = 'active'
    )
    SELECT COALESCE(
        jsonb_agg(to_jsonb(user_id::text) ORDER BY user_id::text),
        '[]'::jsonb
    )
    FROM resolved_users;
$function$;

COMMENT ON FUNCTION resolve_job_provider_user_ids(UUID, JSONB) IS
    'Authoritative company-scoped formula for jobs.assigned_provider_user_ids.';

-- Bulk refresh primitive used by every relationship-chain trigger and by the
-- trigger-disabled importer. Affected companies are always explicit. Passing
-- p_all_company_jobs=FALSE additionally narrows work to the supplied technician
-- UUIDs/external ids; the final DISTINCT check keeps the operation idempotent.
CREATE OR REPLACE FUNCTION refresh_job_provider_mirrors(
    p_company_ids UUID[],
    p_technician_ids UUID[] DEFAULT NULL,
    p_external_ids TEXT[] DEFAULT NULL,
    p_all_company_jobs BOOLEAN DEFAULT FALSE
)
RETURNS BIGINT
LANGUAGE plpgsql
SET search_path FROM CURRENT
AS $function$
DECLARE
    v_updated BIGINT := 0;
BEGIN
    IF COALESCE(cardinality(p_company_ids), 0) = 0 THEN
        RETURN 0;
    END IF;

    WITH calculated AS MATERIALIZED (
        SELECT job.company_id,
               job.id,
               resolve_job_provider_user_ids(
                   job.company_id,
                   job.assigned_techs
               ) AS provider_user_ids
        FROM jobs job
        WHERE job.company_id = ANY(p_company_ids)
          AND (
              p_all_company_jobs
              OR EXISTS (
                  SELECT 1
                  FROM jsonb_array_elements(
                      CASE
                          WHEN jsonb_typeof(job.assigned_techs) = 'array'
                              THEN job.assigned_techs
                          ELSE '[]'::jsonb
                      END
                  ) AS assignment(value)
                  WHERE (
                      COALESCE(cardinality(p_external_ids), 0) > 0
                      AND assignment.value->>'id' = ANY(p_external_ids)
                  ) OR (
                      COALESCE(cardinality(p_technician_ids), 0) > 0
                      AND (
                          (
                              CASE
                                  WHEN assignment.value->>'id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                                      THEN (assignment.value->>'id')::uuid
                                  ELSE NULL
                              END = ANY(p_technician_ids)
                          )
                          OR EXISTS (
                              SELECT 1
                              FROM technician_external_identities identity
                              WHERE identity.company_id = job.company_id
                                AND identity.source = 'zenbooker'
                                AND identity.external_id = assignment.value->>'id'
                                AND identity.technician_id = ANY(p_technician_ids)
                          )
                      )
                  )
              )
          )
    )
    UPDATE jobs job
    SET assigned_provider_user_ids = calculated.provider_user_ids,
        updated_at = NOW()
    FROM calculated
    WHERE job.company_id = calculated.company_id
      AND job.id = calculated.id
      AND job.assigned_provider_user_ids IS DISTINCT FROM calculated.provider_user_ids;

    GET DIAGNOSTICS v_updated = ROW_COUNT;
    RETURN v_updated;
END;
$function$;

COMMENT ON FUNCTION refresh_job_provider_mirrors(UUID[], UUID[], TEXT[], BOOLEAN) IS
    'Tenant-scoped, idempotent bulk refresh for the provider visibility mirror.';

-- BEFORE is intentional: INSERT/UPDATE RETURNING also sees the corrected value,
-- and a caller cannot persist a forged assigned_provider_user_ids value.
CREATE OR REPLACE FUNCTION enforce_job_provider_mirror()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path FROM CURRENT
AS $function$
BEGIN
    NEW.assigned_provider_user_ids := resolve_job_provider_user_ids(
        NEW.company_id,
        NEW.assigned_techs
    );
    RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_jobs_provider_mirror_insert ON jobs;
CREATE TRIGGER trg_jobs_provider_mirror_insert
    BEFORE INSERT ON jobs
    FOR EACH ROW
    EXECUTE FUNCTION enforce_job_provider_mirror();
ALTER TABLE jobs ENABLE ALWAYS TRIGGER trg_jobs_provider_mirror_insert;

DROP TRIGGER IF EXISTS trg_jobs_provider_mirror_update ON jobs;
CREATE TRIGGER trg_jobs_provider_mirror_update
    BEFORE UPDATE OF company_id, assigned_techs, assigned_provider_user_ids ON jobs
    FOR EACH ROW
    EXECUTE FUNCTION enforce_job_provider_mirror();
ALTER TABLE jobs ENABLE ALWAYS TRIGGER trg_jobs_provider_mirror_update;

CREATE OR REPLACE FUNCTION refresh_provider_mirror_from_external_identities()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path FROM CURRENT
AS $function$
DECLARE
    v_company_ids UUID[];
    v_technician_ids UUID[];
    v_external_ids TEXT[];
BEGIN
    IF TG_OP = 'INSERT' THEN
        SELECT array_agg(DISTINCT company_id),
               array_agg(DISTINCT technician_id),
               array_agg(DISTINCT external_id)
        INTO v_company_ids, v_technician_ids, v_external_ids
        FROM new_external_identities
        WHERE source = 'zenbooker';
    ELSIF TG_OP = 'DELETE' THEN
        SELECT array_agg(DISTINCT company_id),
               array_agg(DISTINCT technician_id),
               array_agg(DISTINCT external_id)
        INTO v_company_ids, v_technician_ids, v_external_ids
        FROM old_external_identities
        WHERE source = 'zenbooker';
    ELSE
        WITH changed AS (
            SELECT old_identity.company_id AS old_company_id,
                   old_identity.source AS old_source,
                   old_identity.external_id AS old_external_id,
                   old_identity.technician_id AS old_technician_id,
                   new_identity.company_id AS new_company_id,
                   new_identity.source AS new_source,
                   new_identity.external_id AS new_external_id,
                   new_identity.technician_id AS new_technician_id
            FROM old_external_identities old_identity
            FULL JOIN new_external_identities new_identity
              ON new_identity.company_id = old_identity.company_id
             AND new_identity.source = old_identity.source
             AND new_identity.external_id = old_identity.external_id
            WHERE (old_identity.company_id, old_identity.source,
                   old_identity.external_id, old_identity.technician_id)
                  IS DISTINCT FROM
                  (new_identity.company_id, new_identity.source,
                   new_identity.external_id, new_identity.technician_id)
        ),
        refs AS (
            SELECT old_company_id AS company_id,
                   old_technician_id AS technician_id,
                   old_external_id AS external_id
            FROM changed
            WHERE old_source = 'zenbooker'
            UNION
            SELECT new_company_id, new_technician_id, new_external_id
            FROM changed
            WHERE new_source = 'zenbooker'
        )
        SELECT array_agg(DISTINCT company_id),
               array_agg(DISTINCT technician_id),
               array_agg(DISTINCT external_id)
        INTO v_company_ids, v_technician_ids, v_external_ids
        FROM refs;
    END IF;

    PERFORM refresh_job_provider_mirrors(
        v_company_ids,
        v_technician_ids,
        v_external_ids,
        FALSE
    );
    RETURN NULL;
END;
$function$;

DROP TRIGGER IF EXISTS trg_external_identities_provider_mirror_insert
    ON technician_external_identities;
CREATE TRIGGER trg_external_identities_provider_mirror_insert
    AFTER INSERT ON technician_external_identities
    REFERENCING NEW TABLE AS new_external_identities
    FOR EACH STATEMENT
    EXECUTE FUNCTION refresh_provider_mirror_from_external_identities();
ALTER TABLE technician_external_identities ENABLE ALWAYS TRIGGER
    trg_external_identities_provider_mirror_insert;

DROP TRIGGER IF EXISTS trg_external_identities_provider_mirror_update
    ON technician_external_identities;
CREATE TRIGGER trg_external_identities_provider_mirror_update
    AFTER UPDATE ON technician_external_identities
    REFERENCING OLD TABLE AS old_external_identities NEW TABLE AS new_external_identities
    FOR EACH STATEMENT
    EXECUTE FUNCTION refresh_provider_mirror_from_external_identities();
ALTER TABLE technician_external_identities ENABLE ALWAYS TRIGGER
    trg_external_identities_provider_mirror_update;

DROP TRIGGER IF EXISTS trg_external_identities_provider_mirror_delete
    ON technician_external_identities;
CREATE TRIGGER trg_external_identities_provider_mirror_delete
    AFTER DELETE ON technician_external_identities
    REFERENCING OLD TABLE AS old_external_identities
    FOR EACH STATEMENT
    EXECUTE FUNCTION refresh_provider_mirror_from_external_identities();
ALTER TABLE technician_external_identities ENABLE ALWAYS TRIGGER
    trg_external_identities_provider_mirror_delete;

CREATE OR REPLACE FUNCTION refresh_provider_mirror_from_technicians()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path FROM CURRENT
AS $function$
DECLARE
    v_company_ids UUID[];
    v_technician_ids UUID[];
BEGIN
    IF TG_OP = 'INSERT' THEN
        SELECT array_agg(DISTINCT company_id), array_agg(DISTINCT id)
        INTO v_company_ids, v_technician_ids
        FROM new_technicians;
    ELSIF TG_OP = 'DELETE' THEN
        SELECT array_agg(DISTINCT company_id), array_agg(DISTINCT id)
        INTO v_company_ids, v_technician_ids
        FROM old_technicians;
    ELSE
        WITH changed AS (
            SELECT old_technician.company_id AS old_company_id,
                   old_technician.id AS old_id,
                   new_technician.company_id AS new_company_id,
                   new_technician.id AS new_id
            FROM old_technicians old_technician
            FULL JOIN new_technicians new_technician
              ON new_technician.company_id = old_technician.company_id
             AND new_technician.id = old_technician.id
            WHERE (old_technician.company_id, old_technician.id,
                   old_technician.crm_user_id, old_technician.active)
                  IS DISTINCT FROM
                  (new_technician.company_id, new_technician.id,
                   new_technician.crm_user_id, new_technician.active)
        ),
        refs AS (
            SELECT old_company_id AS company_id, old_id AS technician_id FROM changed
            UNION
            SELECT new_company_id, new_id FROM changed
        )
        SELECT array_agg(DISTINCT company_id), array_agg(DISTINCT technician_id)
        INTO v_company_ids, v_technician_ids
        FROM refs;
    END IF;

    PERFORM refresh_job_provider_mirrors(
        v_company_ids,
        v_technician_ids,
        NULL,
        FALSE
    );
    RETURN NULL;
END;
$function$;

DROP TRIGGER IF EXISTS trg_technicians_provider_mirror_insert ON technicians;
CREATE TRIGGER trg_technicians_provider_mirror_insert
    AFTER INSERT ON technicians
    REFERENCING NEW TABLE AS new_technicians
    FOR EACH STATEMENT
    EXECUTE FUNCTION refresh_provider_mirror_from_technicians();
ALTER TABLE technicians ENABLE ALWAYS TRIGGER trg_technicians_provider_mirror_insert;

DROP TRIGGER IF EXISTS trg_technicians_provider_mirror_update ON technicians;
CREATE TRIGGER trg_technicians_provider_mirror_update
    AFTER UPDATE ON technicians
    REFERENCING OLD TABLE AS old_technicians NEW TABLE AS new_technicians
    FOR EACH STATEMENT
    EXECUTE FUNCTION refresh_provider_mirror_from_technicians();
ALTER TABLE technicians ENABLE ALWAYS TRIGGER trg_technicians_provider_mirror_update;

DROP TRIGGER IF EXISTS trg_technicians_provider_mirror_delete ON technicians;
CREATE TRIGGER trg_technicians_provider_mirror_delete
    AFTER DELETE ON technicians
    REFERENCING OLD TABLE AS old_technicians
    FOR EACH STATEMENT
    EXECUTE FUNCTION refresh_provider_mirror_from_technicians();
ALTER TABLE technicians ENABLE ALWAYS TRIGGER trg_technicians_provider_mirror_delete;

CREATE OR REPLACE FUNCTION refresh_provider_mirror_from_memberships()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path FROM CURRENT
AS $function$
DECLARE
    v_company_ids UUID[];
BEGIN
    IF TG_OP = 'INSERT' THEN
        SELECT array_agg(DISTINCT company_id)
        INTO v_company_ids
        FROM new_memberships;
    ELSIF TG_OP = 'DELETE' THEN
        SELECT array_agg(DISTINCT company_id)
        INTO v_company_ids
        FROM old_memberships;
    ELSE
        WITH changed AS (
            SELECT old_membership.company_id AS old_company_id,
                   new_membership.company_id AS new_company_id
            FROM old_memberships old_membership
            FULL JOIN new_memberships new_membership
              ON new_membership.id = old_membership.id
            WHERE (old_membership.company_id, old_membership.user_id,
                   old_membership.status)
                  IS DISTINCT FROM
                  (new_membership.company_id, new_membership.user_id,
                   new_membership.status)
        ),
        companies AS (
            SELECT old_company_id AS company_id FROM changed
            UNION
            SELECT new_company_id FROM changed
        )
        SELECT array_agg(DISTINCT company_id)
        INTO v_company_ids
        FROM companies
        WHERE company_id IS NOT NULL;
    END IF;

    -- A membership DELETE may have already fired ON DELETE SET NULL on linked
    -- technicians, so company-wide is the only fail-closed statement-level target
    -- that does not depend on a link which no longer exists.
    PERFORM refresh_job_provider_mirrors(v_company_ids, NULL, NULL, TRUE);
    RETURN NULL;
END;
$function$;

DROP TRIGGER IF EXISTS trg_memberships_provider_mirror_insert ON company_memberships;
CREATE TRIGGER trg_memberships_provider_mirror_insert
    AFTER INSERT ON company_memberships
    REFERENCING NEW TABLE AS new_memberships
    FOR EACH STATEMENT
    EXECUTE FUNCTION refresh_provider_mirror_from_memberships();
ALTER TABLE company_memberships ENABLE ALWAYS TRIGGER trg_memberships_provider_mirror_insert;

DROP TRIGGER IF EXISTS trg_memberships_provider_mirror_update ON company_memberships;
CREATE TRIGGER trg_memberships_provider_mirror_update
    AFTER UPDATE ON company_memberships
    REFERENCING OLD TABLE AS old_memberships NEW TABLE AS new_memberships
    FOR EACH STATEMENT
    EXECUTE FUNCTION refresh_provider_mirror_from_memberships();
ALTER TABLE company_memberships ENABLE ALWAYS TRIGGER trg_memberships_provider_mirror_update;

DROP TRIGGER IF EXISTS trg_memberships_provider_mirror_delete ON company_memberships;
CREATE TRIGGER trg_memberships_provider_mirror_delete
    AFTER DELETE ON company_memberships
    REFERENCING OLD TABLE AS old_memberships
    FOR EACH STATEMENT
    EXECUTE FUNCTION refresh_provider_mirror_from_memberships();
ALTER TABLE company_memberships ENABLE ALWAYS TRIGGER trg_memberships_provider_mirror_delete;

-- Establish the invariant immediately for all existing tenants. The update only
-- touches drifted rows and is therefore safe to re-run.
SELECT refresh_job_provider_mirrors(
    ARRAY(
        SELECT DISTINCT company_id
        FROM jobs
        WHERE company_id IS NOT NULL
    ),
    NULL,
    NULL,
    TRUE
);

COMMENT ON COLUMN jobs.assigned_provider_user_ids IS
    'DB-maintained authorization mirror derived by resolve_job_provider_user_ids(company_id, assigned_techs). Direct writes are overwritten.';
