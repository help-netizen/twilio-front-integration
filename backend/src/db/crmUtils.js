'use strict';

function requireCompanyId(companyId) {
    if (!companyId) {
        const err = new Error('companyId is required');
        err.code = 'COMPANY_ID_REQUIRED';
        throw err;
    }
}

function queryFor(client, db) {
    return client?.query ? client.query.bind(client) : db.query;
}

function clampLimit(value, fallback = 50, max = 100) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
    return Math.min(Math.trunc(parsed), max);
}

function clampOffset(value) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 0) return 0;
    return Math.trunc(parsed);
}

function addTextSearch({ conditions, params, fields, value }) {
    if (!value || !String(value).trim()) return;
    params.push(`%${String(value).trim()}%`);
    const idx = params.length;
    conditions.push(`(${fields.map(field => `${field} ILIKE $${idx}`).join(' OR ')})`);
}

module.exports = {
    requireCompanyId,
    queryFor,
    clampLimit,
    clampOffset,
    addTextSearch,
};
