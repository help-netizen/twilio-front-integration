/** Company-scoped recurring work schedules keyed only by technicians.id. */
const db = require('./connection');
const directoryQueries = require('./technicianDirectoryQueries');

function invalidTechnicianIdentityError() {
    const error = new Error('Technician identity not found');
    error.code = 'TECHNICIAN_IDENTITY_NOT_FOUND';
    error.httpStatus = 404;
    return error;
}

async function resolveTechnicianIdentity(companyId, technicianId, { required = true } = {}) {
    const input = technicianId == null ? '' : String(technicianId).trim();
    if (!input) {
        if (!required) return null;
        throw invalidTechnicianIdentityError();
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
        publicId: String(technicianUuid).toLowerCase(),
        technicianUuid: String(technicianUuid).toLowerCase(),
    };
}

async function listByTechnicianIds(companyId, technicianIds) {
    const inputs = Array.from(new Set((technicianIds || []).map(String).filter(Boolean)));
    if (inputs.length === 0) return [];
    const identities = (await Promise.all(
        inputs.map(id => resolveTechnicianIdentity(companyId, id, { required: false }))
    )).filter(Boolean);
    if (identities.length === 0) return [];
    const { rows } = await db.query(
        `SELECT s.technician_uuid::text AS technician_id,
                s.inherits_company_schedule,
                s.created_by, s.updated_by, s.created_at, s.updated_at,
                d.day_of_week, d.is_working, d.work_start_time, d.work_end_time
         FROM technician_work_schedules s
         LEFT JOIN technician_work_schedule_days d
           ON d.company_id = s.company_id
          AND d.technician_uuid = s.technician_uuid
         WHERE s.company_id = $1
           AND s.technician_uuid = ANY($2::uuid[])
         ORDER BY s.technician_uuid, d.day_of_week`,
        [companyId, identities.map(identity => identity.technicianUuid)]
    );
    return rows;
}

async function getByTechnicianId(companyId, technicianId) {
    return listByTechnicianIds(companyId, [technicianId]);
}

/** Replace one technician's schedule atomically; inherited custom days survive. */
async function replace(companyId, technicianId, { inheritsCompanySchedule, days, updatedBy }) {
    const identity = await resolveTechnicianIdentity(companyId, technicianId);
    const client = await db.getClient();
    try {
        await client.query('BEGIN');
        await client.query(
            `INSERT INTO technician_work_schedules
                (company_id, technician_uuid, inherits_company_schedule,
                 created_by, updated_by)
             VALUES ($1, $2::uuid, $3, $4, $4)
             ON CONFLICT (company_id, technician_uuid) DO UPDATE SET
                inherits_company_schedule = EXCLUDED.inherits_company_schedule,
                updated_by = EXCLUDED.updated_by,
                updated_at = NOW()`,
            [
                companyId,
                identity.technicianUuid,
                Boolean(inheritsCompanySchedule),
                updatedBy || null,
            ]
        );

        if (!inheritsCompanySchedule) {
            await client.query(
                `DELETE FROM technician_work_schedule_days
                 WHERE company_id = $1 AND technician_uuid = $2::uuid`,
                [companyId, identity.technicianUuid]
            );
            if (days.length > 0) {
                const params = [companyId, identity.technicianUuid];
                const tuples = days.map(day => {
                    const base = params.length;
                    params.push(
                        day.day_of_week,
                        day.is_working,
                        day.work_start_time,
                        day.work_end_time
                    );
                    return `($1, $2::uuid, $${base + 1}, $${base + 2}, $${base + 3}, $${base + 4})`;
                });
                await client.query(
                    `INSERT INTO technician_work_schedule_days
                        (company_id, technician_uuid, day_of_week, is_working,
                         work_start_time, work_end_time)
                     VALUES ${tuples.join(', ')}`,
                    params
                );
            }
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
    listByTechnicianIds,
    getByTechnicianId,
    replace,
    resolveTechnicianIdentity,
};
