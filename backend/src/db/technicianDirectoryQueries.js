/**
 * ZB-DECOUPLE-001 Phase A — company-scoped persistence for the Albusto-native
 * technician directory (migration 240). Pure query layer, no Zenbooker calls and
 * no default-company fallback: every function takes companyId and scopes by it,
 * so a tenant can never read or write another tenant's technicians or the map.
 *
 * Two tables:
 *   technicians                    — native identity (uuid), active flag, optional crm_user_id
 *   technician_external_identities — (company_id, source, external_id) → technician uuid
 *
 * The external map is how the same ZB id in two different companies resolves to
 * two DIFFERENT native technicians and never crosses (PK is (company_id, source,
 * external_id); resolve* always filter on company_id).
 */
const db = require('./connection');

async function createTechnician({ companyId, displayName, active = true, crmUserId = null }) {
    const { rows } = await db.query(
        `INSERT INTO technicians (company_id, display_name, active, crm_user_id)
         VALUES ($1, $2, $3, $4)
         RETURNING id, company_id, display_name, active, crm_user_id, created_at`,
        [companyId, displayName, active, crmUserId]
    );
    return rows[0];
}

/**
 * Idempotent on the (company_id, source, external_id) primary key. A re-run with
 * the SAME triple is a no-op that returns the existing mapping — the backfill
 * (T2) relies on this to never mint a second technician on replay. A conflicting
 * triple that already points at a different technician is NOT silently repointed:
 * ON CONFLICT DO NOTHING keeps the original, and the caller sees the stored row.
 */
async function upsertExternalIdentity({ companyId, source, externalId, technicianId }) {
    const { rows } = await db.query(
        `INSERT INTO technician_external_identities (company_id, source, external_id, technician_id)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (company_id, source, external_id) DO NOTHING
         RETURNING company_id, source, external_id, technician_id, created_at`,
        [companyId, source, externalId, technicianId]
    );
    if (rows[0]) return rows[0];
    // Already present — return what is stored (never the caller's proposed technicianId).
    const existing = await db.query(
        `SELECT company_id, source, external_id, technician_id, created_at
         FROM technician_external_identities
         WHERE company_id = $1 AND source = $2 AND external_id = $3`,
        [companyId, source, externalId]
    );
    return existing.rows[0] || null;
}

async function resolveExternalToUuid(companyId, source, externalId) {
    const { rows } = await db.query(
        `SELECT technician_id
         FROM technician_external_identities
         WHERE company_id = $1 AND source = $2 AND external_id = $3`,
        [companyId, source, externalId]
    );
    return rows[0] ? rows[0].technician_id : null;
}

async function resolveUuidToExternal(companyId, source, technicianUuid) {
    const { rows } = await db.query(
        `SELECT external_id
         FROM technician_external_identities
         WHERE company_id = $1 AND source = $2 AND technician_id = $3`,
        [companyId, source, technicianUuid]
    );
    return rows[0] ? rows[0].external_id : null;
}

async function listActiveTechnicians(companyId) {
    const { rows } = await db.query(
        `SELECT t.id, t.display_name, t.active, t.crm_user_id,
                external.external_id AS zenbooker_external_id
         FROM technicians t
         LEFT JOIN LATERAL (
             SELECT e.external_id
             FROM technician_external_identities e
             WHERE e.company_id = t.company_id
               AND e.source = 'zenbooker'
               AND e.technician_id = t.id
             ORDER BY e.created_at ASC, e.external_id ASC
             LIMIT 1
         ) external ON TRUE
         WHERE t.company_id = $1 AND t.active = TRUE
         ORDER BY t.display_name ASC, t.id ASC`,
        [companyId]
    );
    return rows;
}

async function findActiveTechnicianByCrmUserId(companyId, crmUserId) {
    const { rows } = await db.query(
        `SELECT id, display_name, active, crm_user_id
         FROM technicians
         WHERE company_id = $1
           AND crm_user_id = $2
           AND active = TRUE`,
        [companyId, crmUserId]
    );
    return rows[0] || null;
}

/**
 * Link (or unlink, with crmUserId=null) a CRM user to a native technician. The
 * (company_id, id) filter is what keeps the write inside the tenant; the schema's
 * partial unique index enforces at most one technician per CRM user per company.
 */
async function linkCrmUser({ companyId, technicianId, crmUserId }) {
    const { rows } = await db.query(
        `UPDATE technicians
         SET crm_user_id = $3
         WHERE company_id = $1 AND id = $2
         RETURNING id, company_id, display_name, active, crm_user_id, created_at`,
        [companyId, technicianId, crmUserId]
    );
    return rows[0] || null;
}

module.exports = {
    createTechnician,
    upsertExternalIdentity,
    resolveExternalToUuid,
    resolveUuidToExternal,
    listActiveTechnicians,
    findActiveTechnicianByCrmUserId,
    linkCrmUser,
};
