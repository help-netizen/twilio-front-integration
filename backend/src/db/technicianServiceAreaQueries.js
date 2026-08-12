/** Company-scoped technician service areas keyed only by technicians.id. */
const db = require('./connection');
const directoryQueries = require('./technicianDirectoryQueries');

function uniqueStrings(values) {
    return Array.from(new Set((values || []).map(value => String(value))));
}

function invalidTargetError(message) {
    const error = new Error(message);
    error.code = 'INVALID_SERVICE_AREA_TARGET';
    error.httpStatus = 404;
    return error;
}

function invalidTechnicianIdentityError(message = 'Technician identity not found') {
    const error = new Error(message);
    error.code = 'TECHNICIAN_IDENTITY_NOT_FOUND';
    error.httpStatus = 404;
    return error;
}

async function resolveTechnicianIdentity(companyId, technicianId) {
    const technicianUuid = await directoryQueries.resolveTechnicianUuid(
        companyId,
        technicianId,
        'zenbooker'
    );
    if (!technicianUuid) throw invalidTechnicianIdentityError();
    return String(technicianUuid).toLowerCase();
}

async function resolveTechnicianIdentities(companyId, technicianIds) {
    return Array.from(new Set(await Promise.all(
        uniqueStrings(technicianIds).map(id => resolveTechnicianIdentity(companyId, id))
    )));
}

async function listTargets(companyId) {
    const [districtResult, radiusResult] = await Promise.all([
        db.query(
            `SELECT DISTINCT area AS id
             FROM service_territories
             WHERE company_id = $1
             ORDER BY area ASC`,
            [companyId]
        ),
        db.query(
            `SELECT id, zip, radius_miles, lat, lon, position
             FROM territory_radii
             WHERE company_id = $1
             ORDER BY position ASC, created_at ASC, id ASC`,
            [companyId]
        ),
    ]);
    return {
        districts: districtResult.rows.map(row => ({
            id: row.id,
            name: row.id || 'Uncategorized ZIPs',
        })),
        radii: radiusResult.rows,
    };
}

async function listValidAssignments(companyId) {
    const [districtResult, radiusResult] = await Promise.all([
        db.query(
            `SELECT a.technician_uuid::text AS technician_id, a.district_name
             FROM technician_district_assignments a
             WHERE a.company_id = $1
               AND EXISTS (
                    SELECT 1 FROM service_territories st
                    WHERE st.company_id = a.company_id
                      AND st.area = a.district_name
               )
             ORDER BY a.technician_uuid, a.district_name`,
            [companyId]
        ),
        db.query(
            `SELECT a.technician_uuid::text AS technician_id, a.radius_id
             FROM technician_radius_assignments a
             JOIN territory_radii r
               ON r.company_id = a.company_id AND r.id = a.radius_id
             WHERE a.company_id = $1
             ORDER BY a.technician_uuid, a.radius_id`,
            [companyId]
        ),
    ]);
    return { districts: districtResult.rows, radii: radiusResult.rows };
}

async function assertDistricts(client, companyId, districtNames) {
    if (districtNames.length === 0) return;
    const { rows } = await client.query(
        `SELECT DISTINCT area FROM service_territories
         WHERE company_id = $1 AND area = ANY($2::text[])`,
        [companyId, districtNames]
    );
    if (rows.length !== districtNames.length) throw invalidTargetError('District not found');
}

async function assertRadii(client, companyId, radiusIds) {
    if (radiusIds.length === 0) return;
    const { rows } = await client.query(
        `SELECT id FROM territory_radii
         WHERE company_id = $1 AND id = ANY($2::uuid[])`,
        [companyId, radiusIds]
    );
    if (rows.length !== radiusIds.length) throw invalidTargetError('Radius not found');
}

async function withTransaction(work) {
    const client = await db.getClient();
    try {
        await client.query('BEGIN');
        const result = await work(client);
        await client.query('COMMIT');
        return result;
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
    }
}

async function replaceTechnicianDistricts(companyId, technicianId, districtNames, createdBy) {
    const targets = uniqueStrings(districtNames);
    const technicianUuid = await resolveTechnicianIdentity(companyId, technicianId);
    return withTransaction(async client => {
        await assertDistricts(client, companyId, targets);
        await client.query(
            `DELETE FROM technician_district_assignments
             WHERE company_id = $1 AND technician_uuid = $2::uuid`,
            [companyId, technicianUuid]
        );
        if (targets.length > 0) {
            await client.query(
                `INSERT INTO technician_district_assignments
                    (company_id, technician_uuid, district_name, created_by)
                 SELECT $1, $2::uuid, unnest($3::text[]), $4`,
                [companyId, technicianUuid, targets, createdBy || null]
            );
        }
    });
}

async function replaceTechnicianRadii(companyId, technicianId, radiusIds, createdBy) {
    const targets = uniqueStrings(radiusIds);
    const technicianUuid = await resolveTechnicianIdentity(companyId, technicianId);
    return withTransaction(async client => {
        await assertRadii(client, companyId, targets);
        await client.query(
            `DELETE FROM technician_radius_assignments
             WHERE company_id = $1 AND technician_uuid = $2::uuid`,
            [companyId, technicianUuid]
        );
        if (targets.length > 0) {
            await client.query(
                `INSERT INTO technician_radius_assignments
                    (company_id, technician_uuid, radius_id, created_by)
                 SELECT $1, $2::uuid, unnest($3::uuid[]), $4`,
                [companyId, technicianUuid, targets, createdBy || null]
            );
        }
    });
}

async function replaceDistrictTechnicians(companyId, districtName, technicianIds, createdBy) {
    const technicianUuids = await resolveTechnicianIdentities(companyId, technicianIds);
    return withTransaction(async client => {
        await assertDistricts(client, companyId, [String(districtName)]);
        await client.query(
            `DELETE FROM technician_district_assignments
             WHERE company_id = $1 AND district_name = $2`,
            [companyId, String(districtName)]
        );
        if (technicianUuids.length > 0) {
            await client.query(
                `INSERT INTO technician_district_assignments
                    (company_id, technician_uuid, district_name, created_by)
                 SELECT $1, unnest($2::uuid[]), $3, $4`,
                [companyId, technicianUuids, String(districtName), createdBy || null]
            );
        }
    });
}

async function replaceRadiusTechnicians(companyId, radiusId, technicianIds, createdBy) {
    const technicianUuids = await resolveTechnicianIdentities(companyId, technicianIds);
    return withTransaction(async client => {
        await assertRadii(client, companyId, [String(radiusId)]);
        await client.query(
            `DELETE FROM technician_radius_assignments
             WHERE company_id = $1 AND radius_id = $2::uuid`,
            [companyId, String(radiusId)]
        );
        if (technicianUuids.length > 0) {
            await client.query(
                `INSERT INTO technician_radius_assignments
                    (company_id, technician_uuid, radius_id, created_by)
                 SELECT $1, unnest($2::uuid[]), $3::uuid, $4`,
                [companyId, technicianUuids, String(radiusId), createdBy || null]
            );
        }
    });
}

async function listWildcardTechnicians(companyId) {
    const { rows } = await db.query(
        `SELECT technician_uuid::text AS technician_id
         FROM technician_area_wildcards
         WHERE company_id = $1`,
        [companyId]
    );
    return rows.map(row => String(row.technician_id));
}

async function setWildcardTechnician(companyId, technicianId, servesAll, createdBy) {
    const technicianUuid = await resolveTechnicianIdentity(companyId, technicianId);
    if (servesAll) {
        await db.query(
            `INSERT INTO technician_area_wildcards
                (company_id, technician_uuid, created_by)
             VALUES ($1, $2::uuid, $3)
             ON CONFLICT (company_id, technician_uuid) DO NOTHING`,
            [companyId, technicianUuid, createdBy || null]
        );
        return;
    }
    await db.query(
        `DELETE FROM technician_area_wildcards
         WHERE company_id = $1 AND technician_uuid = $2::uuid`,
        [companyId, technicianUuid]
    );
}

module.exports = {
    listTargets,
    listValidAssignments,
    listWildcardTechnicians,
    setWildcardTechnician,
    replaceTechnicianDistricts,
    replaceTechnicianRadii,
    replaceDistrictTechnicians,
    replaceRadiusTechnicians,
};
