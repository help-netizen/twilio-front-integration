'use strict';

const db = require('./connection');
const { requireCompanyId, queryFor, clampLimit, clampOffset, addTextSearch } = require('./crmUtils');

const DEAL_COLUMNS = `
    d.id, d.company_id, d.account_id, d.owner_user_id, d.name, d.amount,
    d.currency, d.stage, d.probability, d.close_date, d.next_step,
    d.forecast_category, d.risk_summary, d.blocker_summary, d.competitor,
    d.procurement_status, d.last_activity_at, d.created_at, d.updated_at,
    a.name AS account_name, a.domain AS account_domain,
    u.email AS owner_email, u.full_name AS owner_name
`;

const WRITE_FIELD_TO_COLUMN = Object.freeze({
    next_step: 'next_step',
    stage: 'stage',
    forecast_category: 'forecast_category',
    close_date: 'close_date',
    amount: 'amount',
    risk_summary: 'risk_summary',
    competitor: 'competitor',
});

async function listDeals(companyId, filters = {}, client = null) {
    requireCompanyId(companyId);
    const query = queryFor(client, db);
    const params = [companyId];
    const conditions = ['d.company_id = $1'];

    addTextSearch({
        conditions,
        params,
        fields: ['d.name', 'a.name'],
        value: filters.q || filters.search,
    });

    if (filters.account_id) {
        params.push(filters.account_id);
        conditions.push(`d.account_id = $${params.length}`);
    }
    if (filters.owner_user_id) {
        params.push(filters.owner_user_id);
        conditions.push(`d.owner_user_id = $${params.length}`);
    }
    if (filters.stage) {
        params.push(filters.stage);
        conditions.push(`d.stage = $${params.length}`);
    }
    if (filters.forecast_category) {
        params.push(filters.forecast_category);
        conditions.push(`d.forecast_category = $${params.length}`);
    }
    if (filters.close_from) {
        params.push(filters.close_from);
        conditions.push(`d.close_date >= $${params.length}::date`);
    }
    if (filters.close_to) {
        params.push(filters.close_to);
        conditions.push(`d.close_date <= $${params.length}::date`);
    }
    if (filters.open_only !== false) {
        conditions.push(`COALESCE(s.is_open, true) = true`);
    }

    const limit = clampLimit(filters.limit);
    const offset = clampOffset(filters.offset);
    params.push(limit, offset);

    const { rows } = await query(
        `SELECT ${DEAL_COLUMNS},
                COALESCE(s.is_open, true) AS is_open,
                COALESCE(s.is_won, false) AS is_won,
                COALESCE(s.is_lost, false) AS is_lost
         FROM crm_deals d
         LEFT JOIN crm_accounts a ON a.id = d.account_id AND a.company_id = d.company_id
         LEFT JOIN crm_users u ON u.id = d.owner_user_id
         LEFT JOIN crm_pipeline_stages s ON s.company_id = d.company_id AND s.stage_key = d.stage
         WHERE ${conditions.join(' AND ')}
         ORDER BY d.close_date ASC NULLS LAST, d.updated_at DESC NULLS LAST, d.id DESC
         LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params
    );
    return rows;
}

async function getDealById(companyId, dealId, client = null) {
    requireCompanyId(companyId);
    const query = queryFor(client, db);
    const { rows } = await query(
        `SELECT ${DEAL_COLUMNS},
                COALESCE(s.is_open, true) AS is_open,
                COALESCE(s.is_won, false) AS is_won,
                COALESCE(s.is_lost, false) AS is_lost
         FROM crm_deals d
         LEFT JOIN crm_accounts a ON a.id = d.account_id AND a.company_id = d.company_id
         LEFT JOIN crm_users u ON u.id = d.owner_user_id
         LEFT JOIN crm_pipeline_stages s ON s.company_id = d.company_id AND s.stage_key = d.stage
         WHERE d.company_id = $1 AND d.id = $2`,
        [companyId, dealId]
    );
    return rows[0] || null;
}

async function getDealContacts(companyId, dealId, client = null) {
    requireCompanyId(companyId);
    const query = queryFor(client, db);
    const { rows } = await query(
        `SELECT c.id, c.full_name, c.first_name, c.last_name, c.email, c.phone_e164,
                c.secondary_phone, c.company_name, c.title, dc.role
         FROM crm_deal_contacts dc
         JOIN contacts c ON c.id = dc.contact_id AND c.company_id = dc.company_id
         WHERE dc.company_id = $1 AND dc.deal_id = $2
         ORDER BY dc.role ASC, c.full_name ASC NULLS LAST`,
        [companyId, dealId]
    );
    return rows;
}

async function getDealHistory(companyId, dealId, client = null) {
    requireCompanyId(companyId);
    const query = queryFor(client, db);
    const { rows } = await query(
        `SELECT h.*, u.email AS changed_by_email, u.full_name AS changed_by_name
         FROM crm_deal_history h
         LEFT JOIN crm_users u ON u.id = h.changed_by
         WHERE h.company_id = $1 AND h.deal_id = $2
         ORDER BY h.created_at DESC, h.id DESC
         LIMIT 200`,
        [companyId, dealId]
    );
    return rows;
}

async function getDealsWithoutNextStep(companyId, client = null) {
    requireCompanyId(companyId);
    const query = queryFor(client, db);
    const { rows } = await query(
        `SELECT ${DEAL_COLUMNS}
         FROM crm_deals d
         LEFT JOIN crm_accounts a ON a.id = d.account_id AND a.company_id = d.company_id
         LEFT JOIN crm_users u ON u.id = d.owner_user_id
         LEFT JOIN crm_pipeline_stages s ON s.company_id = d.company_id AND s.stage_key = d.stage
         WHERE d.company_id = $1
           AND COALESCE(s.is_open, true) = true
           AND NULLIF(trim(d.next_step), '') IS NULL
         ORDER BY d.close_date ASC NULLS LAST, d.updated_at DESC NULLS LAST
         LIMIT 100`,
        [companyId]
    );
    return rows;
}

async function getOverdueCloseDateDeals(companyId, client = null) {
    requireCompanyId(companyId);
    const query = queryFor(client, db);
    const { rows } = await query(
        `SELECT ${DEAL_COLUMNS}
         FROM crm_deals d
         LEFT JOIN crm_accounts a ON a.id = d.account_id AND a.company_id = d.company_id
         LEFT JOIN crm_users u ON u.id = d.owner_user_id
         LEFT JOIN crm_pipeline_stages s ON s.company_id = d.company_id AND s.stage_key = d.stage
         WHERE d.company_id = $1
           AND COALESCE(s.is_open, true) = true
           AND d.close_date IS NOT NULL
           AND d.close_date < CURRENT_DATE
         ORDER BY d.close_date ASC, d.id DESC
         LIMIT 100`,
        [companyId]
    );
    return rows;
}

async function getDealsWithoutActivity(companyId, days, client = null) {
    requireCompanyId(companyId);
    const query = queryFor(client, db);
    const { rows } = await query(
        `SELECT ${DEAL_COLUMNS}
         FROM crm_deals d
         LEFT JOIN crm_accounts a ON a.id = d.account_id AND a.company_id = d.company_id
         LEFT JOIN crm_users u ON u.id = d.owner_user_id
         LEFT JOIN crm_pipeline_stages s ON s.company_id = d.company_id AND s.stage_key = d.stage
         WHERE d.company_id = $1
           AND COALESCE(s.is_open, true) = true
           AND (d.last_activity_at IS NULL OR d.last_activity_at < now() - ($2::int * interval '1 day'))
         ORDER BY d.last_activity_at ASC NULLS FIRST, d.close_date ASC NULLS LAST
         LIMIT 100`,
        [companyId, days]
    );
    return rows;
}

async function getDealsClosingBetween(companyId, fromDate, toDate, client = null) {
    requireCompanyId(companyId);
    const query = queryFor(client, db);
    const { rows } = await query(
        `SELECT ${DEAL_COLUMNS}
         FROM crm_deals d
         LEFT JOIN crm_accounts a ON a.id = d.account_id AND a.company_id = d.company_id
         LEFT JOIN crm_users u ON u.id = d.owner_user_id
         LEFT JOIN crm_pipeline_stages s ON s.company_id = d.company_id AND s.stage_key = d.stage
         WHERE d.company_id = $1
           AND COALESCE(s.is_open, true) = true
           AND d.close_date >= $2::date
           AND d.close_date <= $3::date
         ORDER BY d.close_date ASC, d.amount DESC NULLS LAST`,
        [companyId, fromDate, toDate]
    );
    return rows;
}

async function getOpenDeals(companyId, filters = {}, client = null) {
    return listDeals(companyId, { ...filters, open_only: true, limit: filters.limit || 100 }, client);
}

async function getPipelineDeals(companyId, filters = {}, client = null) {
    requireCompanyId(companyId);
    const query = queryFor(client, db);
    const params = [companyId];
    const conditions = ['d.company_id = $1', 'COALESCE(s.is_open, true) = true'];
    if (filters.owner_user_id) {
        params.push(filters.owner_user_id);
        conditions.push(`d.owner_user_id = $${params.length}`);
    }
    if (filters.team_id) {
        params.push(filters.team_id);
        conditions.push(`EXISTS (
            SELECT 1
            FROM user_groups ug
            JOIN user_group_members ugm ON ugm.group_id = ug.id AND ugm.is_active = true
            WHERE ug.id = $${params.length}
              AND ug.company_id::text = d.company_id::text
              AND ugm.user_id = d.owner_user_id::text
        )`);
    }
    if (filters.period_start) {
        params.push(filters.period_start);
        conditions.push(`d.close_date >= $${params.length}::date`);
    }
    if (filters.period_end) {
        params.push(filters.period_end);
        conditions.push(`d.close_date <= $${params.length}::date`);
    }
    const { rows } = await query(
        `SELECT d.*, a.name AS account_name, s.display_order AS stage_order,
                COALESCE(s.is_open, true) AS is_open
         FROM crm_deals d
         LEFT JOIN crm_accounts a ON a.id = d.account_id AND a.company_id = d.company_id
         LEFT JOIN crm_pipeline_stages s ON s.company_id = d.company_id AND s.stage_key = d.stage
         WHERE ${conditions.join(' AND ')}`,
        params
    );
    return rows;
}

function addPipelineScopeFilters(params, conditions, filters = {}) {
    if (filters.owner_user_id) {
        params.push(filters.owner_user_id);
        conditions.push(`d.owner_user_id = $${params.length}`);
    }
    if (filters.team_id) {
        params.push(filters.team_id);
        conditions.push(`EXISTS (
            SELECT 1
            FROM user_groups ug
            JOIN user_group_members ugm ON ugm.group_id = ug.id AND ugm.is_active = true
            WHERE ug.id = $${params.length}
              AND ug.company_id::text = d.company_id::text
              AND ugm.user_id = d.owner_user_id::text
        )`);
    }
    if (filters.period_start) {
        params.push(filters.period_start);
        conditions.push(`d.close_date >= $${params.length}::date`);
    }
    if (filters.period_end) {
        params.push(filters.period_end);
        conditions.push(`d.close_date <= $${params.length}::date`);
    }
}

async function getDealHistorySince(companyId, since, filters = {}, client = null) {
    requireCompanyId(companyId);
    const query = queryFor(client, db);
    const params = [companyId, since];
    const conditions = ['h.company_id = $1', 'h.created_at >= $2::timestamptz'];
    addPipelineScopeFilters(params, conditions, filters);
    const { rows } = await query(
        `SELECT h.*, d.name AS deal_name, d.stage AS current_stage, d.amount AS current_amount, d.close_date AS current_close_date
         FROM crm_deal_history h
         JOIN crm_deals d ON d.id = h.deal_id AND d.company_id = h.company_id
         WHERE ${conditions.join(' AND ')}
         ORDER BY h.created_at DESC`,
        params
    );
    return rows;
}

async function getLatestPipelineSnapshotBefore(companyId, before, filters = {}, client = null) {
    requireCompanyId(companyId);
    const query = queryFor(client, db);
    const { rows } = await query(
        `SELECT id, company_id, owner_user_id, team_id, period_start, period_end,
                snapshot_week_start, totals, by_stage, by_forecast_category, created_at
         FROM crm_pipeline_weekly_snapshots
         WHERE company_id = $1
           AND created_at < $2::timestamptz
           AND (($3::uuid IS NULL AND owner_user_id IS NULL) OR owner_user_id = $3::uuid)
           AND (($4::text IS NULL AND team_id IS NULL) OR team_id = $4::text)
           AND (($5::date IS NULL AND period_start IS NULL) OR period_start = $5::date)
           AND (($6::date IS NULL AND period_end IS NULL) OR period_end = $6::date)
         ORDER BY snapshot_week_start DESC, created_at DESC
         LIMIT 1`,
        [
            companyId,
            before,
            filters.owner_user_id || null,
            filters.team_id || null,
            filters.period_start || null,
            filters.period_end || null,
        ]
    );
    return rows[0] || null;
}

async function getPipelineStages(companyId, client = null) {
    requireCompanyId(companyId);
    const query = queryFor(client, db);
    const { rows } = await query(
        `SELECT stage_key, display_order
         FROM crm_pipeline_stages
         WHERE company_id = $1`,
        [companyId]
    );
    return rows;
}

async function getForecastCategories(companyId, client = null) {
    requireCompanyId(companyId);
    const query = queryFor(client, db);
    const { rows } = await query(
        `SELECT category_key, display_order
         FROM crm_forecast_categories
         WHERE company_id = $1`,
        [companyId]
    );
    return rows;
}

async function updateDealField(companyId, dealId, field, value, actorId, source, requestId, client) {
    requireCompanyId(companyId);
    const column = WRITE_FIELD_TO_COLUMN[field];
    if (!column) {
        const err = new Error(`Field ${field} is not allowed`);
        err.code = 'FIELD_NOT_ALLOWED';
        throw err;
    }
    const query = queryFor(client, db);
    const current = await getDealById(companyId, dealId, client);
    if (!current) return null;
    const before = current[column];
    const { rows } = await query(
        `UPDATE crm_deals
         SET ${column} = $3, updated_at = now()
         WHERE company_id = $1 AND id = $2
         RETURNING *`,
        [companyId, dealId, value]
    );
    const updated = rows[0] || null;
    await query(
        `INSERT INTO crm_deal_history
            (company_id, deal_id, field_name, old_value, new_value, changed_by, source, request_id)
         VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7, $8)`,
        [
            companyId,
            dealId,
            field,
            JSON.stringify(before === undefined ? null : before),
            JSON.stringify(value === undefined ? null : value),
            actorId || null,
            source || 'crm',
            requestId || null,
        ]
    );
    return { row: updated, before, after: updated ? updated[column] : value };
}

module.exports = {
    WRITE_FIELD_TO_COLUMN,
    listDeals,
    getDealById,
    getDealContacts,
    getDealHistory,
    getDealsWithoutNextStep,
    getOverdueCloseDateDeals,
    getDealsWithoutActivity,
    getDealsClosingBetween,
    getOpenDeals,
    getPipelineDeals,
    getDealHistorySince,
    getLatestPipelineSnapshotBefore,
    getPipelineStages,
    getForecastCategories,
    updateDealField,
};
