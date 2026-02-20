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
    const zbData = row.zenbooker_data || {};
    return {
        id: row.id,
        full_name: row.full_name,
        first_name: row.first_name || null,
        last_name: row.last_name || null,
        company_name: row.company_name || null,
        phone_e164: row.phone_e164,
        secondary_phone: row.secondary_phone || null,
        secondary_phone_name: row.secondary_phone_name || null,
        email: row.email,
        notes: row.notes,
        zenbooker_customer_id: row.zenbooker_customer_id,
        zenbooker_sync_status: row.zenbooker_sync_status || 'not_linked',
        zenbooker_synced_at: row.zenbooker_synced_at || null,
        zenbooker_last_error: row.zenbooker_last_error || null,
        zenbooker_account_id: row.zenbooker_account_id || null,
        created_at: row.created_at,
        updated_at: row.updated_at,
        // Zenbooker-sourced data
        addresses: zbData.addresses || [],
        jobs: zbData.jobs || [],
        recurring_bookings: zbData.recurring_bookings || [],
        stripe_customer_id: zbData.stripe_customer_id || null,
        zenbooker_creation_date: zbData.creation_date || null,
        zenbooker_id: zbData.id || null,
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
            OR c.secondary_phone ILIKE $${paramIdx}
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
        ORDER BY c.id DESC
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
    const secondaryPhone = customer.secondary_phone || null;
    const secondaryPhoneName = customer.secondary_phone_name || null;
    const email = customer.email || null;
    const notes = customer.notes || null;
    // Store full Zenbooker payload for rich display
    const zbData = JSON.stringify(customer);

    const sql = `
        INSERT INTO contacts (full_name, phone_e164, secondary_phone, secondary_phone_name, email, notes, zenbooker_customer_id, zenbooker_data)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
        ON CONFLICT (zenbooker_customer_id) DO UPDATE SET
            full_name = COALESCE(EXCLUDED.full_name, contacts.full_name),
            phone_e164 = COALESCE(EXCLUDED.phone_e164, contacts.phone_e164),
            secondary_phone = COALESCE(EXCLUDED.secondary_phone, contacts.secondary_phone),
            secondary_phone_name = COALESCE(EXCLUDED.secondary_phone_name, contacts.secondary_phone_name),
            email = COALESCE(EXCLUDED.email, contacts.email),
            notes = COALESCE(EXCLUDED.notes, contacts.notes),
            zenbooker_data = EXCLUDED.zenbooker_data
        RETURNING *
    `;

    const { rows } = await db.query(sql, [fullName, phone, secondaryPhone, secondaryPhoneName, email, notes, customerId, zbData]);
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
