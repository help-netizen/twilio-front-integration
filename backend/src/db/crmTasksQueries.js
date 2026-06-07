'use strict';

const db = require('./connection');
const { requireCompanyId, queryFor, clampLimit, clampOffset } = require('./crmUtils');

async function listTasks(companyId, filters = {}, client = null) {
    requireCompanyId(companyId);
    const query = queryFor(client, db);
    const params = [companyId];
    const conditions = ['t.company_id = $1'];

    for (const key of ['owner_user_id', 'account_id', 'deal_id', 'contact_id', 'status']) {
        if (filters[key]) {
            params.push(filters[key]);
            conditions.push(`t.${key} = $${params.length}`);
        }
    }
    if (filters.due_from) {
        params.push(filters.due_from);
        conditions.push(`t.due_at >= $${params.length}::timestamptz`);
    }
    if (filters.due_to) {
        params.push(filters.due_to);
        conditions.push(`t.due_at <= $${params.length}::timestamptz`);
    }
    if (filters.overdue) {
        conditions.push(`t.status = 'open' AND t.due_at IS NOT NULL AND t.due_at < now()`);
    }

    const limit = clampLimit(filters.limit);
    const offset = clampOffset(filters.offset);
    params.push(limit, offset);

    const { rows } = await query(
        `SELECT t.*, u.email AS owner_email, u.full_name AS owner_name,
                a.name AS account_name, d.name AS deal_name, c.full_name AS contact_name
         FROM tasks t
         LEFT JOIN crm_users u ON u.id = t.owner_user_id
         LEFT JOIN crm_accounts a ON a.id = t.account_id AND a.company_id = t.company_id
         LEFT JOIN crm_deals d ON d.id = t.deal_id AND d.company_id = t.company_id
         LEFT JOIN contacts c ON c.id = t.contact_id AND c.company_id = t.company_id
         WHERE ${conditions.join(' AND ')}
         ORDER BY t.due_at ASC NULLS LAST, t.created_at DESC
         LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params
    );
    return rows;
}

async function getTaskById(companyId, taskId, client = null) {
    requireCompanyId(companyId);
    const query = queryFor(client, db);
    const { rows } = await query(
        `SELECT * FROM tasks WHERE company_id = $1 AND id = $2`,
        [companyId, taskId]
    );
    return rows[0] || null;
}

async function createTask(companyId, payload, client = null) {
    requireCompanyId(companyId);
    const query = queryFor(client, db);
    const subjectType = payload.subject_type
        || (payload.deal_id ? 'deal' : payload.account_id ? 'account' : payload.contact_id ? 'contact' : 'crm');
    const subjectId = payload.subject_id
        || payload.deal_id
        || payload.account_id
        || payload.contact_id
        || null;
    const { rows } = await query(
        `INSERT INTO tasks
            (company_id, thread_id, subject_type, subject_id, title, description, status,
             priority, due_at, owner_user_id, created_by, account_id, deal_id, contact_id)
         VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7, 'open'), COALESCE($8, 'p2'),
                 $9::timestamptz, $10, COALESCE($11, 'user'), $12, $13, $14)
         RETURNING *`,
        [
            companyId,
            payload.thread_id || null,
            subjectType,
            subjectId,
            payload.title,
            payload.description || null,
            payload.status || 'open',
            payload.priority || 'p2',
            payload.due_at || null,
            payload.owner_user_id || null,
            payload.created_by || 'user',
            payload.account_id || null,
            payload.deal_id || null,
            payload.contact_id || null,
        ]
    );
    return rows[0];
}

async function updateTaskStatus(companyId, taskId, status, client = null) {
    requireCompanyId(companyId);
    const query = queryFor(client, db);
    const current = await getTaskById(companyId, taskId, client);
    if (!current) return null;
    const { rows } = await query(
        `UPDATE tasks
         SET status = $3,
             completed_at = CASE WHEN $3 = 'done' THEN COALESCE(completed_at, now()) ELSE NULL END
         WHERE company_id = $1 AND id = $2
         RETURNING *`,
        [companyId, taskId, status]
    );
    return { row: rows[0] || null, before: current.status, after: status };
}

module.exports = {
    listTasks,
    getTaskById,
    createTask,
    updateTaskStatus,
};
