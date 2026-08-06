/**
 * Company-scoped persistence for TECH-SCHEDULE-001 technician service areas.
 * District and radius maps are independent; every replacement touches one
 * owner side in one table and runs in a transaction.
 */
const db = require('./connection');
const directoryQueries = require('./technicianDirectoryQueries');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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
            `SELECT COALESCE(a.technician_uuid, e.technician_id) AS technician_id,
                    a.district_name
             FROM technician_district_assignments a
             LEFT JOIN technician_external_identities e
               ON a.technician_uuid IS NULL
              AND e.company_id = a.company_id
              AND e.source = 'zenbooker'
              AND e.external_id = a.technician_id
             WHERE a.company_id = $1
               AND COALESCE(a.technician_uuid, e.technician_id) IS NOT NULL
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
            `SELECT COALESCE(a.technician_uuid, e.technician_id) AS technician_id,
                    a.radius_id
             FROM technician_radius_assignments a
             LEFT JOIN technician_external_identities e
               ON a.technician_uuid IS NULL
              AND e.company_id = a.company_id
              AND e.source = 'zenbooker'
              AND e.external_id = a.technician_id
             JOIN territory_radii r
               ON r.company_id = a.company_id
              AND r.id = a.radius_id
             WHERE a.company_id = $1
               AND COALESCE(a.technician_uuid, e.technician_id) IS NOT NULL
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

function invalidTechnicianIdentityError(message = 'Technician identity not found') {
    const error = new Error(message);
    error.code = 'TECHNICIAN_IDENTITY_NOT_FOUND';
    error.httpStatus = 404;
    return error;
}

async function resolveTechnicianIdentity(companyId, technicianId) {
    const id = String(technicianId);
    if (UUID_RE.test(id)) {
        const technicianUuid = id.toLowerCase();
        const externalId = await directoryQueries.resolveUuidToExternal(
            companyId,
            'zenbooker',
            technicianUuid
        );
        return { externalId: externalId || technicianUuid, technicianUuid };
    }
    const technicianUuid = await directoryQueries.resolveExternalToUuid(
        companyId,
        'zenbooker',
        id
    );
    if (!technicianUuid) throw invalidTechnicianIdentityError();
    return { externalId: id, technicianUuid: String(technicianUuid).toLowerCase() };
}

async function resolveTechnicianIdentities(companyId, technicianIds) {
    const identities = await Promise.all(
        uniqueStrings(technicianIds).map(id => resolveTechnicianIdentity(companyId, id))
    );
    const byUuid = new Map();
    for (const identity of identities) {
        if (!byUuid.has(identity.technicianUuid)) {
            byUuid.set(identity.technicianUuid, identity);
        }
    }
    return Array.from(byUuid.values());
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
    const identity = await resolveTechnicianIdentity(companyId, technicianId);
    const client = await db.getClient();
    try {
        await client.query('BEGIN');
        await assertDistricts(client, companyId, targets);
        await client.query(
            `DELETE FROM technician_district_assignments a
             WHERE a.company_id = $1
               AND (
                    a.technician_uuid = $2::uuid
                    OR (
                        a.technician_uuid IS NULL
                        AND EXISTS (
                            SELECT 1
                            FROM technician_external_identities e
                            WHERE e.company_id = a.company_id
                              AND e.source = 'zenbooker'
                              AND e.external_id = a.technician_id
                              AND e.technician_id = $2::uuid
                        )
                    )
               )`,
            [companyId, identity.technicianUuid]
        );
        if (targets.length > 0) {
            await client.query(
                `INSERT INTO technician_district_assignments
                    (company_id, technician_id, technician_uuid, district_name, created_by)
                 SELECT $1, $2, $3::uuid, unnest($4::text[]), $5`,
                [companyId, identity.externalId, identity.technicianUuid, targets, createdBy || null]
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
    const identity = await resolveTechnicianIdentity(companyId, technicianId);
    const client = await db.getClient();
    try {
        await client.query('BEGIN');
        await assertRadii(client, companyId, targets);
        await client.query(
            `DELETE FROM technician_radius_assignments a
             WHERE a.company_id = $1
               AND (
                    a.technician_uuid = $2::uuid
                    OR (
                        a.technician_uuid IS NULL
                        AND EXISTS (
                            SELECT 1
                            FROM technician_external_identities e
                            WHERE e.company_id = a.company_id
                              AND e.source = 'zenbooker'
                              AND e.external_id = a.technician_id
                              AND e.technician_id = $2::uuid
                        )
                    )
               )`,
            [companyId, identity.technicianUuid]
        );
        if (targets.length > 0) {
            await client.query(
                `INSERT INTO technician_radius_assignments
                    (company_id, technician_id, technician_uuid, radius_id, created_by)
                 SELECT $1, $2, $3::uuid, unnest($4::uuid[]), $5`,
                [companyId, identity.externalId, identity.technicianUuid, targets, createdBy || null]
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
    const identities = await resolveTechnicianIdentities(companyId, technicianIds);
    const client = await db.getClient();
    try {
        await client.query('BEGIN');
        await assertDistricts(client, companyId, [String(districtName)]);
        await client.query(
            `DELETE FROM technician_district_assignments
             WHERE company_id = $1 AND district_name = $2`,
            [companyId, String(districtName)]
        );
        if (identities.length > 0) {
            await client.query(
                `INSERT INTO technician_district_assignments
                    (company_id, technician_id, technician_uuid, district_name, created_by)
                 SELECT $1, i.technician_id, i.technician_uuid, $4, $5
                 FROM unnest($2::text[], $3::uuid[])
                    AS i(technician_id, technician_uuid)`,
                [
                    companyId,
                    identities.map(identity => identity.externalId),
                    identities.map(identity => identity.technicianUuid),
                    String(districtName),
                    createdBy || null,
                ]
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
    const identities = await resolveTechnicianIdentities(companyId, technicianIds);
    const client = await db.getClient();
    try {
        await client.query('BEGIN');
        await assertRadii(client, companyId, [String(radiusId)]);
        await client.query(
            `DELETE FROM technician_radius_assignments
             WHERE company_id = $1 AND radius_id = $2`,
            [companyId, String(radiusId)]
        );
        if (identities.length > 0) {
            await client.query(
                `INSERT INTO technician_radius_assignments
                    (company_id, technician_id, technician_uuid, radius_id, created_by)
                 SELECT $1, i.technician_id, i.technician_uuid, $4::uuid, $5
                 FROM unnest($2::text[], $3::uuid[])
                    AS i(technician_id, technician_uuid)`,
                [
                    companyId,
                    identities.map(identity => identity.externalId),
                    identities.map(identity => identity.technicianUuid),
                    String(radiusId),
                    createdBy || null,
                ]
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

/**
 * ZONE-STRICT-001 — the explicit "works across the whole territory" mark.
 * A row here is the ONLY thing that makes a technician eligible outside their
 * assigned districts/radii; absence of assignments no longer means "everywhere".
 */
async function listWildcardTechnicians(companyId) {
    const { rows } = await db.query(
        `SELECT COALESCE(w.technician_uuid, e.technician_id) AS technician_id
         FROM technician_area_wildcards w
         LEFT JOIN technician_external_identities e
           ON w.technician_uuid IS NULL
          AND e.company_id = w.company_id
          AND e.source = 'zenbooker'
          AND e.external_id = w.technician_id
         WHERE w.company_id = $1
           AND COALESCE(w.technician_uuid, e.technician_id) IS NOT NULL`,
        [companyId]
    );
    return rows.map(row => String(row.technician_id));
}

async function setWildcardTechnician(companyId, technicianId, servesAll, createdBy) {
    const identity = await resolveTechnicianIdentity(companyId, technicianId);
    if (servesAll) {
        const { rows } = await db.query(
            `INSERT INTO technician_area_wildcards
                (company_id, technician_id, technician_uuid, created_by)
             VALUES ($1, $2, $3::uuid, $4)
             ON CONFLICT (company_id, technician_id) DO UPDATE SET
                technician_uuid = EXCLUDED.technician_uuid
             WHERE technician_area_wildcards.technician_uuid IS NULL
                OR technician_area_wildcards.technician_uuid = EXCLUDED.technician_uuid
             RETURNING technician_uuid`,
            [companyId, identity.externalId, identity.technicianUuid, createdBy || null]
        );
        if (!rows[0]) throw invalidTechnicianIdentityError('Technician identity conflicts with existing wildcard');
        return;
    }
    await db.query(
        `DELETE FROM technician_area_wildcards w
         WHERE w.company_id = $1
           AND (
                w.technician_uuid = $2::uuid
                OR (
                    w.technician_uuid IS NULL
                    AND EXISTS (
                        SELECT 1
                        FROM technician_external_identities e
                        WHERE e.company_id = w.company_id
                          AND e.source = 'zenbooker'
                          AND e.external_id = w.technician_id
                          AND e.technician_id = $2::uuid
                    )
                )
           )`,
        [companyId, identity.technicianUuid]
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
