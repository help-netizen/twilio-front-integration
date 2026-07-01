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
    category_id,
    code,
    unit,
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
        category_id = null,
        code = null,
        unit = null,
        createdBy = null,
    } = payload;
    const { rows } = await query(
        `INSERT INTO estimate_item_presets
            (company_id, name, description, default_quantity, default_unit_price, default_taxable, category_id, code, unit, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         RETURNING ${COLUMNS}`,
        [companyId, name, description, default_quantity, default_unit_price, !!default_taxable, category_id, code, unit, createdBy],
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
        ['category_id', 'category_id'],
        ['code', 'code'],
        ['unit', 'unit'],
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

// PRICEBOOK-002: given a list of ids, return the subset that are active
// (exist AND belong to this company AND are not archived). Used by the service
// to pre-validate update ids before opening the bulk-save transaction.
async function findActiveIdsScoped(companyId, ids, client = null) {
    const query = queryFor(client);
    const numericIds = (Array.isArray(ids) ? ids : [])
        .map(id => Number(id))
        .filter(id => Number.isInteger(id));
    if (numericIds.length === 0) return [];
    const { rows } = await query(
        `SELECT id FROM estimate_item_presets
         WHERE company_id = $1 AND archived_at IS NULL AND id = ANY($2::int[])`,
        [companyId, numericIds],
    );
    return rows.map(r => Number(r.id));
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

// PRICEBOOK-001: paginated management list (Items tab) — category filter,
// archived toggle, joined category name. Distinct from searchForCompany (the
// inline combobox, capped active-only search).
async function listForManage(companyId, { search = '', category_id = null, includeArchived = false, limit = 50, offset = 0 } = {}, client = null) {
    const query = queryFor(client);
    const params = [companyId];
    let where = `p.company_id = $1`;
    if (!includeArchived) where += ` AND p.archived_at IS NULL`;
    if (category_id != null) { params.push(category_id); where += ` AND p.category_id = $${params.length}`; }
    if (search && search.trim()) {
        params.push(`%${search.trim()}%`);
        where += ` AND (p.name ILIKE $${params.length} OR coalesce(p.code,'') ILIKE $${params.length} OR coalesce(p.description,'') ILIKE $${params.length})`;
    }
    params.push(Math.min(Math.max(limit | 0, 1), 1000));
    params.push(Math.max(offset | 0, 0));
    const { rows } = await query(
        `SELECT ${COLUMNS.split(',').map(c => 'p.' + c.trim()).join(', ')}, c.name AS category_name
         FROM estimate_item_presets p
         LEFT JOIN price_book_categories c ON c.id = p.category_id
         WHERE ${where}
         ORDER BY p.archived_at IS NOT NULL, lower(p.name) ASC
         LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params,
    );
    return rows;
}

// PRICEBOOK-002: atomic bulk save (creates/updates/deletes) in ONE transaction.
// Reuses insertPreset/updatePresetScoped/archivePresetScoped with a shared client.
// A foreign/absent id on an UPDATE (updatePresetScoped → null) aborts the whole
// batch (all-or-nothing). A no-op DELETE (already archived / foreign id → null)
// is skipped silently and NOT counted (idempotent).
async function bulkSaveItems(companyId, { creates = [], updates = [], deletes = [] } = {}, { actorId = null } = {}) {
    const client = await db.getClient();
    const createdMap = [];
    const counts = { created: 0, updated: 0, deleted: 0 };
    try {
        await client.query('BEGIN');
        for (const c of creates) {
            const { clientKey, ...fields } = c;
            const row = await insertPreset(companyId, { ...fields, createdBy: actorId }, client);
            createdMap.push({ clientKey: clientKey ?? null, id: row.id });
            counts.created += 1;
        }
        for (const u of updates) {
            const { id, ...fields } = u;
            const row = await updatePresetScoped(companyId, id, fields, client);
            if (!row) {
                // TOCTOU: id vanished (foreign/concurrently-archived) between the
                // service pre-check and COMMIT. Tag it so the service maps to 409.
                throw Object.assign(new Error('preset_not_found'), { code: 'preset_not_found', itemId: id });
            }
            counts.updated += 1;
        }
        for (const id of deletes) {
            const row = await archivePresetScoped(companyId, id, client);
            if (row) counts.deleted += 1;
        }
        await client.query('COMMIT');
    } catch (err) {
        try { await client.query('ROLLBACK'); } catch (_) { /* noop */ }
        throw err;
    } finally {
        client.release();
    }
    return { createdMap, counts };
}

module.exports = {
    searchForCompany,
    listForManage,
    getByIdScoped,
    findByNameScoped,
    insertPreset,
    updatePresetScoped,
    archivePresetScoped,
    findActiveIdsScoped,
    incrementUsageScoped,
    bulkSaveItems,
};
