'use strict';

const db = require('./connection');
const { requireCompanyId, queryFor, clampLimit, clampOffset, addTextSearch } = require('./crmUtils');

const CONTACT_COLUMNS = `
    c.id, c.company_id, c.full_name, c.first_name, c.last_name, c.email,
    c.phone_e164, c.secondary_phone, c.secondary_phone_name, c.company_name,
    c.title, c.notes, c.created_at, c.updated_at
`;

async function listContacts(companyId, filters = {}, client = null) {
    requireCompanyId(companyId);
    const query = queryFor(client, db);
    const params = [companyId];
    const conditions = ['c.company_id = $1'];
    const joins = [];

    addTextSearch({
        conditions,
        params,
        fields: ['c.full_name', 'c.first_name', 'c.last_name', 'c.email', 'c.company_name', 'c.title'],
        value: filters.q || filters.search,
    });

    if (filters.account_id) {
        joins.push('JOIN crm_account_contacts ac_filter ON ac_filter.contact_id = c.id AND ac_filter.company_id = c.company_id');
        params.push(filters.account_id);
        conditions.push(`ac_filter.account_id = $${params.length}`);
    }

    if (filters.email) {
        params.push(String(filters.email).toLowerCase());
        conditions.push(`lower(c.email) = $${params.length}`);
    }
    if (filters.title) {
        params.push(`%${filters.title}%`);
        conditions.push(`c.title ILIKE $${params.length}`);
    }
    if (filters.company) {
        params.push(`%${filters.company}%`);
        conditions.push(`(c.company_name ILIKE $${params.length} OR EXISTS (
            SELECT 1 FROM crm_account_contacts ac
            JOIN crm_accounts a ON a.id = ac.account_id AND a.company_id = ac.company_id
            WHERE ac.company_id = c.company_id AND ac.contact_id = c.id AND a.name ILIKE $${params.length}
        ))`);
    }

    const limit = clampLimit(filters.limit);
    const offset = clampOffset(filters.offset);
    params.push(limit, offset);

    const { rows } = await query(
        `SELECT ${CONTACT_COLUMNS}
         FROM contacts c
         ${joins.join('\n')}
         WHERE ${conditions.join(' AND ')}
         ORDER BY c.updated_at DESC NULLS LAST, c.id DESC
         LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params
    );
    return rows;
}

async function getContactById(companyId, contactId, client = null) {
    requireCompanyId(companyId);
    const query = queryFor(client, db);
    const { rows } = await query(
        `SELECT ${CONTACT_COLUMNS}
         FROM contacts c
         WHERE c.company_id = $1 AND c.id = $2`,
        [companyId, contactId]
    );
    return rows[0] || null;
}

async function getContactAccounts(companyId, contactId, client = null) {
    requireCompanyId(companyId);
    const query = queryFor(client, db);
    const { rows } = await query(
        `SELECT a.*, ac.relationship_type, ac.is_primary
         FROM crm_account_contacts ac
         JOIN crm_accounts a ON a.id = ac.account_id AND a.company_id = ac.company_id
         WHERE ac.company_id = $1 AND ac.contact_id = $2
         ORDER BY ac.is_primary DESC, a.name ASC`,
        [companyId, contactId]
    );
    return rows;
}

async function getContactDealRoles(companyId, contactId, filters = {}, client = null) {
    requireCompanyId(companyId);
    const query = queryFor(client, db);
    const params = [companyId, contactId];
    const conditions = ['dc.company_id = $1', 'dc.contact_id = $2'];
    if (filters.deal_id) {
        params.push(filters.deal_id);
        conditions.push(`dc.deal_id = $${params.length}`);
    }
    const { rows } = await query(
        `SELECT dc.deal_id, dc.contact_id, dc.role, d.name AS deal_name, d.stage, d.forecast_category
         FROM crm_deal_contacts dc
         JOIN crm_deals d ON d.id = dc.deal_id AND d.company_id = dc.company_id
         WHERE ${conditions.join(' AND ')}
         ORDER BY d.updated_at DESC NULLS LAST, dc.role ASC`,
        params
    );
    return rows;
}

async function getKeyContactsByAccount(companyId, accountId, client = null) {
    requireCompanyId(companyId);
    const query = queryFor(client, db);
    const { rows } = await query(
        `SELECT DISTINCT c.id, c.full_name, c.email, c.phone_e164, c.title,
                dc.role, ac.relationship_type, ac.is_primary
         FROM crm_account_contacts ac
         JOIN contacts c ON c.id = ac.contact_id AND c.company_id = ac.company_id
         LEFT JOIN crm_deals d ON d.account_id = ac.account_id AND d.company_id = ac.company_id
         LEFT JOIN crm_deal_contacts dc ON dc.deal_id = d.id AND dc.contact_id = c.id AND dc.company_id = ac.company_id
         WHERE ac.company_id = $1
           AND ac.account_id = $2
           AND (ac.is_primary = true OR dc.role IN ('decision_maker', 'champion', 'procurement'))
         ORDER BY ac.is_primary DESC, dc.role ASC NULLS LAST, c.full_name ASC NULLS LAST`,
        [companyId, accountId]
    );
    return rows;
}

async function contactsMissingFields(companyId, client = null) {
    requireCompanyId(companyId);
    const query = queryFor(client, db);
    const { rows } = await query(
        `SELECT ${CONTACT_COLUMNS}
         FROM contacts c
         WHERE c.company_id = $1
           AND (NULLIF(c.email, '') IS NULL OR NULLIF(c.title, '') IS NULL OR NOT EXISTS (
                SELECT 1 FROM crm_deal_contacts dc
                WHERE dc.company_id = c.company_id AND dc.contact_id = c.id
           ))
         ORDER BY c.updated_at DESC NULLS LAST, c.id DESC
         LIMIT 100`,
        [companyId]
    );
    return rows;
}

module.exports = {
    listContacts,
    getContactById,
    getContactAccounts,
    getContactDealRoles,
    getKeyContactsByAccount,
    contactsMissingFields,
};
