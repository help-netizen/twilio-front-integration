'use strict';

const db = require('./connection');

function normalizedTechnicianIds(technicianIds) {
    if (technicianIds == null) return null;
    return [...new Set(
        (Array.isArray(technicianIds) ? technicianIds : [technicianIds])
            .map(value => String(value || '').trim().toLowerCase())
            .filter(Boolean)
    )];
}

/**
 * Recompute jobs.assigned_provider_user_ids from the canonical assignment chain.
 * When technicianIds are supplied, only jobs assigned to one of those native
 * technicians (direct UUID or company-scoped Zenbooker identity) are touched.
 */
async function refreshProviderMirror(companyId, { technicianIds = null, runner = db } = {}) {
    if (!companyId) return { updated: 0 };
    const targets = normalizedTechnicianIds(technicianIds);
    if (targets && targets.length === 0) return { updated: 0 };

    const params = [companyId];
    const targetPredicate = targets ? `
               AND EXISTS (
                   SELECT 1
                   FROM jsonb_array_elements(
                       CASE WHEN jsonb_typeof(j2.assigned_techs) = 'array'
                            THEN j2.assigned_techs ELSE '[]'::jsonb END
                   ) AS target_assignment(value)
                   LEFT JOIN technician_external_identities target_identity
                     ON target_identity.company_id = j2.company_id
                    AND target_identity.source = 'zenbooker'
                    AND target_identity.external_id = target_assignment.value->>'id'
                   WHERE target_assignment.value->>'id' = ANY($2::text[])
                      OR target_identity.technician_id = ANY($2::uuid[])
               )` : '';
    if (targets) params.push(targets);

    const { rowCount } = await runner.query(
        `UPDATE jobs j
         SET assigned_provider_user_ids = sub.user_ids, updated_at = NOW()
         FROM (
             SELECT j2.id AS job_id,
                    COALESCE(
                        jsonb_agg(DISTINCT to_jsonb(native_m.user_id::text))
                            FILTER (WHERE native_m.user_id IS NOT NULL),
                        '[]'::jsonb
                    ) AS user_ids
             FROM jobs j2
             LEFT JOIN LATERAL jsonb_array_elements(
                 CASE WHEN jsonb_typeof(j2.assigned_techs) = 'array'
                      THEN j2.assigned_techs ELSE '[]'::jsonb END
             ) AS tech(value) ON TRUE
             LEFT JOIN technician_external_identities e
                 ON e.company_id = j2.company_id
                AND e.source = 'zenbooker'
                AND e.external_id = tech.value->>'id'
             LEFT JOIN technicians t
                 ON t.company_id = j2.company_id
                AND (t.id::text = tech.value->>'id' OR t.id = e.technician_id)
             LEFT JOIN company_memberships native_m
                 ON native_m.company_id = j2.company_id
                AND native_m.user_id = t.crm_user_id
                AND native_m.status = 'active'
             WHERE j2.company_id = $1${targetPredicate}
             GROUP BY j2.id
         ) sub
         WHERE j.company_id = $1
           AND j.id = sub.job_id
           AND j.assigned_provider_user_ids IS DISTINCT FROM sub.user_ids`,
        params
    );
    return { updated: rowCount };
}

module.exports = {
    refreshProviderMirror,
};
