/**
 * SQL helpers for `estimate_item_presets` (per-company item catalog).
 * Every query is scoped by company_id.
 */

'use strict';

const db = require('./connection');

function queryFor(client) {
    return client?.query ? client.query.bind(client) : db.query;
}

const COLUMNS = `
    id,
    company_id,
    name,
    description,
    default_quantity,
    default_unit_price,
    default_taxable,
    usage_count,
    last_used_at,
    created_by,
    archived_at,
    created_at,
    updated_at
`;

async function searchForCompany(companyId, { search = '', limit = 10 } = {}, client = null) {
    const query = queryFor(client);
    const params = [companyId];
    let where = `company_id = $1 AND archived_at IS NULL`;
    if (search && search.trim()) {
        params.push(`%${search.trim()}%`);
        where += ` AND (name ILIKE $${params.length} OR coalesce(description, '') ILIKE $${params.length})`;
    }
    params.push(Math.min(Math.max(limit | 0, 1), 50));
    const { rows } = await query(
        `SELECT ${COLUMNS} FROM estimate_item_presets
         WHERE ${where}
         ORDER BY usage_count DESC, last_used_at DESC NULLS LAST, lower(name) ASC
         LIMIT $${params.length}`,
        params,
    );
    return rows;
}

async function getByIdScoped(companyId, id, client = null) {
    const query = queryFor(client);
    const { rows } = await query(
        `SELECT ${COLUMNS} FROM estimate_item_presets
         WHERE id = $1 AND company_id = $2`,
        [id, companyId],
    );
    return rows[0] || null;
}

async function findByNameScoped(companyId, name, client = null) {
    const query = queryFor(client);
    const { rows } = await query(
        `SELECT ${COLUMNS} FROM estimate_item_presets
         WHERE company_id = $1 AND archived_at IS NULL AND lower(name) = lower($2)
         LIMIT 1`,
        [companyId, name],
    );
    return rows[0] || null;
}

async function insertPreset(companyId, payload, client = null) {
    const query = queryFor(client);
    const {
        name,
        description = null,
        default_quantity = 1,
        default_unit_price = 0,
        default_taxable = false,
        createdBy = null,
    } = payload;
    const { rows } = await query(
        `INSERT INTO estimate_item_presets
            (company_id, name, description, default_quantity, default_unit_price, default_taxable, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING ${COLUMNS}`,
        [companyId, name, description, default_quantity, default_unit_price, !!default_taxable, createdBy],
    );
    return rows[0];
}

async function updatePresetScoped(companyId, id, payload, client = null) {
    const query = queryFor(client);
    const fields = [];
    const params = [];
    for (const [k, dbCol] of [
        ['name', 'name'],
        ['description', 'description'],
        ['default_quantity', 'default_quantity'],
        ['default_unit_price', 'default_unit_price'],
        ['default_taxable', 'default_taxable'],
    ]) {
        if (payload[k] !== undefined) {
            params.push(payload[k]);
            fields.push(`${dbCol} = $${params.length}`);
        }
    }
    if (fields.length === 0) return getByIdScoped(companyId, id, client);
    fields.push('updated_at = NOW()');
    params.push(id, companyId);
    const sql = `UPDATE estimate_item_presets
                 SET ${fields.join(', ')}
                 WHERE id = $${params.length - 1} AND company_id = $${params.length}
                 RETURNING ${COLUMNS}`;
    const { rows } = await query(sql, params);
    return rows[0] || null;
}

async function archivePresetScoped(companyId, id, client = null) {
    const query = queryFor(client);
    const { rows } = await query(
        `UPDATE estimate_item_presets
         SET archived_at = NOW(), updated_at = NOW()
         WHERE id = $1 AND company_id = $2 AND archived_at IS NULL
         RETURNING ${COLUMNS}`,
        [id, companyId],
    );
    return rows[0] || null;
}

async function incrementUsageScoped(companyId, id, client = null) {
    const query = queryFor(client);
    const { rows } = await query(
        `UPDATE estimate_item_presets
         SET usage_count = usage_count + 1, last_used_at = NOW(), updated_at = NOW()
         WHERE id = $1 AND company_id = $2 AND archived_at IS NULL
         RETURNING ${COLUMNS}`,
        [id, companyId],
    );
    return rows[0] || null;
}

module.exports = {
    searchForCompany,
    getByIdScoped,
    findByNameScoped,
    insertPreset,
    updatePresetScoped,
    archivePresetScoped,
    incrementUsageScoped,
};
