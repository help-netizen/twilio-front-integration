/**
 * Company-scoped persistence for recurring technician work schedules.
 * TECH-SCHEDULE-001 keeps inherited custom-day rows instead of deleting them.
 */
const db = require('./connection');
const directoryQueries = require('./technicianDirectoryQueries');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const SELECT_COLUMNS = `s.resolved_match_key AS technician_id,
        s.inherits_company_schedule,
        s.created_by, s.updated_by, s.created_at, s.updated_at,
        d.day_of_week, d.is_working, d.work_start_time, d.work_end_time`;

function invalidTechnicianIdentityError() {
    const error = new Error('Technician identity not found');
    error.code = 'TECHNICIAN_IDENTITY_NOT_FOUND';
    error.httpStatus = 404;
    return error;
}

async function resolveTechnicianIdentity(companyId, technicianId, { required = true } = {}) {
    const publicId = technicianId == null ? '' : String(technicianId).trim();
    if (!publicId) {
        if (!required) return null;
        throw invalidTechnicianIdentityError();
    }
    if (UUID_RE.test(publicId)) {
        const technicianUuid = publicId.toLowerCase();
        const externalId = await directoryQueries.resolveUuidToExternal(
            companyId,
            'zenbooker',
            technicianUuid
        );
        return {
            publicId,
            externalId: externalId || technicianUuid,
            technicianUuid,
        };
    }
    const technicianUuid = await directoryQueries.resolveExternalToUuid(
        companyId,
        'zenbooker',
        publicId
    );
    return {
        publicId,
        externalId: publicId,
        technicianUuid: technicianUuid ? String(technicianUuid).toLowerCase() : null,
    };
}

async function listByTechnicianIds(companyId, technicianIds) {
    const ids = Array.from(new Set((technicianIds || []).map(String).filter(Boolean)));
    if (ids.length === 0) return [];
    const identities = (await Promise.all(
        ids.map(id => resolveTechnicianIdentity(companyId, id, { required: false }))
    )).filter(Boolean);
    if (identities.length === 0) return [];
    const publicIdByMatchKey = new Map(
        identities.map(identity => [
            identity.technicianUuid || identity.externalId,
            identity.publicId,
        ])
    );
    const { rows } = await db.query(
        `WITH resolved_schedules AS (
             SELECT s.*,
                    COALESCE(
                        s.technician_uuid::text,
                        e.technician_id::text,
                        s.technician_id
                    ) AS resolved_match_key
             FROM technician_work_schedules s
             LEFT JOIN technician_external_identities e
               ON s.technician_uuid IS NULL
              AND e.company_id = s.company_id
              AND e.source = 'zenbooker'
              AND e.external_id = s.technician_id
             WHERE s.company_id = $1
         ), resolved_days AS (
             SELECT d.*,
                    COALESCE(
                        d.technician_uuid::text,
                        e.technician_id::text,
                        d.technician_id
                    ) AS resolved_match_key
             FROM technician_work_schedule_days d
             LEFT JOIN technician_external_identities e
               ON d.technician_uuid IS NULL
              AND e.company_id = d.company_id
              AND e.source = 'zenbooker'
              AND e.external_id = d.technician_id
             WHERE d.company_id = $1
         )
         SELECT ${SELECT_COLUMNS}
         FROM resolved_schedules s
         LEFT JOIN resolved_days d
           ON d.company_id = s.company_id
          AND d.resolved_match_key = s.resolved_match_key
         WHERE s.resolved_match_key = ANY($2::text[])
         ORDER BY s.resolved_match_key, d.day_of_week`,
        [
            companyId,
            identities.map(identity => identity.technicianUuid || identity.externalId),
        ]
    );
    return rows.map(row => ({
        ...row,
        technician_id: publicIdByMatchKey.get(String(row.technician_id)) || String(row.technician_id),
    }));
}

async function getByTechnicianId(companyId, technicianId) {
    return listByTechnicianIds(companyId, [technicianId]);
}

/**
 * Replace one technician's schedule atomically. When inheritance is enabled,
 * existing child rows are retained so the saved custom week can be restored.
 */
async function replace(companyId, technicianId, { inheritsCompanySchedule, days, updatedBy }) {
    const identity = await resolveTechnicianIdentity(companyId, technicianId);
    const client = await db.getClient();
    try {
        await client.query('BEGIN');
        let parent = await client.query(
            `UPDATE technician_work_schedules s
             SET technician_uuid = $3::uuid,
                 inherits_company_schedule = $4,
                 updated_by = $5,
                 updated_at = NOW()
             WHERE s.company_id = $1
               AND (
                    ($3::uuid IS NULL AND s.technician_uuid IS NULL AND s.technician_id = $2)
                    OR s.technician_uuid = $3::uuid
                    OR (
                        s.technician_uuid IS NULL
                        AND EXISTS (
                            SELECT 1
                            FROM technician_external_identities e
                            WHERE e.company_id = s.company_id
                              AND e.source = 'zenbooker'
                              AND e.external_id = s.technician_id
                              AND e.technician_id = $3::uuid
                        )
                    )
               )
             RETURNING s.technician_id`,
            [
                companyId,
                identity.externalId,
                identity.technicianUuid,
                Boolean(inheritsCompanySchedule),
                updatedBy || null,
            ]
        );
        if (!parent.rows[0]) {
            parent = await client.query(
                `INSERT INTO technician_work_schedules
                    (company_id, technician_id, technician_uuid,
                     inherits_company_schedule, created_by, updated_by)
                 VALUES ($1, $2, $3::uuid, $4, $5, $5)
                 ON CONFLICT (company_id, technician_id) DO UPDATE SET
                    technician_uuid = EXCLUDED.technician_uuid,
                    inherits_company_schedule = EXCLUDED.inherits_company_schedule,
                    updated_by = EXCLUDED.updated_by,
                    updated_at = NOW()
                 WHERE technician_work_schedules.technician_uuid IS NULL
                    OR technician_work_schedules.technician_uuid = EXCLUDED.technician_uuid
                 RETURNING technician_work_schedules.technician_id`,
                [
                    companyId,
                    identity.externalId,
                    identity.technicianUuid,
                    Boolean(inheritsCompanySchedule),
                    updatedBy || null,
                ]
            );
        }
        if (!parent.rows[0]) throw invalidTechnicianIdentityError();

        await client.query(
            `UPDATE technician_work_schedule_days d
             SET technician_uuid = $3::uuid
             WHERE d.company_id = $1
               AND (
                    ($3::uuid IS NULL AND d.technician_uuid IS NULL AND d.technician_id = $2)
                    OR d.technician_uuid = $3::uuid
                    OR (
                        d.technician_uuid IS NULL
                        AND EXISTS (
                            SELECT 1
                            FROM technician_external_identities e
                            WHERE e.company_id = d.company_id
                              AND e.source = 'zenbooker'
                              AND e.external_id = d.technician_id
                              AND e.technician_id = $3::uuid
                        )
                    )
               )`,
            [companyId, identity.externalId, identity.technicianUuid]
        );

        if (!inheritsCompanySchedule) {
            await client.query(
                `DELETE FROM technician_work_schedule_days d
                 WHERE d.company_id = $1
                   AND (
                        ($3::uuid IS NULL AND d.technician_uuid IS NULL AND d.technician_id = $2)
                        OR d.technician_uuid = $3::uuid
                        OR (
                            d.technician_uuid IS NULL
                            AND EXISTS (
                                SELECT 1
                                FROM technician_external_identities e
                                WHERE e.company_id = d.company_id
                                  AND e.source = 'zenbooker'
                                  AND e.external_id = d.technician_id
                                  AND e.technician_id = $3::uuid
                            )
                        )
                   )`,
                [companyId, identity.externalId, identity.technicianUuid]
            );

            const params = [companyId, identity.externalId, identity.technicianUuid];
            const tuples = days.map(day => {
                const base = params.length;
                params.push(
                    day.day_of_week,
                    day.is_working,
                    day.work_start_time,
                    day.work_end_time
                );
                return `($1, $2, $3::uuid, $${base + 1}, $${base + 2}, $${base + 3}, $${base + 4})`;
            });
            await client.query(
                `INSERT INTO technician_work_schedule_days
                    (company_id, technician_id, technician_uuid,
                     day_of_week, is_working, work_start_time, work_end_time)
                 VALUES ${tuples.join(', ')}`,
                params
            );
        }

        await client.query('COMMIT');
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    } finally {
        client.release();
    }
}

module.exports = {
    listByTechnicianIds,
    getByTechnicianId,
    replace,
    resolveTechnicianIdentity,
};
