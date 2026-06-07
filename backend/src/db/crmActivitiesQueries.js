'use strict';

const db = require('./connection');
const { requireCompanyId, queryFor, clampLimit, clampOffset } = require('./crmUtils');

function sanitizeActivityRow(row) {
    if (!row) return null;
    const { search_vector, ...safe } = row;
    return safe;
}

async function listActivities(companyId, filters = {}, client = null) {
    requireCompanyId(companyId);
    const query = queryFor(client, db);
    const params = [companyId];
    const conditions = ['company_id = $1'];

    for (const key of ['account_id', 'deal_id', 'contact_id', 'owner_user_id', 'type']) {
        if (filters[key]) {
            params.push(filters[key]);
            conditions.push(`${key} = $${params.length}`);
        }
    }
    if (filters.customer_facing !== undefined) {
        params.push(filters.customer_facing === true || filters.customer_facing === 'true');
        conditions.push(`customer_facing = $${params.length}`);
    }
    if (filters.q || filters.search) {
        params.push(String(filters.q || filters.search));
        conditions.push(`search_vector @@ plainto_tsquery('english', $${params.length})`);
    }

    const limit = clampLimit(filters.limit);
    const offset = clampOffset(filters.offset);
    params.push(limit, offset);
    const { rows } = await query(
        `SELECT *
         FROM crm_activities
         WHERE ${conditions.join(' AND ')}
         ORDER BY occurred_at DESC, id DESC
         LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params
    );
    return rows.map(sanitizeActivityRow);
}

async function getLastCustomerFacing(companyId, filters = {}, client = null) {
    requireCompanyId(companyId);
    const query = queryFor(client, db);
    const params = [companyId];
    const conditions = ['company_id = $1', 'customer_facing = true'];
    for (const key of ['account_id', 'deal_id', 'contact_id']) {
        if (filters[key]) {
            params.push(filters[key]);
            conditions.push(`${key} = $${params.length}`);
        }
    }
    const { rows } = await query(
        `SELECT *
         FROM crm_activities
         WHERE ${conditions.join(' AND ')}
         ORDER BY occurred_at DESC, id DESC
         LIMIT 1`,
        params
    );
    return sanitizeActivityRow(rows[0] || null);
}

async function createActivity(companyId, payload, client = null) {
    requireCompanyId(companyId);
    const query = queryFor(client, db);
    const { rows } = await query(
        `INSERT INTO crm_activities
            (company_id, account_id, deal_id, contact_id, owner_user_id, type, occurred_at,
             summary, body, customer_facing, source_entity_type, source_entity_id)
         VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7::timestamptz, now()),
                 $8, $9, COALESCE($10, false), $11, $12)
         RETURNING *`,
        [
            companyId,
            payload.account_id || null,
            payload.deal_id || null,
            payload.contact_id || null,
            payload.owner_user_id || null,
            payload.type,
            payload.occurred_at || null,
            payload.summary || null,
            payload.body || null,
            payload.customer_facing === true,
            payload.source_entity_type || null,
            payload.source_entity_id || null,
        ]
    );
    return sanitizeActivityRow(rows[0]);
}

module.exports = {
    listActivities,
    getLastCustomerFacing,
    createActivity,
};
