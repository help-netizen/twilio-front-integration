/**
 * Company-scoped persistence for TECH-SCHEDULE-001 technician service areas.
 * District and radius maps are independent; every replacement touches one
 * owner side in one table and runs in a transaction.
 */
const db = require('./connection');

function uniqueStrings(values) {
    return Array.from(new Set((values || []).map(value => String(value))));
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
            `SELECT a.technician_id, a.district_name
             FROM technician_district_assignments a
             WHERE a.company_id = $1
               AND EXISTS (
                    SELECT 1
                    FROM service_territories st
                    WHERE st.company_id = a.company_id
                      AND st.area = a.district_name
               )
             ORDER BY a.technician_id, a.district_name`,
            [companyId]
        ),
        db.query(
            `SELECT a.technician_id, a.radius_id
             FROM technician_radius_assignments a
             JOIN territory_radii r
               ON r.company_id = a.company_id
              AND r.id = a.radius_id
             WHERE a.company_id = $1
             ORDER BY a.technician_id, a.radius_id`,
            [companyId]
        ),
    ]);
    return {
        districts: districtResult.rows,
        radii: radiusResult.rows,
    };
}

function invalidTargetError(message) {
    const error = new Error(message);
    error.code = 'INVALID_SERVICE_AREA_TARGET';
    error.httpStatus = 404;
    return error;
}

async function assertDistricts(client, companyId, districtNames) {
    if (districtNames.length === 0) return;
    const { rows } = await client.query(
        `SELECT DISTINCT area
         FROM service_territories
         WHERE company_id = $1
           AND area = ANY($2::text[])`,
        [companyId, districtNames]
    );
    if (rows.length !== districtNames.length) {
        throw invalidTargetError('District not found');
    }
}

async function assertRadii(client, companyId, radiusIds) {
    if (radiusIds.length === 0) return;
    const { rows } = await client.query(
        `SELECT id
         FROM territory_radii
         WHERE company_id = $1
           AND id = ANY($2::uuid[])`,
        [companyId, radiusIds]
    );
    if (rows.length !== radiusIds.length) {
        throw invalidTargetError('Radius not found');
    }
}

async function replaceTechnicianDistricts(companyId, technicianId, districtNames, createdBy) {
    const targets = uniqueStrings(districtNames);
    const client = await db.getClient();
    try {
        await client.query('BEGIN');
        await assertDistricts(client, companyId, targets);
        await client.query(
            `DELETE FROM technician_district_assignments
             WHERE company_id = $1 AND technician_id = $2`,
            [companyId, String(technicianId)]
        );
        if (targets.length > 0) {
            await client.query(
                `INSERT INTO technician_district_assignments
                    (company_id, technician_id, district_name, created_by)
                 SELECT $1, $2, unnest($3::text[]), $4`,
                [companyId, String(technicianId), targets, createdBy || null]
            );
        }
        await client.query('COMMIT');
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
    }
}

async function replaceTechnicianRadii(companyId, technicianId, radiusIds, createdBy) {
    const targets = uniqueStrings(radiusIds);
    const client = await db.getClient();
    try {
        await client.query('BEGIN');
        await assertRadii(client, companyId, targets);
        await client.query(
            `DELETE FROM technician_radius_assignments
             WHERE company_id = $1 AND technician_id = $2`,
            [companyId, String(technicianId)]
        );
        if (targets.length > 0) {
            await client.query(
                `INSERT INTO technician_radius_assignments
                    (company_id, technician_id, radius_id, created_by)
                 SELECT $1, $2, unnest($3::uuid[]), $4`,
                [companyId, String(technicianId), targets, createdBy || null]
            );
        }
        await client.query('COMMIT');
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
    }
}

async function replaceDistrictTechnicians(companyId, districtName, technicianIds, createdBy) {
    const ids = uniqueStrings(technicianIds);
    const client = await db.getClient();
    try {
        await client.query('BEGIN');
        await assertDistricts(client, companyId, [String(districtName)]);
        await client.query(
            `DELETE FROM technician_district_assignments
             WHERE company_id = $1 AND district_name = $2`,
            [companyId, String(districtName)]
        );
        if (ids.length > 0) {
            await client.query(
                `INSERT INTO technician_district_assignments
                    (company_id, technician_id, district_name, created_by)
                 SELECT $1, unnest($2::text[]), $3, $4`,
                [companyId, ids, String(districtName), createdBy || null]
            );
        }
        await client.query('COMMIT');
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
    }
}

async function replaceRadiusTechnicians(companyId, radiusId, technicianIds, createdBy) {
    const ids = uniqueStrings(technicianIds);
    const client = await db.getClient();
    try {
        await client.query('BEGIN');
        await assertRadii(client, companyId, [String(radiusId)]);
        await client.query(
            `DELETE FROM technician_radius_assignments
             WHERE company_id = $1 AND radius_id = $2`,
            [companyId, String(radiusId)]
        );
        if (ids.length > 0) {
            await client.query(
                `INSERT INTO technician_radius_assignments
                    (company_id, technician_id, radius_id, created_by)
                 SELECT $1, unnest($2::text[]), $3, $4`,
                [companyId, ids, String(radiusId), createdBy || null]
            );
        }
        await client.query('COMMIT');
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
    }
}

module.exports = {
    listTargets,
    listValidAssignments,
    replaceTechnicianDistricts,
    replaceTechnicianRadii,
    replaceDistrictTechnicians,
    replaceRadiusTechnicians,
};
