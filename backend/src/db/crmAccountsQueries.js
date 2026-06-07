'use strict';

const db = require('./connection');
const { requireCompanyId, queryFor, clampLimit, clampOffset, addTextSearch } = require('./crmUtils');

const ACCOUNT_COLUMNS = `
    a.id, a.company_id, a.name, a.domain, a.status, a.owner_user_id,
    a.icp_segment, a.health, a.last_contact_at, a.created_at, a.updated_at,
    u.email AS owner_email, u.full_name AS owner_name
`;

async function listAccounts(companyId, filters = {}, client = null) {
    requireCompanyId(companyId);
    const query = queryFor(client, db);
    const params = [companyId];
    const conditions = ['a.company_id = $1'];

    addTextSearch({
        conditions,
        params,
        fields: ['a.name', 'a.domain', 'a.icp_segment'],
        value: filters.q || filters.search,
    });

    if (filters.domain) {
        params.push(String(filters.domain).toLowerCase());
        conditions.push(`lower(a.domain) = $${params.length}`);
    }
    if (filters.icp_segment) {
        params.push(filters.icp_segment);
        conditions.push(`a.icp_segment = $${params.length}`);
    }
    if (filters.owner_user_id) {
        params.push(filters.owner_user_id);
        conditions.push(`a.owner_user_id = $${params.length}`);
    }

    const limit = clampLimit(filters.limit);
    const offset = clampOffset(filters.offset);
    params.push(limit, offset);

    const { rows } = await query(
        `SELECT ${ACCOUNT_COLUMNS},
                COALESCE(open_deals.open_deals_count, 0)::int AS open_deals_count,
                COALESCE(open_deals.pipeline_amount, 0)::numeric AS pipeline_amount
         FROM crm_accounts a
         LEFT JOIN crm_users u ON u.id = a.owner_user_id
         LEFT JOIN LATERAL (
            SELECT COUNT(*) AS open_deals_count, SUM(COALESCE(d.amount, 0)) AS pipeline_amount
            FROM crm_deals d
            LEFT JOIN crm_pipeline_stages s ON s.company_id = d.company_id AND s.stage_key = d.stage
            WHERE d.company_id = a.company_id
              AND d.account_id = a.id
              AND COALESCE(s.is_open, true) = true
         ) open_deals ON true
         WHERE ${conditions.join(' AND ')}
         ORDER BY a.updated_at DESC NULLS LAST, a.id DESC
         LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params
    );
    return rows;
}

async function getAccountById(companyId, accountId, client = null) {
    requireCompanyId(companyId);
    const query = queryFor(client, db);
    const { rows } = await query(
        `SELECT ${ACCOUNT_COLUMNS}
         FROM crm_accounts a
         LEFT JOIN crm_users u ON u.id = a.owner_user_id
         WHERE a.company_id = $1 AND a.id = $2`,
        [companyId, accountId]
    );
    return rows[0] || null;
}

async function getAccountContacts(companyId, accountId, client = null) {
    requireCompanyId(companyId);
    const query = queryFor(client, db);
    const { rows } = await query(
        `SELECT c.id, c.full_name, c.first_name, c.last_name, c.email, c.phone_e164,
                c.secondary_phone, c.company_name, c.title,
                ac.relationship_type, ac.is_primary
         FROM crm_account_contacts ac
         JOIN contacts c ON c.id = ac.contact_id AND c.company_id = ac.company_id
         WHERE ac.company_id = $1 AND ac.account_id = $2
         ORDER BY ac.is_primary DESC, c.full_name ASC NULLS LAST, c.id ASC`,
        [companyId, accountId]
    );
    return rows;
}

async function getAccountDeals(companyId, accountId, client = null) {
    requireCompanyId(companyId);
    const query = queryFor(client, db);
    const { rows } = await query(
        `SELECT d.*
         FROM crm_deals d
         WHERE d.company_id = $1 AND d.account_id = $2
         ORDER BY d.close_date ASC NULLS LAST, d.updated_at DESC NULLS LAST`,
        [companyId, accountId]
    );
    return rows;
}

async function getStaleAccounts(companyId, days, filters = {}, client = null) {
    requireCompanyId(companyId);
    const query = queryFor(client, db);
    const params = [companyId, days];
    const conditions = [
        'a.company_id = $1',
        `NOT EXISTS (
            SELECT 1
            FROM crm_activities act
            WHERE act.company_id = a.company_id
              AND act.account_id = a.id
              AND act.occurred_at >= now() - ($2::int * interval '1 day')
        )`,
    ];
    if (filters.owner_user_id) {
        params.push(filters.owner_user_id);
        conditions.push(`a.owner_user_id = $${params.length}`);
    }
    const limit = clampLimit(filters.limit);
    const offset = clampOffset(filters.offset);
    params.push(limit, offset);
    const { rows } = await query(
        `SELECT ${ACCOUNT_COLUMNS}, last_activity.last_activity_at AS activity_last_contact_at
         FROM crm_accounts a
         LEFT JOIN crm_users u ON u.id = a.owner_user_id
         LEFT JOIN LATERAL (
            SELECT MAX(act.occurred_at) AS last_activity_at
            FROM crm_activities act
            WHERE act.company_id = a.company_id
              AND act.account_id = a.id
         ) last_activity ON true
         WHERE ${conditions.join(' AND ')}
         ORDER BY COALESCE(last_activity.last_activity_at, a.last_contact_at) ASC NULLS FIRST, a.id DESC
         LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params
    );
    return rows;
}

async function topAccountsByPipeline(companyId, filters = {}, client = null) {
    requireCompanyId(companyId);
    const query = queryFor(client, db);
    const limit = clampLimit(filters.limit, 10, 50);
    const { rows } = await query(
        `SELECT a.id, a.name, a.domain, a.owner_user_id,
                COUNT(d.id)::int AS open_deals_count,
                SUM(COALESCE(d.amount, 0))::numeric AS pipeline_amount
         FROM crm_accounts a
         JOIN crm_deals d ON d.company_id = a.company_id AND d.account_id = a.id
         LEFT JOIN crm_pipeline_stages s ON s.company_id = d.company_id AND s.stage_key = d.stage
         WHERE a.company_id = $1
           AND COALESCE(s.is_open, true) = true
         GROUP BY a.id
         ORDER BY pipeline_amount DESC, open_deals_count DESC, a.name ASC
         LIMIT $2`,
        [companyId, limit]
    );
    return rows;
}

module.exports = {
    listAccounts,
    getAccountById,
    getAccountContacts,
    getAccountDeals,
    getStaleAccounts,
    topAccountsByPipeline,
};
