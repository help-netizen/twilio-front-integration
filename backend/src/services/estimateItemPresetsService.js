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
    recordUsage,
};
