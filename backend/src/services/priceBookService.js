/**
 * Price Book orchestration — PRICEBOOK-001.
 * Categories + Groups (+ group membership) + group expansion for documents.
 * Items are handled by estimateItemPresetsService. Company-scoped throughout.
 */

'use strict';

const q = require('../db/priceBookQueries');
const presetQ = require('../db/estimateItemPresetsQueries');

class PriceBookError extends Error {
    constructor(code, httpStatus, message) {
        super(message);
        this.name = 'PriceBookError';
        this.code = code;
        this.httpStatus = httpStatus;
    }
}

function requireName(payload, { partial = false } = {}) {
    if (!partial || payload.name !== undefined) {
        const n = (payload.name || '').trim();
        if (!n) throw new PriceBookError('validation_failed', 422, 'name is required');
        if (n.length > 200) throw new PriceBookError('validation_failed', 422, 'name too long (max 200)');
    }
}

const num = (v) => (v == null ? null : Number(v));

// ── Categories ───────────────────────────────────────────────────────────────
async function listCategories(companyId, opts) { return q.listCategories(companyId, opts); }
async function createCategory(companyId, payload, { createdBy = null } = {}) {
    requireName(payload);
    return q.insertCategory(companyId, { ...payload, createdBy });
}
async function updateCategory(companyId, id, payload) {
    requireName(payload, { partial: true });
    const row = await q.updateCategory(companyId, id, payload);
    if (!row) throw new PriceBookError('not_found', 404, `Category ${id} not found`);
    return row;
}
async function archiveCategory(companyId, id) {
    const row = await q.archiveCategory(companyId, id);
    if (!row) throw new PriceBookError('not_found', 404, `Category ${id} not found or already archived`);
    return row;
}

// ── Groups ───────────────────────────────────────────────────────────────────
function mapGroup(row) {
    if (!row) return null;
    return { ...row, item_count: row.item_count == null ? undefined : Number(row.item_count), total: row.total == null ? undefined : Number(row.total) };
}
async function listGroups(companyId, opts) { return (await q.listGroups(companyId, opts)).map(mapGroup); }

async function getGroup(companyId, id) {
    const group = await q.getGroup(companyId, id);
    if (!group) throw new PriceBookError('not_found', 404, `Group ${id} not found`);
    const items = await q.getGroupItems(companyId, id);
    return { ...group, items: items.map(r => ({ ...r, quantity: num(r.quantity), default_unit_price: num(r.default_unit_price), default_taxable: !!r.default_taxable, item_archived: !!r.item_archived })) };
}

async function createGroup(companyId, payload, { createdBy = null } = {}) {
    requireName(payload);
    const group = await q.insertGroup(companyId, { ...payload, createdBy });
    if (Array.isArray(payload.items)) await q.setGroupItems(companyId, group.id, normalizeItems(payload.items));
    return getGroup(companyId, group.id);
}
async function updateGroup(companyId, id, payload) {
    requireName(payload, { partial: true });
    const existing = await q.getGroup(companyId, id);
    if (!existing) throw new PriceBookError('not_found', 404, `Group ${id} not found`);
    if (payload.name !== undefined || payload.description !== undefined || payload.category_id !== undefined || payload.sort_order !== undefined) {
        await q.updateGroup(companyId, id, payload);
    }
    // items provided ⇒ replace membership; absent ⇒ leave as-is.
    if (Array.isArray(payload.items)) await q.setGroupItems(companyId, id, normalizeItems(payload.items));
    return getGroup(companyId, id);
}
async function archiveGroup(companyId, id) {
    const row = await q.archiveGroup(companyId, id);
    if (!row) throw new PriceBookError('not_found', 404, `Group ${id} not found or already archived`);
    return row;
}

function normalizeItems(items) {
    return items
        .map(it => ({ item_id: Number(it?.item_id), quantity: Number(it?.quantity) > 0 ? Number(it?.quantity) : 1 }))
        .filter(it => Number.isFinite(it.item_id));
}

// Expansion for adding a group to a document → line-item shaped rows.
async function getGroupExpansion(companyId, groupId) {
    const group = await q.getGroup(companyId, groupId);
    if (!group) throw new PriceBookError('not_found', 404, `Group ${groupId} not found`);
    const rows = await q.getGroupExpansion(companyId, groupId);
    return rows.map(r => ({
        name: r.name,
        description: r.description || '',
        quantity: String(num(r.quantity) ?? 1),
        unit: r.unit || null,
        unit_price: String(num(r.unit_price) ?? 0),
        taxable: !!r.taxable,
    }));
}

// ── Import / Export (CSV) ────────────────────────────────────────────────────
const CSV_HEADERS = ['Name', 'Description', 'Code', 'Unit', 'Unit Price', 'Taxable', 'Category', 'Group', 'Group Quantity'];

function csvEscape(v) {
    const s = v == null ? '' : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function toCsv(rows) { return rows.map(r => r.map(csvEscape).join(',')).join('\r\n'); }

// Minimal RFC-4180-ish parser (handles quoted fields, embedded commas/newlines, "" escapes, BOM).
function parseCsv(text) {
    const s = String(text || '').replace(/^﻿/, '');
    const rows = []; let row = []; let field = ''; let inQ = false;
    for (let i = 0; i < s.length; i++) {
        const c = s[i];
        if (inQ) {
            if (c === '"') { if (s[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
            else field += c;
        } else if (c === '"') inQ = true;
        else if (c === ',') { row.push(field); field = ''; }
        else if (c === '\r') { /* skip */ }
        else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
        else field += c;
    }
    if (field.length || row.length) { row.push(field); rows.push(row); }
    return rows;
}

const TEMPLATE_CSV = toCsv([
    CSV_HEADERS,
    ['Labor to replace drain motor', 'Diagnose and swap the drain motor', '1010', 'hr', '95', 'No', 'Dishwasher repair', 'Drain motor replacement', '2'],
    ['Drain motor', 'OEM replacement part', '2010', 'ea', '140', 'Yes', 'Dishwasher repair', 'Drain motor replacement', '1'],
    ['Service call fee', '', '1000', 'ea', '25', 'No', 'Dishwasher repair', '', ''],
]);
function templateCsv() { return TEMPLATE_CSV + '\r\n'; }

async function exportCsv(companyId) {
    const rows = await q.exportRows(companyId);
    const body = rows.map(r => [
        r.name, r.description, r.code, r.unit,
        r.default_unit_price == null ? '' : Number(r.default_unit_price),
        r.default_taxable ? 'Yes' : 'No',
        r.category_name || '', r.group_name || '',
        r.group_quantity == null ? '' : Number(r.group_quantity),
    ]);
    return toCsv([CSV_HEADERS, ...body]) + '\r\n';
}

const truthy = (v) => /^(y|yes|true|1|taxable)$/i.test(String(v || '').trim());

async function importCsv(companyId, text, { createdBy = null } = {}) {
    const rows = parseCsv(text).filter(r => r.some(c => String(c).trim() !== ''));
    if (rows.length === 0) throw new PriceBookError('validation_failed', 422, 'The file is empty');

    // Map header → column index (case/space-insensitive), so column order is flexible.
    const norm = (h) => String(h || '').trim().toLowerCase().replace(/\s+/g, '');
    const header = rows[0].map(norm);
    const col = (name) => header.indexOf(norm(name));
    const iName = col('Name');
    if (iName === -1) throw new PriceBookError('validation_failed', 422, 'Missing required "Name" column');
    const iDesc = col('Description'), iCode = col('Code'), iUnit = col('Unit'),
        iPrice = col('Unit Price'), iTax = col('Taxable'), iCat = col('Category'),
        iGrp = col('Group'), iQty = col('Group Quantity');
    const at = (row, idx) => (idx >= 0 && idx < row.length ? String(row[idx]).trim() : '');

    const summary = { rows: rows.length - 1, items_created: 0, items_updated: 0, categories_created: 0, groups_created: 0, memberships: 0, errors: [] };
    const catCache = new Map(); // lower(name) -> id
    const grpCache = new Map();

    async function ensureCategory(name) {
        const key = name.toLowerCase();
        if (catCache.has(key)) return catCache.get(key);
        let cat = await q.findCategoryByName(companyId, name);
        if (!cat) { cat = await q.insertCategory(companyId, { name, createdBy }); summary.categories_created++; }
        catCache.set(key, cat.id);
        return cat.id;
    }
    async function ensureGroup(name, categoryId) {
        const key = name.toLowerCase();
        if (grpCache.has(key)) return grpCache.get(key);
        let g = await q.findGroupByName(companyId, name);
        if (!g) { g = await q.insertGroup(companyId, { name, category_id: categoryId || null, createdBy }); summary.groups_created++; }
        grpCache.set(key, g.id);
        return g.id;
    }

    for (let r = 1; r < rows.length; r++) {
        const row = rows[r];
        try {
            const name = at(row, iName);
            if (!name) { summary.errors.push({ row: r + 1, error: 'Name is empty' }); continue; }
            const categoryId = at(row, iCat) ? await ensureCategory(at(row, iCat)) : null;
            const fields = {
                name,
                description: at(row, iDesc) || null,
                code: at(row, iCode) || null,
                unit: at(row, iUnit) || null,
                default_unit_price: iPrice >= 0 && at(row, iPrice) !== '' ? Number(at(row, iPrice)) || 0 : 0,
                default_taxable: iTax >= 0 ? truthy(at(row, iTax)) : false,
                category_id: categoryId,
            };
            // Upsert item by name (import is source of truth → update if it already exists).
            const existing = await presetQ.findByNameScoped(companyId, name);
            let itemId;
            if (existing) { const u = await presetQ.updatePresetScoped(companyId, existing.id, fields); itemId = u.id; summary.items_updated++; }
            else { const ins = await presetQ.insertPreset(companyId, { ...fields, createdBy }); itemId = ins.id; summary.items_created++; }

            if (at(row, iGrp)) {
                const groupId = await ensureGroup(at(row, iGrp), categoryId);
                const qty = iQty >= 0 && at(row, iQty) !== '' ? Number(at(row, iQty)) || 1 : 1;
                await q.upsertGroupItem(companyId, groupId, itemId, qty);
                summary.memberships++;
            }
        } catch (err) {
            summary.errors.push({ row: r + 1, error: err.message });
        }
    }
    return summary;
}

module.exports = {
    PriceBookError,
    listCategories, createCategory, updateCategory, archiveCategory,
    listGroups, getGroup, createGroup, updateGroup, archiveGroup,
    getGroupExpansion,
    templateCsv, exportCsv, importCsv,
};
