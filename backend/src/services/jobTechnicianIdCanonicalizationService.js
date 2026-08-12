'use strict';

/** TECH-ID-CANON-001 T1 — company-scoped jobs.assigned_techs id canonicalization. */
const db = require('../db/connection');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const INVENTORY_SQL = `
    WITH assignments AS (
        SELECT j.id AS job_id, assignment.value
        FROM jobs j
        CROSS JOIN LATERAL jsonb_array_elements(
            CASE WHEN jsonb_typeof(j.assigned_techs) = 'array'
                 THEN j.assigned_techs ELSE '[]'::jsonb END
        )
            AS assignment(value)
        WHERE j.company_id = $1
          AND jsonb_typeof(j.assigned_techs) = 'array'
    ), classified AS (
        SELECT a.job_id,
               native.id AS native_id,
               external.technician_id AS external_technician_id
        FROM assignments a
        LEFT JOIN technicians native
          ON native.company_id = $1
         AND native.id::text = a.value->>'id'
        LEFT JOIN technician_external_identities external
          ON native.id IS NULL
         AND external.company_id = $1
         AND external.source = 'zenbooker'
         AND external.external_id = a.value->>'id'
    )
    SELECT COUNT(DISTINCT job_id)::int AS jobs_with_assignments,
           COUNT(DISTINCT job_id) FILTER (
               WHERE native_id IS NULL AND external_technician_id IS NOT NULL
           )::int AS legacy_jobs,
           COUNT(*)::int AS total_assignments,
           COUNT(*) FILTER (WHERE native_id IS NOT NULL)::int AS native_assignments,
           COUNT(*) FILTER (
               WHERE native_id IS NULL AND external_technician_id IS NOT NULL
           )::int AS legacy_assignments,
           COUNT(*) FILTER (
               WHERE native_id IS NULL AND external_technician_id IS NULL
           )::int AS unresolved_assignments
    FROM classified`;

function canonError(code, message) {
    const error = new Error(`[TechnicianIdCanon] ${message}`);
    error.code = code;
    return error;
}

function normalizeInventory(row = {}) {
    return {
        jobs_with_assignments: Number(row.jobs_with_assignments || 0),
        legacy_jobs: Number(row.legacy_jobs || 0),
        total_assignments: Number(row.total_assignments || 0),
        native_assignments: Number(row.native_assignments || 0),
        legacy_assignments: Number(row.legacy_assignments || 0),
        unresolved_assignments: Number(row.unresolved_assignments || 0),
    };
}

async function inventoryAssignedTechIds(companyId, runner = db) {
    const { rows } = await runner.query(INVENTORY_SQL, [companyId]);
    return normalizeInventory(rows[0]);
}

function projectedInventory(before) {
    return {
        ...before,
        native_assignments: before.native_assignments + before.legacy_assignments,
        legacy_assignments: 0,
    };
}

async function rewriteAssignedTechIds(client, companyId) {
    const { rows } = await client.query(
        `WITH rewritten AS (
             SELECT j.id,
                    jsonb_agg(
                        CASE
                            WHEN native.id IS NULL AND external.technician_id IS NOT NULL
                            THEN jsonb_set(
                                assignment.value,
                                '{id}',
                                to_jsonb(external.technician_id::text),
                                FALSE
                            )
                            ELSE assignment.value
                        END
                        ORDER BY assignment.ordinality
                    ) AS assigned_techs,
                    COUNT(*) FILTER (
                        WHERE native.id IS NULL AND external.technician_id IS NOT NULL
                    )::int AS changed_assignments
             FROM jobs j
             CROSS JOIN LATERAL jsonb_array_elements(
                 CASE WHEN jsonb_typeof(j.assigned_techs) = 'array'
                      THEN j.assigned_techs ELSE '[]'::jsonb END
             )
                 WITH ORDINALITY AS assignment(value, ordinality)
             LEFT JOIN technicians native
               ON native.company_id = j.company_id
              AND native.id::text = assignment.value->>'id'
             LEFT JOIN technician_external_identities external
               ON native.id IS NULL
              AND external.company_id = j.company_id
              AND external.source = 'zenbooker'
              AND external.external_id = assignment.value->>'id'
             WHERE j.company_id = $1
               AND jsonb_typeof(j.assigned_techs) = 'array'
             GROUP BY j.id
         )
         UPDATE jobs j
            SET assigned_techs = rewritten.assigned_techs,
                updated_at = NOW()
           FROM rewritten
          WHERE j.company_id = $1
            AND j.id = rewritten.id
            AND rewritten.changed_assignments > 0
            AND j.assigned_techs IS DISTINCT FROM rewritten.assigned_techs
         RETURNING rewritten.changed_assignments`,
        [companyId]
    );
    return {
        changed_jobs: rows.length,
        changed_assignments: rows.reduce(
            (total, row) => total + Number(row.changed_assignments || 0),
            0
        ),
    };
}

async function canonicalizeJobTechnicianIds({
    companyId,
    dryRun = true,
    logger = console,
    database = db,
} = {}) {
    const normalizedCompanyId = String(companyId || '').trim().toLowerCase();
    if (!UUID_RE.test(normalizedCompanyId)) {
        throw canonError('INVALID_COMPANY', 'companyId must be a UUID');
    }

    const client = await database.getClient();
    try {
        await client.query('BEGIN');
        // The lock and every subsequent read/write are constrained to this tenant.
        await client.query(
            `SELECT id
             FROM jobs
             WHERE company_id = $1
               AND jsonb_typeof(assigned_techs) = 'array'
             FOR UPDATE`,
            [normalizedCompanyId]
        );
        const before = await inventoryAssignedTechIds(normalizedCompanyId, client);
        if (before.unresolved_assignments > 0) {
            throw canonError(
                'UNRESOLVED_TECHNICIAN_IDS',
                `${before.unresolved_assignments} assigned technician ids do not resolve; no rows changed`
            );
        }

        let changed = {
            changed_jobs: before.legacy_jobs,
            changed_assignments: before.legacy_assignments,
        };
        let after = projectedInventory(before);
        if (dryRun) {
            await client.query('ROLLBACK');
        } else {
            changed = await rewriteAssignedTechIds(client, normalizedCompanyId);
            after = await inventoryAssignedTechIds(normalizedCompanyId, client);
            await client.query('COMMIT');
        }

        const result = {
            status: dryRun ? 'dry-run' : 'applied',
            company_id: normalizedCompanyId,
            before,
            after,
            ...changed,
        };
        logger.info?.(
            `[TechnicianIdCanon] ${result.status} company=${normalizedCompanyId} `
            + `jobs=${result.changed_jobs} assignments=${result.changed_assignments}`
        );
        return result;
    } catch (error) {
        try { await client.query('ROLLBACK'); } catch (_) { /* transaction already closed */ }
        throw error;
    } finally {
        client.release();
    }
}

module.exports = {
    canonicalizeJobTechnicianIds,
    inventoryAssignedTechIds,
    INVENTORY_SQL,
};
