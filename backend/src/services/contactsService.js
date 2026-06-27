/**
 * Contacts Service
 * 
 * PostgreSQL CRUD for contacts.
 * Supports upsert from Zenbooker customer data.
 */

const db = require('../db/connection');
const { toE164 } = require('../utils/phoneUtils');

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
        structured_notes: row.structured_notes || [],
        company_id: row.company_id,
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
async function listContacts({ search, offset = 0, limit = 50, companyId, providerScope } = {}) {
    if (!companyId) {
        const err = new Error('Tenant context required');
        err.code = 'TENANT_CONTEXT_REQUIRED';
        err.httpStatus = 403;
        throw err;
    }
    const conditions = [];
    const params = [];
    let paramIdx = 0;

    paramIdx++;
    conditions.push(`c.company_id = $${paramIdx}`);
    params.push(companyId);

    // assigned_only providers see only contacts linked to their visible jobs (PF007)
    if (providerScope?.assignedOnly) {
        if (!providerScope.userId) {
            conditions.push('FALSE');
        } else {
            paramIdx++;
            conditions.push(`EXISTS (
                SELECT 1 FROM jobs pj
                WHERE pj.contact_id = c.id
                  AND pj.company_id = c.company_id
                  AND pj.assigned_provider_user_ids @> $${paramIdx}::jsonb
            )`);
            params.push(JSON.stringify([providerScope.userId]));
        }
    }

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
async function getContactById(id, companyId = null, providerScope = null) {
    const contact = await getById(id, companyId, providerScope);
    if (!contact) {
        const err = new Error('Contact not found');
        err.code = 'NOT_FOUND';
        err.httpStatus = 404;
        throw err;
    }
    return contact;
}

/**
 * Tenant-safe contact lookup. Returns null (never throws) when the contact
 * does not exist, belongs to another company, or is not visible under the
 * provider scope — callers translate null into 404 (PF007-HARDENING-001).
 */
async function getById(id, companyId = null, providerScope = null) {
    const conditions = ['c.id = $1'];
    const params = [id];
    if (companyId) {
        params.push(companyId);
        conditions.push(`c.company_id = $${params.length}`);
    }
    if (providerScope?.assignedOnly) {
        if (!providerScope.userId) return null;
        params.push(JSON.stringify([providerScope.userId]));
        conditions.push(`EXISTS (
            SELECT 1 FROM jobs pj
            WHERE pj.contact_id = c.id
              AND pj.company_id = c.company_id
              AND pj.assigned_provider_user_ids @> $${params.length}::jsonb
        )`);
    }
    const sql = `SELECT c.* FROM contacts c WHERE ${conditions.join(' AND ')}`;
    const { rows } = await db.query(sql, params);
    return rows.length ? rowToContact(rows[0]) : null;
}

// =============================================================================
// Get Contact Leads (leads linked by contact_id)
// =============================================================================
async function getContactLeads(contactId, companyId = null) {
    const conditions = ['l.contact_id = $1'];
    const params = [contactId];
    if (companyId) {
        params.push(companyId);
        conditions.push(`l.company_id = $${params.length}`);
    }
    const sql = `
        SELECT l.id, l.uuid, l.status, l.sub_status, l.first_name, l.last_name,
               l.phone, l.email, l.job_type, l.job_source, l.lead_notes,
               l.serial_id, l.created_at
        FROM leads l
        WHERE ${conditions.join(' AND ')}
        ORDER BY l.created_at DESC
    `;
    const { rows } = await db.query(sql, params);
    return rows;
}

// =============================================================================
// Contact emails (channel 'email'): primary contacts.email + contact_emails rows
// Used by the Pulse composer (EMAIL-TIMELINE-001) to offer ALL of a contact's
// addresses in the "To" dropdown. Returns string[]: primary email first, then
// additional emails ordered (is_primary, created_at), de-duplicated
// case-insensitively, [] when the contact has none.
// =============================================================================
async function getContactEmails(contactId, primaryEmail = null) {
    const out = [];
    const seen = new Set();
    const push = (e) => {
        const v = (e || '').trim();
        if (!v) return;
        const k = v.toLowerCase();
        if (seen.has(k)) return;
        seen.add(k);
        out.push(v);
    };
    push(primaryEmail);
    if (contactId) {
        const { rows } = await db.query(
            'SELECT email FROM contact_emails WHERE contact_id = $1 ORDER BY is_primary DESC, created_at',
            [contactId]
        );
        for (const r of rows) push(r.email);
    }
    return out;
}

// =============================================================================
// Upsert from Zenbooker customer data
// =============================================================================
async function upsertFromZenbooker(customer) {
    const customerId = String(customer.id);
    const fullName = [customer.first_name, customer.last_name].filter(Boolean).join(' ') || null;
    const phone = toE164(customer.phone) || customer.phone || null;
    const secondaryPhone = toE164(customer.secondary_phone) || customer.secondary_phone || null;
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
    getById,
    getContactLeads,
    getContactEmails,
    upsertFromZenbooker,
};
