/**
 * Estimate item preset orchestration layer.
 *
 * - search() — driving the EstimateDetailPanel autocomplete (recent / by name).
 * - create() — when user adds a brand-new item; preset goes into the catalog
 *   alongside the actual estimate row.
 * - update() / archive() — for the future "Settings → Item presets" UI.
 * - recordUsage() — bumps usage_count + last_used_at; fired by the frontend
 *   when an existing preset is added to an estimate.
 */

'use strict';

const queries = require('../db/estimateItemPresetsQueries');

class EstimateItemPresetError extends Error {
    constructor(code, httpStatus, message, details = null) {
        super(message);
        this.name = 'EstimateItemPresetError';
        this.code = code;
        this.httpStatus = httpStatus;
        this.details = details;
    }
}

function mapRow(row) {
    if (!row) return null;
    return {
        id: row.id,
        name: row.name,
        description: row.description,
        default_quantity: row.default_quantity == null ? null : Number(row.default_quantity),
        default_unit_price: row.default_unit_price == null ? null : Number(row.default_unit_price),
        default_taxable: !!row.default_taxable,
        category_id: row.category_id == null ? null : Number(row.category_id),
        category_name: row.category_name ?? null,
        code: row.code ?? null,
        unit: row.unit ?? null,
        usage_count: Number(row.usage_count || 0),
        last_used_at: row.last_used_at,
        archived_at: row.archived_at,
        created_at: row.created_at,
        updated_at: row.updated_at,
    };
}

function validatePayload(payload, { partial = false } = {}) {
    if (!partial || payload.name !== undefined) {
        const n = (payload.name || '').trim();
        if (!n) throw new EstimateItemPresetError('validation_failed', 422, 'name is required');
        if (n.length > 200) throw new EstimateItemPresetError('validation_failed', 422, 'name too long (max 200)');
    }
    if (payload.description != null && String(payload.description).length > 4000) {
        throw new EstimateItemPresetError('validation_failed', 422, 'description too long (max 4000)');
    }
    for (const k of ['default_quantity', 'default_unit_price']) {
        if (payload[k] !== undefined && payload[k] !== null) {
            const n = Number(payload[k]);
            if (!Number.isFinite(n)) throw new EstimateItemPresetError('validation_failed', 422, `${k} must be a number`);
            if (k === 'default_quantity' && n <= 0) throw new EstimateItemPresetError('validation_failed', 422, 'default_quantity must be > 0');
            if (k === 'default_unit_price' && n < 0) throw new EstimateItemPresetError('validation_failed', 422, 'default_unit_price must be >= 0');
        }
    }
}

async function search(companyId, params = {}) {
    const rows = await queries.searchForCompany(companyId, params);
    return rows.map(mapRow);
}

// PRICEBOOK-001: paginated Items-tab list (category filter, archived toggle).
async function listForManage(companyId, params = {}) {
    const rows = await queries.listForManage(companyId, params);
    return rows.map(mapRow);
}

async function get(companyId, id) {
    const row = await queries.getByIdScoped(companyId, id);
    if (!row) throw new EstimateItemPresetError('preset_not_found', 404, `Preset ${id} not found`);
    return mapRow(row);
}

async function create(companyId, payload, { createdBy = null } = {}) {
    validatePayload(payload);
    // Dedupe by name (case-insensitive). If an active preset already exists, return it
    // instead of erroring — keeps the "type then create" flow idempotent.
    const existing = await queries.findByNameScoped(companyId, payload.name);
    if (existing) return mapRow(existing);
    const inserted = await queries.insertPreset(companyId, { ...payload, createdBy });
    return mapRow(inserted);
}

async function update(companyId, id, payload) {
    validatePayload(payload, { partial: true });
    const existing = await queries.getByIdScoped(companyId, id);
    if (!existing) throw new EstimateItemPresetError('preset_not_found', 404, `Preset ${id} not found`);
    const updated = await queries.updatePresetScoped(companyId, id, payload);
    return mapRow(updated);
}

async function archive(companyId, id) {
    const archived = await queries.archivePresetScoped(companyId, id);
    if (!archived) throw new EstimateItemPresetError('preset_not_found', 404, `Preset ${id} not found or already archived`);
    return mapRow(archived);
}

// PRICEBOOK-002: atomic bulk save for the Items management grid.
// Whole-batch all-or-nothing: validate everything BEFORE any DB write, collect
// ALL errors into details[]. Empty payload → 200 with counts {0,0,0}.
function toNumOrNull(v) {
    if (v === undefined || v === null || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
}
function toPrice(v) {
    if (v === undefined || v === null || v === '') return 0;
    return Number(v);
}
function trimOrNull(v) {
    if (v === undefined || v === null) return null;
    const s = String(v).trim();
    return s === '' ? null : s;
}

function normalizeCreate(raw) {
    return {
        clientKey: raw.clientKey ?? null,
        name: trimOrNull(raw.name),
        description: trimOrNull(raw.description),
        code: trimOrNull(raw.code),
        unit: trimOrNull(raw.unit),
        default_unit_price: toPrice(raw.default_unit_price),
        default_taxable: !!raw.default_taxable,
        category_id: toNumOrNull(raw.category_id),
    };
}
function normalizeUpdate(raw) {
    return {
        id: toNumOrNull(raw.id),
        name: trimOrNull(raw.name),
        description: trimOrNull(raw.description),
        code: trimOrNull(raw.code),
        unit: trimOrNull(raw.unit),
        default_unit_price: toPrice(raw.default_unit_price),
        default_taxable: !!raw.default_taxable,
        category_id: toNumOrNull(raw.category_id),
    };
}

// A brand-new row with nothing meaningful in it → drop silently.
function isEmptyCreate(c) {
    return !c.name && !c.code && !c.description && !c.unit
        && (c.default_unit_price === 0 || c.default_unit_price === null || c.default_unit_price === undefined)
        && c.category_id == null;
}

function validateRow(row, scope, index, details) {
    if (!row.name || !String(row.name).trim()) {
        details.push({ scope, index, field: 'name', error: 'name is required' });
    } else if (String(row.name).length > 200) {
        details.push({ scope, index, field: 'name', error: 'name too long (max 200)' });
    }
    const price = Number(row.default_unit_price);
    if (!Number.isFinite(price) || price < 0) {
        details.push({ scope, index, field: 'default_unit_price', error: 'default_unit_price must be a number >= 0' });
    }
    if (row.description != null && String(row.description).length > 4000) {
        details.push({ scope, index, field: 'description', error: 'description too long (max 4000)' });
    }
}

async function bulkSaveItems(companyId, payload = {}, { actorId = null } = {}) {
    const rawCreates = Array.isArray(payload.creates) ? payload.creates : [];
    const rawUpdates = Array.isArray(payload.updates) ? payload.updates : [];
    const rawDeletes = Array.isArray(payload.deletes) ? payload.deletes : [];

    const creates = rawCreates
        .filter(r => r && typeof r === 'object')
        .map(normalizeCreate)
        .filter(c => !isEmptyCreate(c));
    const updates = rawUpdates
        .filter(r => r && typeof r === 'object')
        .map(normalizeUpdate)
        .filter(u => u.id != null);
    const deletes = rawDeletes
        .map(toNumOrNull)
        .filter(id => id != null);

    // ── Validate the whole batch BEFORE any DB write ──────────────────────────
    const details = [];
    creates.forEach((c, i) => validateRow(c, 'creates', i, details));
    updates.forEach((u, i) => validateRow(u, 'updates', i, details));

    // Category ownership: every DISTINCT non-null category_id must belong to us.
    const catIds = [...new Set(
        [...creates, ...updates].map(r => r.category_id).filter(id => id != null),
    )];
    if (catIds.length) {
        const pbQueries = require('../db/priceBookQueries');
        const owned = new Set();
        for (const id of catIds) {
            // eslint-disable-next-line no-await-in-loop
            const cat = await pbQueries.getCategory(companyId, id);
            if (cat) owned.add(id);
        }
        creates.forEach((c, i) => {
            if (c.category_id != null && !owned.has(c.category_id)) {
                details.push({ scope: 'creates', index: i, field: 'category_id', error: 'category not found' });
            }
        });
        updates.forEach((u, i) => {
            if (u.category_id != null && !owned.has(u.category_id)) {
                details.push({ scope: 'updates', index: i, field: 'category_id', error: 'category not found' });
            }
        });
    }

    // Pre-validate update ids: each must resolve to an active preset owned by us.
    // A foreign/archived id writes nothing and surfaces as a per-cell 422 detail
    // (consistent with the whole-batch validation above).
    if (updates.length) {
        const activeIds = new Set(
            await queries.findActiveIdsScoped(companyId, updates.map(u => u.id)),
        );
        updates.forEach((u, i) => {
            if (!activeIds.has(Number(u.id))) {
                details.push({ scope: 'updates', index: i, field: 'id', error: 'Item not found or archived' });
            }
        });
    }

    if (details.length) {
        throw new EstimateItemPresetError('validation_failed', 422, 'Validation failed', details);
    }

    let createdMap;
    let counts;
    try {
        ({ createdMap, counts } = await queries.bulkSaveItems(
            companyId, { creates, updates, deletes }, { actorId },
        ));
    } catch (err) {
        // Safety net for the true TOCTOU race between the pre-check and COMMIT:
        // the query layer tags a vanished update id so we render a clean 409.
        if (err && err.code === 'preset_not_found') {
            throw new EstimateItemPresetError(
                'preset_not_found', 409,
                'An item changed since the page loaded — reload and try again.',
            );
        }
        throw err;
    }

    const rows = await queries.listForManage(companyId, { limit: 1000, offset: 0, includeArchived: false });
    return {
        items: rows.map(mapRow),
        summary: { created: counts.created, updated: counts.updated, deleted: counts.deleted },
        createdMap,
    };
}

async function recordUsage(companyId, id) {
    const updated = await queries.incrementUsageScoped(companyId, id);
    if (!updated) throw new EstimateItemPresetError('preset_not_found', 404, `Preset ${id} not found`);
    return mapRow(updated);
}

module.exports = {
    EstimateItemPresetError,
    search,
    listForManage,
    get,
    create,
    update,
    archive,
    bulkSaveItems,
    recordUsage,
};
