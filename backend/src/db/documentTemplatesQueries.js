/**
 * SQL helpers for `document_templates`. Every query is scoped by company_id.
 */

'use strict';

const db = require('./connection');

function queryFor(client) {
    return client?.query ? client.query.bind(client) : db.query;
}

const COLUMNS = `
    id,
    company_id,
    document_type,
    name,
    slug,
    is_default,
    schema_version,
    content,
    archived_at,
    created_by,
    updated_by,
    created_at,
    updated_at
`;

async function listForCompany(companyId, { documentType = null } = {}, client = null) {
    const query = queryFor(client);
    const params = [companyId];
    let sql = `SELECT ${COLUMNS} FROM document_templates
               WHERE company_id = $1 AND archived_at IS NULL`;
    if (documentType) {
        params.push(documentType);
        sql += ` AND document_type = $${params.length}`;
    }
    sql += ` ORDER BY document_type ASC, is_default DESC, name ASC`;
    const { rows } = await query(sql, params);
    return rows;
}

async function getByIdScoped(companyId, id, client = null) {
    const query = queryFor(client);
    const { rows } = await query(
        `SELECT ${COLUMNS} FROM document_templates
         WHERE id = $1 AND company_id = $2`,
        [id, companyId],
    );
    return rows[0] || null;
}

async function getDefaultByType(companyId, documentType, client = null) {
    const query = queryFor(client);
    const { rows } = await query(
        `SELECT ${COLUMNS} FROM document_templates
         WHERE company_id = $1
           AND document_type = $2
           AND is_default = true
           AND archived_at IS NULL
         LIMIT 1`,
        [companyId, documentType],
    );
    return rows[0] || null;
}

async function updateContentScoped(companyId, id, { name = null, content = null, updatedBy = null }, client = null) {
    const query = queryFor(client);
    const fields = [];
    const params = [];
    if (name !== null) {
        params.push(name);
        fields.push(`name = $${params.length}`);
    }
    if (content !== null) {
        params.push(content);
        fields.push(`content = $${params.length}::jsonb`);
    }
    if (updatedBy) {
        params.push(updatedBy);
        fields.push(`updated_by = $${params.length}`);
    }
    fields.push(`updated_at = NOW()`);
    params.push(id, companyId);
    const sql = `UPDATE document_templates
                 SET ${fields.join(', ')}
                 WHERE id = $${params.length - 1} AND company_id = $${params.length}
                 RETURNING ${COLUMNS}`;
    const { rows } = await query(sql, params);
    return rows[0] || null;
}

async function insertSeed(companyId, payload, client = null) {
    const query = queryFor(client);
    const {
        documentType,
        name,
        slug,
        isDefault,
        schemaVersion,
        content,
        createdBy = null,
    } = payload;
    const { rows } = await query(
        `INSERT INTO document_templates
            (company_id, document_type, name, slug, is_default, schema_version, content, created_by, updated_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $8)
         ON CONFLICT (company_id, document_type, slug) DO UPDATE
            SET content = EXCLUDED.content,
                updated_at = NOW(),
                updated_by = EXCLUDED.updated_by
         RETURNING ${COLUMNS}`,
        [companyId, documentType, name, slug, isDefault, schemaVersion, JSON.stringify(content), createdBy],
    );
    return rows[0];
}

module.exports = {
    listForCompany,
    getByIdScoped,
    getDefaultByType,
    updateContentScoped,
    insertSeed,
};
