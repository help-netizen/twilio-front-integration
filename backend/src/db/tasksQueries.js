'use strict';

/**
 * tasksQueries.js — TASKS-001 cross-entity tasks.
 *
 * Tasks attach to exactly one parent (job/lead/estimate/invoice/contact) and have
 * no standalone view. Reuses the shared `tasks` table; the task text lives in the
 * NOT NULL `title` column but is exposed to the API as `description`. Every query
 * is company-scoped (req.companyFilter.company_id). Sales-CRM/Pulse task columns
 * (thread_id/account_id/deal_id/subject_*) are left untouched by this module.
 */

const db = require('./connection');
const { requireCompanyId, queryFor, clampLimit, clampOffset } = require('./crmUtils');

// parentType → { column, table+alias, label expression, frontend path }
const PARENTS = {
    job: { col: 'job_id', table: 'jobs', alias: 'j', path: 'jobs' },
    lead: { col: 'lead_id', table: 'leads', alias: 'l', path: 'leads' },
    estimate: { col: 'estimate_id', table: 'estimates', alias: 'e', path: 'estimates' },
    invoice: { col: 'invoice_id', table: 'invoices', alias: 'iv', path: 'invoices' },
    contact: { col: 'contact_id', table: 'contacts', alias: 'co', path: 'contacts' },
};

const PARENT_TYPES = Object.keys(PARENTS);

function isValidParentType(t) {
    return Object.prototype.hasOwnProperty.call(PARENTS, t);
}

// Shared SELECT projection — derives parent_type/_id/_label/_path via CASE so the
// caller gets everything needed to render a row and deep-link to the parent card.
const SELECT_TASK = `
    SELECT t.id, t.company_id, t.title AS description, t.status, t.due_at,
           t.completed_at, t.created_at, t.owner_user_id, t.author_user_id,
           ow.full_name AS assignee_name, ow.email AS assignee_email,
           au.full_name AS author_name,
           CASE
               WHEN t.job_id      IS NOT NULL THEN 'job'
               WHEN t.lead_id     IS NOT NULL THEN 'lead'
               WHEN t.estimate_id IS NOT NULL THEN 'estimate'
               WHEN t.invoice_id  IS NOT NULL THEN 'invoice'
               WHEN t.contact_id  IS NOT NULL THEN 'contact'
           END AS parent_type,
           COALESCE(t.job_id, t.lead_id, t.estimate_id, t.invoice_id, t.contact_id) AS parent_id,
           CASE
               WHEN t.job_id      IS NOT NULL THEN COALESCE(NULLIF(j.service_name,''), NULLIF(j.customer_name,''), 'Job #' || j.id)
               WHEN t.lead_id     IS NOT NULL THEN COALESCE(NULLIF(TRIM(CONCAT_WS(' ', l.first_name, l.last_name)),''), NULLIF(l.company,''), 'Lead')
               WHEN t.estimate_id IS NOT NULL THEN COALESCE(NULLIF(e.estimate_number,''), 'Estimate')
               WHEN t.invoice_id  IS NOT NULL THEN COALESCE(NULLIF(iv.invoice_number,''), 'Invoice')
               WHEN t.contact_id  IS NOT NULL THEN COALESCE(NULLIF(co.full_name,''), 'Contact')
           END AS parent_label
    FROM tasks t
    LEFT JOIN crm_users ow ON ow.id = t.owner_user_id
    LEFT JOIN crm_users au ON au.id = t.author_user_id
    LEFT JOIN jobs j       ON j.id  = t.job_id      AND j.company_id  = t.company_id
    LEFT JOIN leads l      ON l.id  = t.lead_id     AND l.company_id  = t.company_id
    LEFT JOIN estimates e  ON e.id  = t.estimate_id AND e.company_id  = t.company_id
    LEFT JOIN invoices iv  ON iv.id = t.invoice_id  AND iv.company_id = t.company_id
    LEFT JOIN contacts co  ON co.id = t.contact_id  AND co.company_id = t.company_id
`;

// Only rows owned by TASKS-001 (one of the 5 parents set).
const HAS_ENTITY_PARENT =
    '(t.job_id IS NOT NULL OR t.lead_id IS NOT NULL OR t.estimate_id IS NOT NULL OR t.invoice_id IS NOT NULL OR t.contact_id IS NOT NULL)';

/** Confirm a parent row exists in this company. Returns boolean. */
async function parentExists(companyId, parentType, parentId, client = null) {
    requireCompanyId(companyId);
    if (!isValidParentType(parentType)) return false;
    const p = PARENTS[parentType];
    const query = queryFor(client, db);
    const { rows } = await query(
        `SELECT 1 FROM ${p.table} WHERE id = $1 AND company_id = $2 LIMIT 1`,
        [parentId, companyId]
    );
    return rows.length > 0;
}

/** Tasks for one parent card (open first, optional recently-done). */
async function listEntityTasks(companyId, { parentType, parentId, includeDone = false }, client = null) {
    requireCompanyId(companyId);
    if (!isValidParentType(parentType)) return [];
    const p = PARENTS[parentType];
    const query = queryFor(client, db);
    const params = [companyId, parentId];
    let statusCond = '';
    if (!includeDone) statusCond = `AND t.status = 'open'`;
    const { rows } = await query(
        `${SELECT_TASK}
         WHERE t.company_id = $1 AND t.${p.col} = $2 ${statusCond}
         ORDER BY (t.status = 'done'), t.due_at ASC NULLS LAST, t.created_at DESC`,
        params
    );
    return rows;
}

/** Global cross-entity list. scopeOwnerId set → only that user's tasks (own scope). */
async function listTasks(companyId, filters = {}, client = null) {
    requireCompanyId(companyId);
    const query = queryFor(client, db);
    const params = [companyId];
    const conditions = ['t.company_id = $1', HAS_ENTITY_PARENT];

    if (filters.scopeOwnerId) {
        params.push(filters.scopeOwnerId);
        conditions.push(`t.owner_user_id = $${params.length}`);
    }
    if (filters.status) {
        params.push(filters.status);
        conditions.push(`t.status = $${params.length}`);
    }
    if (filters.assignee_id) {
        params.push(filters.assignee_id);
        conditions.push(`t.owner_user_id = $${params.length}`);
    }
    if (filters.parent_type && isValidParentType(filters.parent_type)) {
        conditions.push(`t.${PARENTS[filters.parent_type].col} IS NOT NULL`);
    }
    if (filters.overdue) {
        conditions.push(`t.status = 'open' AND t.due_at IS NOT NULL AND t.due_at < now()`);
    }
    if (filters.due_from) {
        params.push(filters.due_from);
        conditions.push(`t.due_at >= $${params.length}::timestamptz`);
    }
    if (filters.due_to) {
        params.push(filters.due_to);
        conditions.push(`t.due_at <= $${params.length}::timestamptz`);
    }

    const limit = clampLimit(filters.limit, 100, 500);
    const offset = clampOffset(filters.offset);
    params.push(limit, offset);

    const { rows } = await query(
        `${SELECT_TASK}
         WHERE ${conditions.join(' AND ')}
         ORDER BY t.due_at ASC NULLS LAST, t.created_at DESC
         LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params
    );
    return rows;
}

/** Single task with the derived parent fields. */
async function getTaskById(companyId, taskId, client = null) {
    requireCompanyId(companyId);
    const query = queryFor(client, db);
    const { rows } = await query(
        `${SELECT_TASK} WHERE t.company_id = $1 AND t.id = $2`,
        [companyId, taskId]
    );
    return rows[0] || null;
}

/**
 * Create a task on exactly one parent. payload:
 *   { parentType, parentId, description, owner_user_id, author_user_id, due_at }
 */
async function createTask(companyId, payload, client = null) {
    requireCompanyId(companyId);
    const p = PARENTS[payload.parentType];
    const query = queryFor(client, db);
    const cols = ['company_id', 'title', 'description', 'status', 'created_by', 'owner_user_id', 'author_user_id', 'due_at', p.col];
    const vals = [
        companyId,
        payload.description,            // title (NOT NULL) holds the task text
        payload.description,            // description column mirrors it
        'open',
        'user',
        payload.owner_user_id || null,
        payload.author_user_id || null,
        payload.due_at || null,
        payload.parentId,
    ];
    const placeholders = vals.map((_, i) => (cols[i] === 'due_at' ? `$${i + 1}::timestamptz` : `$${i + 1}`));
    const { rows } = await query(
        `INSERT INTO tasks (${cols.join(', ')}) VALUES (${placeholders.join(', ')}) RETURNING id`,
        vals
    );
    return getTaskById(companyId, rows[0].id, client);
}

/** Patch description / owner_user_id / due_at / status. */
async function updateTask(companyId, taskId, patch = {}, client = null) {
    requireCompanyId(companyId);
    const query = queryFor(client, db);
    const sets = [];
    const params = [companyId, taskId];

    if (patch.description !== undefined) {
        params.push(patch.description);
        sets.push(`title = $${params.length}`);
        params.push(patch.description);
        sets.push(`description = $${params.length}`);
    }
    if (patch.owner_user_id !== undefined) {
        params.push(patch.owner_user_id);
        sets.push(`owner_user_id = $${params.length}`);
    }
    if (patch.due_at !== undefined) {
        params.push(patch.due_at);
        sets.push(`due_at = $${params.length}::timestamptz`);
    }
    if (patch.status !== undefined) {
        params.push(patch.status);
        sets.push(`status = $${params.length}`);
        sets.push(`completed_at = CASE WHEN $${params.length} = 'done' THEN COALESCE(completed_at, now()) ELSE NULL END`);
    }

    if (sets.length === 0) return getTaskById(companyId, taskId, client);

    const { rows } = await query(
        `UPDATE tasks SET ${sets.join(', ')}
         WHERE company_id = $1 AND id = $2 RETURNING id`,
        params
    );
    if (rows.length === 0) return null;
    return getTaskById(companyId, taskId, client);
}

async function deleteTask(companyId, taskId, client = null) {
    requireCompanyId(companyId);
    const query = queryFor(client, db);
    const { rowCount } = await query(
        `DELETE FROM tasks WHERE company_id = $1 AND id = $2`,
        [companyId, taskId]
    );
    return rowCount > 0;
}

module.exports = {
    PARENT_TYPES,
    isValidParentType,
    parentExists,
    listEntityTasks,
    listTasks,
    getTaskById,
    createTask,
    updateTask,
    deleteTask,
};
