'use strict';

const db = require('./connection');
const { requireCompanyId, queryFor, clampLimit, clampOffset } = require('./crmUtils');

async function listNotes(companyId, filters = {}, client = null) {
    requireCompanyId(companyId);
    const query = queryFor(client, db);
    const params = [companyId];
    const conditions = ['n.company_id = $1'];

    if (filters.entity_type) {
        params.push(filters.entity_type);
        conditions.push(`n.entity_type = $${params.length}`);
    }
    if (filters.entity_id) {
        params.push(filters.entity_id);
        conditions.push(`n.entity_id = $${params.length}`);
    }
    if (filters.source) {
        params.push(filters.source);
        conditions.push(`n.source = $${params.length}`);
    }

    const limit = clampLimit(filters.limit);
    const offset = clampOffset(filters.offset);
    params.push(limit, offset);

    const { rows } = await query(
        `SELECT n.*, u.email AS created_by_email, u.full_name AS created_by_name
         FROM crm_notes n
         LEFT JOIN crm_users u ON u.id = n.created_by
         WHERE ${conditions.join(' AND ')}
         ORDER BY n.created_at DESC, n.id DESC
         LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params
    );
    return rows;
}

async function createNote(companyId, payload, client = null) {
    requireCompanyId(companyId);
    const query = queryFor(client, db);
    const { rows } = await query(
        `INSERT INTO crm_notes (company_id, entity_type, entity_id, text, source, created_by)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING *`,
        [
            companyId,
            payload.entity_type,
            payload.entity_id,
            payload.text,
            payload.source,
            payload.created_by || null,
        ]
    );
    return rows[0];
}

module.exports = {
    listNotes,
    createNote,
};
