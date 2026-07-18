/**
 * Company-scoped persistence for recurring technician work schedules.
 * TECH-SCHEDULE-001 keeps inherited custom-day rows instead of deleting them.
 */
const db = require('./connection');

const SELECT_COLUMNS = `s.technician_id, s.inherits_company_schedule,
        s.created_by, s.updated_by, s.created_at, s.updated_at,
        d.day_of_week, d.is_working, d.work_start_time, d.work_end_time`;

async function listByTechnicianIds(companyId, technicianIds) {
    const ids = Array.from(new Set((technicianIds || []).map(String).filter(Boolean)));
    if (ids.length === 0) return [];
    const { rows } = await db.query(
        `SELECT ${SELECT_COLUMNS}
         FROM technician_work_schedules s
         LEFT JOIN technician_work_schedule_days d
           ON d.company_id = s.company_id
          AND d.technician_id = s.technician_id
         WHERE s.company_id = $1
           AND s.technician_id = ANY($2::text[])
         ORDER BY s.technician_id, d.day_of_week`,
        [companyId, ids]
    );
    return rows;
}

async function getByTechnicianId(companyId, technicianId) {
    return listByTechnicianIds(companyId, [technicianId]);
}

/**
 * Replace one technician's schedule atomically. When inheritance is enabled,
 * existing child rows are retained so the saved custom week can be restored.
 */
async function replace(companyId, technicianId, { inheritsCompanySchedule, days, updatedBy }) {
    const client = await db.getClient();
    try {
        await client.query('BEGIN');
        await client.query(
            `INSERT INTO technician_work_schedules
                (company_id, technician_id, inherits_company_schedule, created_by, updated_by)
             VALUES ($1, $2, $3, $4, $4)
             ON CONFLICT (company_id, technician_id) DO UPDATE SET
                inherits_company_schedule = EXCLUDED.inherits_company_schedule,
                updated_by = EXCLUDED.updated_by,
                updated_at = NOW()`,
            [companyId, String(technicianId), Boolean(inheritsCompanySchedule), updatedBy || null]
        );

        if (!inheritsCompanySchedule) {
            await client.query(
                `DELETE FROM technician_work_schedule_days
                 WHERE company_id = $1 AND technician_id = $2`,
                [companyId, String(technicianId)]
            );

            const params = [companyId, String(technicianId)];
            const tuples = days.map(day => {
                const base = params.length;
                params.push(
                    day.day_of_week,
                    day.is_working,
                    day.work_start_time,
                    day.work_end_time
                );
                return `($1, $2, $${base + 1}, $${base + 2}, $${base + 3}, $${base + 4})`;
            });
            await client.query(
                `INSERT INTO technician_work_schedule_days
                    (company_id, technician_id, day_of_week, is_working, work_start_time, work_end_time)
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

module.exports = { listByTechnicianIds, getByTechnicianId, replace };

