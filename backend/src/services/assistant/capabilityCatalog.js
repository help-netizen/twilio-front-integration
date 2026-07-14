'use strict';

const db = require('../../db/connection');

function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function toObject(value) {
    if (isPlainObject(value)) return value;
    if (typeof value !== 'string') return {};
    try {
        const parsed = JSON.parse(value);
        return isPlainObject(parsed) ? parsed : {};
    } catch {
        return {};
    }
}

function textOr(value, fallback) {
    return typeof value === 'string' && value.trim() ? value : fallback;
}

function stringArray(value) {
    if (!Array.isArray(value)) return [];
    return value.filter(item => typeof item === 'string' && item.trim());
}

function projectCapability(row) {
    const assistant = toObject(row.assistant);
    return {
        app_key: row.app_key,
        name: row.name,
        category: row.category,
        short_description: row.short_description,
        what_it_does: textOr(assistant.what_it_does, row.short_description),
        prerequisites: stringArray(assistant.prerequisites),
        setup_steps: stringArray(assistant.setup_steps),
        outcome: textOr(assistant.outcome, null),
        recommend_when: stringArray(assistant.recommend_when),
        gotchas: stringArray(assistant.gotchas),
    };
}

async function getCapabilityCatalog(appKey = null) {
    const { rows } = await db.query(
        `SELECT
            app_key,
            name,
            category,
            short_description,
            metadata->'assistant' AS assistant
         FROM marketplace_apps
         WHERE status = 'published'
           AND ($1::text IS NULL OR app_key = $1)
         ORDER BY category ASC, name ASC`,
        [appKey]
    );
    return rows.map(projectCapability);
}

module.exports = { getCapabilityCatalog };
