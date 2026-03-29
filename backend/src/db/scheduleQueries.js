/**
 * Schedule Queries Module
 * PF001 Schedule / Dispatcher MVP — Sprint 2
 *
 * Unified read model over jobs + leads + tasks for the schedule/dispatch view.
 */
const db = require('./connection');

// =============================================================================
// Unified schedule items query
// =============================================================================

/**
 * Fetch schedule items (jobs, leads, tasks) with dynamic filters.
 *
 * @param {Object} opts
 * @param {string}   opts.companyId      - required
 * @param {string}  [opts.startDate]     - ISO date/datetime lower bound on start_at
 * @param {string}  [opts.endDate]       - ISO date/datetime upper bound on start_at
 * @param {string[]}[opts.entityTypes]   - subset of ['job','lead','task']
 * @param {string[]}[opts.statuses]      - filter by status values
 * @param {string}  [opts.assigneeId]    - filter by assigned provider
 * @param {boolean} [opts.unassignedOnly]- only items with no assignee
 * @param {string}  [opts.search]        - text search on title / subtitle
 * @param {number}  [opts.limit]         - pagination limit (default 200)
 * @param {number}  [opts.offset]        - pagination offset (default 0)
 * @returns {Promise<{rows: object[], total: number}>}
 */
async function getScheduleItems(opts) {
    const {
        companyId,
        startDate,
        endDate,
        entityTypes,
        statuses,
        assigneeId,
        unassignedOnly,
        search,
        limit = 200,
        offset = 0,
    } = opts;

    // Build each sub-query independently so we can skip entire UNION branches
    const wantJob  = !entityTypes || entityTypes.includes('job');
    const wantLead = !entityTypes || entityTypes.includes('lead');
    const wantTask = !entityTypes || entityTypes.includes('task');

    const unions = [];
    const params = [companyId]; // $1 is always companyId
    let idx = 1;

    // ── Jobs ────────────────────────────────────────────────────────────────
    if (wantJob) {
        const jobConds = [`j.company_id = $1`, `j.blanc_status NOT IN ('cancelled')`];

        if (startDate) {
            idx++; jobConds.push(`j.start_date >= $${idx}`); params.push(startDate);
        }
        if (endDate) {
            idx++; jobConds.push(`j.start_date <= $${idx}`); params.push(endDate);
        }
        if (statuses && statuses.length) {
            const ph = statuses.map(() => { idx++; return `$${idx}`; });
            jobConds.push(`j.blanc_status IN (${ph.join(',')})`);
            params.push(...statuses);
        }
        if (assigneeId) {
            idx++; jobConds.push(`j.assigned_techs @> $${idx}::jsonb`);
            params.push(JSON.stringify([{ id: assigneeId }]));
        }
        if (unassignedOnly) {
            jobConds.push(`(j.assigned_techs IS NULL OR j.assigned_techs = '[]'::jsonb)`);
        }
        if (search) {
            idx++; jobConds.push(`(COALESCE(j.service_name,'') || ' ' || COALESCE(j.customer_name,'')) ILIKE $${idx}`);
            params.push(`%${search}%`);
        }

        unions.push(`
            SELECT
                'job' AS entity_type,
                j.id AS entity_id,
                COALESCE(j.service_name, 'Job #' || j.job_number) AS title,
                j.customer_name AS subtitle,
                j.blanc_status AS status,
                j.start_date AS start_at,
                j.end_date AS end_at,
                j.address AS address_summary,
                j.customer_name, j.customer_phone, j.customer_email,
                j.assigned_techs,
                j.job_type,
                j.job_source,
                j.tags,
                j.company_id,
                j.created_at
            FROM jobs j
            WHERE ${jobConds.join(' AND ')}
        `);
    }

    // ── Leads ───────────────────────────────────────────────────────────────
    if (wantLead) {
        const leadConds = [`l.company_id = $1`, `l.status NOT IN ('converted','lost','spam')`];

        if (startDate) {
            idx++; leadConds.push(`l.lead_date_time >= $${idx}`); params.push(startDate);
        }
        if (endDate) {
            idx++; leadConds.push(`l.lead_date_time <= $${idx}`); params.push(endDate);
        }
        if (statuses && statuses.length) {
            const ph = statuses.map(() => { idx++; return `$${idx}`; });
            leadConds.push(`l.status IN (${ph.join(',')})`);
            params.push(...statuses);
        }
        if (unassignedOnly) {
            // leads don't have an assigned provider field in this schema
            leadConds.push('TRUE'); // no-op, always include
        }
        if (search) {
            idx++; leadConds.push(`(COALESCE(l.first_name,'') || ' ' || COALESCE(l.last_name,'') || ' ' || COALESCE(l.job_type,'')) ILIKE $${idx}`);
            params.push(`%${search}%`);
        }

        unions.push(`
            SELECT
                'lead' AS entity_type,
                l.id AS entity_id,
                COALESCE(l.job_type, 'Lead') || ' — ' || COALESCE(l.first_name || ' ' || l.last_name, 'Unknown') AS title,
                COALESCE(l.first_name || ' ' || l.last_name, l.email, l.phone) AS subtitle,
                l.status,
                l.lead_date_time AS start_at,
                l.lead_end_date_time AS end_at,
                COALESCE(l.address, '') || CASE WHEN l.city IS NOT NULL THEN ', ' || l.city ELSE '' END AS address_summary,
                COALESCE(l.first_name || ' ' || l.last_name, '') AS customer_name,
                l.phone AS customer_phone,
                l.email AS customer_email,
                NULL::jsonb AS assigned_techs,
                l.job_type,
                l.job_source,
                NULL::jsonb AS tags,
                l.company_id,
                l.created_at
            FROM leads l
            WHERE ${leadConds.join(' AND ')}
        `);
    }

    // ── Tasks ───────────────────────────────────────────────────────────────
    if (wantTask) {
        const taskConds = [`t.company_id = $1`, `t.show_on_schedule = true`, `t.status = 'open'`];

        if (startDate) {
            idx++; taskConds.push(`t.start_at >= $${idx}`); params.push(startDate);
        }
        if (endDate) {
            idx++; taskConds.push(`t.start_at <= $${idx}`); params.push(endDate);
        }
        if (statuses && statuses.length) {
            const ph = statuses.map(() => { idx++; return `$${idx}`; });
            taskConds.push(`t.status IN (${ph.join(',')})`);
            params.push(...statuses);
        }
        if (assigneeId) {
            idx++; taskConds.push(`t.assigned_provider_id = $${idx}`);
            params.push(assigneeId);
        }
        if (unassignedOnly) {
            taskConds.push(`t.assigned_provider_id IS NULL`);
        }
        if (search) {
            idx++; taskConds.push(`t.title ILIKE $${idx}`);
            params.push(`%${search}%`);
        }

        unions.push(`
            SELECT
                'task' AS entity_type,
                t.id AS entity_id,
                t.title,
                '' AS subtitle,
                t.status,
                t.start_at,
                t.end_at,
                '' AS address_summary,
                '' AS customer_name,
                '' AS customer_phone,
                '' AS customer_email,
                NULL::jsonb AS assigned_techs,
                NULL AS job_type,
                NULL AS job_source,
                NULL::jsonb AS tags,
                t.company_id,
                t.created_at
            FROM tasks t
            WHERE ${taskConds.join(' AND ')}
        `);
    }

    if (unions.length === 0) {
        return { rows: [], total: 0 };
    }

    const innerSql = unions.join('\nUNION ALL\n');

    // Count query
    const countSql = `SELECT COUNT(*) AS total FROM (${innerSql}) _u`;
    const countResult = await db.query(countSql, params);
    const total = parseInt(countResult.rows[0].total, 10);

    // Data query with sort + pagination
    idx++; const limitParam = idx;  params.push(limit);
    idx++; const offsetParam = idx; params.push(offset);

    const dataSql = `
        SELECT * FROM (${innerSql}) _u
        ORDER BY start_at ASC NULLS LAST, created_at DESC
        LIMIT $${limitParam} OFFSET $${offsetParam}
    `;
    const dataResult = await db.query(dataSql, params);

    return { rows: dataResult.rows, total };
}

// =============================================================================
// Dispatch settings
// =============================================================================

async function getDispatchSettings(companyId) {
    const { rows } = await db.query(
        `SELECT * FROM dispatch_settings WHERE company_id = $1`,
        [companyId]
    );
    return rows[0] || null;
}

async function upsertDispatchSettings(companyId, settings) {
    const {
        timezone,
        work_start_time,
        work_end_time,
        work_days,
        slot_duration,
        buffer_minutes,
        settings_json,
    } = settings;

    const { rows } = await db.query(
        `INSERT INTO dispatch_settings (company_id, timezone, work_start_time, work_end_time, work_days, slot_duration, buffer_minutes, settings_json)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (company_id)
         DO UPDATE SET
            timezone        = COALESCE($2, dispatch_settings.timezone),
            work_start_time = COALESCE($3, dispatch_settings.work_start_time),
            work_end_time   = COALESCE($4, dispatch_settings.work_end_time),
            work_days       = COALESCE($5, dispatch_settings.work_days),
            slot_duration   = COALESCE($6, dispatch_settings.slot_duration),
            buffer_minutes  = COALESCE($7, dispatch_settings.buffer_minutes),
            settings_json   = COALESCE($8, dispatch_settings.settings_json),
            updated_at      = NOW()
         RETURNING *`,
        [
            companyId,
            timezone || null,
            work_start_time || null,
            work_end_time || null,
            work_days || null,
            slot_duration != null ? slot_duration : null,
            buffer_minutes != null ? buffer_minutes : null,
            settings_json ? JSON.stringify(settings_json) : null,
        ]
    );
    return rows[0];
}

// =============================================================================
// Single-entity lookups (for detail / reschedule / reassign)
// =============================================================================

async function getJobRow(companyId, entityId) {
    const { rows } = await db.query(
        `SELECT * FROM jobs WHERE id = $1 AND company_id = $2`,
        [entityId, companyId]
    );
    return rows[0] || null;
}

async function getLeadRow(companyId, entityId) {
    const { rows } = await db.query(
        `SELECT * FROM leads WHERE id = $1 AND company_id = $2`,
        [entityId, companyId]
    );
    return rows[0] || null;
}

async function getTaskRow(companyId, entityId) {
    const { rows } = await db.query(
        `SELECT * FROM tasks WHERE id = $1 AND company_id = $2`,
        [entityId, companyId]
    );
    return rows[0] || null;
}

// =============================================================================
// Reschedule mutations
// =============================================================================

async function rescheduleJob(companyId, entityId, startAt, endAt) {
    const { rows } = await db.query(
        `UPDATE jobs SET start_date = $3, end_date = $4, updated_at = NOW()
         WHERE id = $1 AND company_id = $2 RETURNING *`,
        [entityId, companyId, startAt, endAt]
    );
    return rows[0] || null;
}

async function rescheduleLead(companyId, entityId, startAt, endAt) {
    const { rows } = await db.query(
        `UPDATE leads SET lead_date_time = $3, lead_end_date_time = $4, updated_at = NOW()
         WHERE id = $1 AND company_id = $2 RETURNING *`,
        [entityId, companyId, startAt, endAt]
    );
    return rows[0] || null;
}

async function rescheduleTask(companyId, entityId, startAt, endAt) {
    const { rows } = await db.query(
        `UPDATE tasks SET start_at = $3, end_at = $4
         WHERE id = $1 AND company_id = $2 RETURNING *`,
        [entityId, companyId, startAt, endAt]
    );
    return rows[0] || null;
}

// =============================================================================
// Reassign mutations
// =============================================================================

async function reassignJob(companyId, entityId, assigneeId) {
    // assigned_techs is jsonb array of {id, name, ...}
    // We merge the new assignee; caller provides full tech object or id
    const { rows } = await db.query(
        `UPDATE jobs
         SET assigned_techs = COALESCE(assigned_techs, '[]'::jsonb) || $3::jsonb,
             updated_at = NOW()
         WHERE id = $1 AND company_id = $2 RETURNING *`,
        [entityId, companyId, JSON.stringify([{ id: assigneeId }])]
    );
    return rows[0] || null;
}

async function reassignTask(companyId, entityId, assigneeId) {
    const { rows } = await db.query(
        `UPDATE tasks SET assigned_provider_id = $3
         WHERE id = $1 AND company_id = $2 RETURNING *`,
        [entityId, companyId, assigneeId]
    );
    return rows[0] || null;
}

// =============================================================================
// Create from slot
// =============================================================================

async function createTask(companyId, data) {
    const { title, description, startAt, endAt, assignedProviderId, threadId, priority } = data;
    const { rows } = await db.query(
        `INSERT INTO tasks (company_id, thread_id, title, description, start_at, end_at, assigned_provider_id, show_on_schedule, priority, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, true, $8, 'open')
         RETURNING *`,
        [
            companyId,
            threadId || null,
            title || 'New Task',
            description || null,
            startAt || null,
            endAt || null,
            assignedProviderId || null,
            priority || 'p2',
        ]
    );
    return rows[0];
}

module.exports = {
    getScheduleItems,
    getDispatchSettings,
    upsertDispatchSettings,
    getJobRow,
    getLeadRow,
    getTaskRow,
    rescheduleJob,
    rescheduleLead,
    rescheduleTask,
    reassignJob,
    reassignTask,
    createTask,
};
