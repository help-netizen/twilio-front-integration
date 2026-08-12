/** Company-scoped technician/company base-location persistence. */
const db = require('./connection');
const directoryQueries = require('./technicianDirectoryQueries');

const COMPANY_BASE_ID = '__company__';

function invalidTechnicianIdentityError() {
    const error = new Error('Technician identity not found');
    error.code = 'TECHNICIAN_IDENTITY_NOT_FOUND';
    error.httpStatus = 404;
    return error;
}

async function resolveTechnicianIdentity(companyId, techId, { required = true } = {}) {
    const input = techId == null ? '' : String(techId).trim();
    if (!input) {
        if (!required) return null;
        throw invalidTechnicianIdentityError();
    }
    if (input === COMPANY_BASE_ID) {
        return { technicianUuid: null, publicId: COMPANY_BASE_ID, isCompanyDefault: true };
    }
    const technicianUuid = await directoryQueries.resolveTechnicianUuid(
        companyId,
        input,
        'zenbooker'
    );
    if (!technicianUuid) {
        if (!required) return null;
        throw invalidTechnicianIdentityError();
    }
    return {
        technicianUuid: String(technicianUuid).toLowerCase(),
        publicId: String(technicianUuid).toLowerCase(),
        isCompanyDefault: false,
    };
}

async function listByCompany(companyId) {
    const { rows } = await db.query(
        `SELECT CASE
                    WHEN is_company_default THEN '__company__'
                    ELSE technician_uuid::text
                END AS tech_id,
                lat, lng, label, address, street, apt, city, state, zip,
                created_at, updated_at, company_id, technician_uuid,
                is_company_default
         FROM technician_base_locations
         WHERE company_id = $1
         ORDER BY is_company_default DESC, technician_uuid`,
        [companyId]
    );
    return rows;
}

async function upsert(companyId, techId, fields) {
    const identity = await resolveTechnicianIdentity(companyId, techId);
    const { lat, lng, label, address, street, apt, city, state, zip } = fields;
    const { rows } = await db.query(
        `WITH updated AS (
             UPDATE technician_base_locations b
             SET lat = $4, lng = $5, label = $6, address = $7,
                 street = $8, apt = $9, city = $10, state = $11, zip = $12,
                 updated_at = NOW()
             WHERE b.company_id = $1
               AND b.is_company_default = $2
               AND b.technician_uuid IS NOT DISTINCT FROM $3::uuid
             RETURNING b.*
         ), inserted AS (
             INSERT INTO technician_base_locations
                (company_id, is_company_default, technician_uuid, lat, lng, label,
                 address, street, apt, city, state, zip)
             SELECT $1, $2, $3::uuid, $4, $5, $6, $7, $8, $9, $10, $11, $12
             WHERE NOT EXISTS (SELECT 1 FROM updated)
             RETURNING *
         )
         SELECT * FROM updated
         UNION ALL
         SELECT * FROM inserted
         LIMIT 1`,
        [
            companyId, identity.isCompanyDefault, identity.technicianUuid,
            lat, lng, label ?? null, address ?? null, street ?? null, apt ?? null,
            city ?? null, state ?? null, zip ?? null,
        ]
    );
    if (!rows[0]) throw invalidTechnicianIdentityError();
    return {
        ...rows[0],
        tech_id: identity.publicId,
    };
}

async function remove(companyId, techId) {
    const identity = await resolveTechnicianIdentity(companyId, techId, { required: false });
    if (!identity) return null;
    const { rows } = await db.query(
        `DELETE FROM technician_base_locations b
         WHERE b.company_id = $1
           AND b.is_company_default = $2
           AND b.technician_uuid IS NOT DISTINCT FROM $3::uuid
         RETURNING b.id`,
        [companyId, identity.isCompanyDefault, identity.technicianUuid]
    );
    return rows[0] ? { ...rows[0], tech_id: identity.publicId } : null;
}

module.exports = { listByCompany, upsert, remove, resolveTechnicianIdentity };
