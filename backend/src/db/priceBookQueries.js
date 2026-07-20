/**
 * SQL helpers for the Price Book — PRICEBOOK-001.
 * Tables: price_book_categories, price_book_groups, price_book_group_items.
 * (Items live in estimate_item_presets — see estimateItemPresetsQueries.js.)
 * Every query is company-scoped.
 */

'use strict';

const db = require('./connection');

function queryFor(client) {
    return client?.query ? client.query.bind(client) : db.query;
}

const CAT_COLS = `id, company_id, parent_id, name, description, sort_order, archived_at, created_by, created_at, updated_at`;
const GRP_COLS = `id, company_id, category_id, name, description, sort_order, archived_at, created_by, created_at, updated_at`;

// ── Categories ───────────────────────────────────────────────────────────────
async function listCategories(companyId, { includeArchived = false } = {}) {
    const where = includeArchived ? '' : ' AND archived_at IS NULL';
    const { rows } = await db.query(
        `SELECT ${CAT_COLS} FROM price_book_categories
         WHERE company_id = $1${where}
         ORDER BY sort_order ASC, lower(name) ASC`,
        [companyId],
    );
    return rows;
}
async function getCategory(companyId, id) {
    const { rows } = await db.query(
        `SELECT ${CAT_COLS} FROM price_book_categories WHERE id = $1 AND company_id = $2`, [id, companyId]);
    return rows[0] || null;
}
async function insertCategory(companyId, { name, description = null, parent_id = null, sort_order = 0, createdBy = null }) {
    const { rows } = await db.query(
        `INSERT INTO price_book_categories (company_id, parent_id, name, description, sort_order, created_by)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING ${CAT_COLS}`,
        [companyId, parent_id, name, description, sort_order, createdBy]);
    return rows[0];
}
async function updateCategory(companyId, id, payload) {
    const fields = [], params = [];
    for (const k of ['name', 'description', 'parent_id', 'sort_order']) {
        if (payload[k] !== undefined) { params.push(payload[k]); fields.push(`${k} = $${params.length}`); }
    }
    if (!fields.length) return getCategory(companyId, id);
    fields.push('updated_at = NOW()');
    params.push(id, companyId);
    const { rows } = await db.query(
        `UPDATE price_book_categories SET ${fields.join(', ')}
         WHERE id = $${params.length - 1} AND company_id = $${params.length} RETURNING ${CAT_COLS}`, params);
    return rows[0] || null;
}
async function archiveCategory(companyId, id) {
    const client = await db.getClient();
    try {
        await client.query('BEGIN');
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1::text, 193))', [companyId]);
        const { rows: categories } = await client.query(
            `SELECT ${CAT_COLS} FROM price_book_categories
             WHERE id = $1 AND company_id = $2 AND archived_at IS NULL
             FOR UPDATE`,
            [id, companyId],
        );
        if (!categories.length) {
            await client.query('ROLLBACK');
            return { category: null, dependencies: null };
        }
        const { rows: [dependencies] } = await client.query(
            `SELECT
                (SELECT count(*)::int FROM price_book_categories c
                 WHERE c.parent_id = $1 AND c.company_id = $2 AND c.archived_at IS NULL) AS children,
                (SELECT count(*)::int FROM estimate_item_presets i
                 WHERE i.category_id = $1 AND i.company_id = $2 AND i.archived_at IS NULL) AS items,
                (SELECT count(*)::int FROM price_book_groups g
                 WHERE g.category_id = $1 AND g.company_id = $2 AND g.archived_at IS NULL) AS groups`,
            [id, companyId],
        );
        if (dependencies.children || dependencies.items || dependencies.groups) {
            await client.query('ROLLBACK');
            return { category: categories[0], dependencies };
        }
        const { rows } = await client.query(
            `UPDATE price_book_categories SET archived_at = NOW(), updated_at = NOW()
             WHERE id = $1 AND company_id = $2 AND archived_at IS NULL RETURNING ${CAT_COLS}`,
            [id, companyId],
        );
        await client.query('COMMIT');
        return { category: rows[0] || null, dependencies: null };
    } catch (err) {
        try { await client.query('ROLLBACK'); } catch (_) { /* noop */ }
        throw err;
    } finally {
        client.release();
    }
}

// ── Groups ───────────────────────────────────────────────────────────────────
// List with computed item_count + total over ACTIVE member items.
async function listGroups(companyId, { includeArchived = false, search = '', category_id = null, uncategorized = false } = {}) {
    const params = [companyId];
    let where = `g.company_id = $1`;
    if (!includeArchived) where += ` AND g.archived_at IS NULL`;
    if (uncategorized) where += ' AND g.category_id IS NULL';
    else if (category_id != null) { params.push(category_id); where += ` AND g.category_id = $${params.length}`; }
    if (search && search.trim()) { params.push(`%${search.trim()}%`); where += ` AND g.name ILIKE $${params.length}`; }
    const { rows } = await db.query(
        `SELECT ${GRP_COLS.split(',').map(c => 'g.' + c.trim()).join(', ')},
                c.name AS category_name,
                COALESCE(agg.item_count, 0)::int AS item_count,
                COALESCE(agg.total, 0)::numeric  AS total
         FROM price_book_groups g
         LEFT JOIN price_book_categories c ON c.id = g.category_id AND c.company_id = g.company_id
         LEFT JOIN (
             SELECT gi.group_id,
                    count(*) AS item_count,
                    sum(gi.quantity * i.default_unit_price) AS total
             FROM price_book_group_items gi
             JOIN estimate_item_presets i ON i.id = gi.item_id AND i.company_id = gi.company_id AND i.archived_at IS NULL
             WHERE gi.company_id = $1
             GROUP BY gi.group_id
         ) agg ON agg.group_id = g.id
         WHERE ${where}
         ORDER BY g.sort_order ASC, lower(g.name) ASC`,
        params);
    return rows;
}
async function getGroup(companyId, id) {
    const { rows } = await db.query(
        `SELECT ${GRP_COLS} FROM price_book_groups WHERE id = $1 AND company_id = $2`, [id, companyId]);
    return rows[0] || null;
}
// Group with its member items (incl. archived, flagged) for the editor.
async function getGroupItems(companyId, groupId) {
    const { rows } = await db.query(
        `SELECT gi.id AS link_id, gi.item_id, gi.quantity, gi.sort_order,
                i.name, i.description, i.default_unit_price, i.default_taxable, i.unit, i.code,
                (i.archived_at IS NOT NULL) AS item_archived
         FROM price_book_group_items gi
         JOIN estimate_item_presets i ON i.id = gi.item_id AND i.company_id = gi.company_id
         WHERE gi.group_id = $1 AND gi.company_id = $2
         ORDER BY gi.sort_order ASC, gi.id ASC`,
        [groupId, companyId]);
    return rows;
}
async function insertGroup(companyId, { name, description = null, category_id = null, sort_order = 0, createdBy = null }) {
    const { rows } = await db.query(
        `INSERT INTO price_book_groups (company_id, name, description, category_id, sort_order, created_by)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING ${GRP_COLS}`,
        [companyId, name, description, category_id, sort_order, createdBy]);
    return rows[0];
}
async function updateGroup(companyId, id, payload) {
    const fields = [], params = [];
    for (const k of ['name', 'description', 'category_id', 'sort_order']) {
        if (payload[k] !== undefined) { params.push(payload[k]); fields.push(`${k} = $${params.length}`); }
    }
    if (!fields.length) return getGroup(companyId, id);
    fields.push('updated_at = NOW()');
    params.push(id, companyId);
    const { rows } = await db.query(
        `UPDATE price_book_groups SET ${fields.join(', ')}
         WHERE id = $${params.length - 1} AND company_id = $${params.length} RETURNING ${GRP_COLS}`, params);
    return rows[0] || null;
}
async function archiveGroup(companyId, id) {
    const { rows } = await db.query(
        `UPDATE price_book_groups SET archived_at = NOW(), updated_at = NOW()
         WHERE id = $1 AND company_id = $2 AND archived_at IS NULL RETURNING ${GRP_COLS}`, [id, companyId]);
    return rows[0] || null;
}

// Replace a group's membership atomically. items = [{ item_id, quantity }] in order.
async function setGroupItems(companyId, groupId, items) {
    const client = await db.getClient();
    try {
        await client.query('BEGIN');
        await client.query('DELETE FROM price_book_group_items WHERE group_id = $1 AND company_id = $2', [groupId, companyId]);
        let i = 0;
        for (const it of items) {
            // Guard: only items belonging to this company can be linked.
            const { rows: ok } = await client.query(
                'SELECT 1 FROM estimate_item_presets WHERE id = $1 AND company_id = $2', [it.item_id, companyId]);
            if (!ok.length) continue;
            await client.query(
                `INSERT INTO price_book_group_items (company_id, group_id, item_id, quantity, sort_order)
                 VALUES ($1,$2,$3,$4,$5)
                 ON CONFLICT (group_id, item_id) DO UPDATE SET quantity = EXCLUDED.quantity, sort_order = EXCLUDED.sort_order`,
                [companyId, groupId, it.item_id, Number(it.quantity) > 0 ? Number(it.quantity) : 1, i++]);
        }
        await client.query('COMMIT');
    } catch (err) {
        try { await client.query('ROLLBACK'); } catch (_) { /* noop */ }
        throw err;
    } finally {
        client.release();
    }
    return getGroupItems(companyId, groupId);
}

// Expansion for adding a group to an estimate/invoice: ACTIVE member items only,
// snapshotting name/desc/unit/price/taxable + the group quantity, in order.
async function getGroupExpansion(companyId, groupId) {
    const { rows } = await db.query(
        `SELECT i.name, i.description, gi.quantity, i.unit, i.default_unit_price AS unit_price, i.default_taxable AS taxable
         FROM price_book_group_items gi
         JOIN estimate_item_presets i ON i.id = gi.item_id AND i.company_id = gi.company_id
         WHERE gi.group_id = $1 AND gi.company_id = $2 AND i.archived_at IS NULL
         ORDER BY gi.sort_order ASC, gi.id ASC`,
        [groupId, companyId]);
    return rows;
}

// ── Import/Export helpers (PRICEBOOK-001) ────────────────────────────────────
async function findCategoryByName(companyId, name, parentId = null) {
    const { rows } = await db.query(
        `SELECT ${CAT_COLS} FROM price_book_categories
         WHERE company_id = $1 AND archived_at IS NULL AND lower(name) = lower($2)
           AND parent_id IS NOT DISTINCT FROM $3
         LIMIT 1`,
        [companyId, name, parentId]);
    return rows[0] || null;
}
async function findGroupByName(companyId, name) {
    const { rows } = await db.query(
        `SELECT ${GRP_COLS} FROM price_book_groups
         WHERE company_id = $1 AND archived_at IS NULL AND lower(name) = lower($2) LIMIT 1`,
        [companyId, name]);
    return rows[0] || null;
}
// Add/refresh a single membership without wiping the rest of the group.
async function upsertGroupItem(companyId, groupId, itemId, quantity) {
    await db.query(
        `INSERT INTO price_book_group_items (company_id, group_id, item_id, quantity, sort_order)
         VALUES ($1,$2,$3,$4, COALESCE((SELECT max(sort_order)+1 FROM price_book_group_items WHERE group_id=$2), 0))
         ON CONFLICT (group_id, item_id) DO UPDATE SET quantity = EXCLUDED.quantity`,
        [companyId, groupId, itemId, Number(quantity) > 0 ? Number(quantity) : 1]);
}
// One row per (item, active membership); standalone items appear once with no group.
async function exportRows(companyId) {
    const { rows } = await db.query(
        `SELECT i.name, i.description, i.code, i.unit, i.default_unit_price, i.default_taxable,
                c.name AS category_name, g.name AS group_name, gi.quantity AS group_quantity
         FROM estimate_item_presets i
         LEFT JOIN price_book_categories c ON c.id = i.category_id AND c.company_id = i.company_id AND c.archived_at IS NULL
         LEFT JOIN price_book_group_items gi ON gi.item_id = i.id AND gi.company_id = i.company_id
         LEFT JOIN price_book_groups g ON g.id = gi.group_id AND g.company_id = i.company_id AND g.archived_at IS NULL
         WHERE i.company_id = $1 AND i.archived_at IS NULL
           AND (gi.id IS NULL OR g.id IS NOT NULL)
         ORDER BY lower(i.name), lower(g.name) NULLS FIRST`,
        [companyId]);
    return rows;
}

module.exports = {
    listCategories, getCategory, insertCategory, updateCategory, archiveCategory,
    listGroups, getGroup, getGroupItems, insertGroup, updateGroup, archiveGroup,
    setGroupItems, getGroupExpansion,
    findCategoryByName, findGroupByName, upsertGroupItem, exportRows,
};
