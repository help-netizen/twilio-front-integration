/**
 * Contacts Service
 * 
 * PostgreSQL CRUD for contacts.
 * Supports upsert from Zenbooker customer data.
 */

const db = require('../db/connection');

// =============================================================================
// DB row → Contact object
// =============================================================================
function rowToContact(row) {
    if (!row) return null;
    return {
        id: row.id,
        full_name: row.full_name,
        phone_e164: row.phone_e164,
        email: row.email,
        notes: row.notes,
        zenbooker_customer_id: row.zenbooker_customer_id,
        created_at: row.created_at,
        updated_at: row.updated_at,
    };
}

// =============================================================================
// List Contacts
// =============================================================================
async function listContacts({ search, offset = 0, limit = 50 } = {}) {
    const conditions = [];
    const params = [];
    let paramIdx = 0;

    if (search && search.trim()) {
        paramIdx++;
        const searchPattern = `%${search.trim()}%`;
        conditions.push(`(
            c.full_name ILIKE $${paramIdx}
            OR c.phone_e164 ILIKE $${paramIdx}
            OR c.email ILIKE $${paramIdx}
        )`);
        params.push(searchPattern);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    paramIdx++;
    const limitParam = paramIdx;
    params.push(Math.min(limit, 100));

    paramIdx++;
    const offsetParam = paramIdx;
    params.push(offset);

    const sql = `
        SELECT c.*
        FROM contacts c
        ${whereClause}
        ORDER BY c.created_at DESC
        LIMIT $${limitParam} OFFSET $${offsetParam}
    `;

    const { rows } = await db.query(sql, params);
    const results = rows.map(rowToContact);

    return {
        results,
        pagination: {
            offset,
            limit,
            returned: results.length,
            has_more: results.length >= limit,
        },
    };
}

// =============================================================================
// Get Contact by ID
// =============================================================================
async function getContactById(id) {
    const sql = `SELECT c.* FROM contacts c WHERE c.id = $1`;
    const { rows } = await db.query(sql, [id]);
    if (rows.length === 0) {
        const err = new Error('Contact not found');
        err.code = 'NOT_FOUND';
        err.httpStatus = 404;
        throw err;
    }
    return rowToContact(rows[0]);
}

// =============================================================================
// Get Contact Leads (leads linked by contact_id)
// =============================================================================
async function getContactLeads(contactId) {
    const sql = `
        SELECT l.id, l.uuid, l.status, l.sub_status, l.first_name, l.last_name,
               l.phone, l.email, l.job_type, l.job_source, l.lead_notes,
               l.serial_id, l.created_at
        FROM leads l
        WHERE l.contact_id = $1
        ORDER BY l.created_at DESC
    `;
    const { rows } = await db.query(sql, [contactId]);
    return rows;
}

// =============================================================================
// Upsert from Zenbooker customer data
// =============================================================================
async function upsertFromZenbooker(customer) {
    const customerId = String(customer.id);
    const fullName = [customer.first_name, customer.last_name].filter(Boolean).join(' ') || null;
    const phone = customer.phone || null;
    const email = customer.email || null;
    const notes = customer.notes || null;

    const sql = `
        INSERT INTO contacts (full_name, phone_e164, email, notes, zenbooker_customer_id)
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (zenbooker_customer_id) DO UPDATE SET
            full_name = COALESCE(EXCLUDED.full_name, contacts.full_name),
            phone_e164 = COALESCE(EXCLUDED.phone_e164, contacts.phone_e164),
            email = COALESCE(EXCLUDED.email, contacts.email),
            notes = COALESCE(EXCLUDED.notes, contacts.notes)
        RETURNING *
    `;

    const { rows } = await db.query(sql, [fullName, phone, email, notes, customerId]);
    return rowToContact(rows[0]);
}

// =============================================================================
// Exports
// =============================================================================
module.exports = {
    listContacts,
    getContactById,
    getContactLeads,
    upsertFromZenbooker,
};
