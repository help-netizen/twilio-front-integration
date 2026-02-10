/**
 * Leads Service
 * 
 * Self-contained PostgreSQL CRUD for leads.
 * Replaces the Workiz proxy — stores everything locally.
 */

const db = require('../db/connection');

// =============================================================================
// UUID Generation (Workiz-style 6-char alphanumeric)
// =============================================================================
const UUID_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const UUID_LENGTH = 6;

function generateUUID() {
    let result = '';
    for (let i = 0; i < UUID_LENGTH; i++) {
        result += UUID_CHARS.charAt(Math.floor(Math.random() * UUID_CHARS.length));
    }
    return result;
}

async function generateUniqueUUID() {
    for (let attempt = 0; attempt < 10; attempt++) {
        const uuid = generateUUID();
        const { rows } = await db.query('SELECT 1 FROM leads WHERE uuid = $1', [uuid]);
        if (rows.length === 0) return uuid;
    }
    throw new LeadsServiceError('UUID_GENERATION_FAILED', 'Could not generate unique UUID after 10 attempts', 500);
}

// =============================================================================
// Error class
// =============================================================================
class LeadsServiceError extends Error {
    constructor(code, message, httpStatus = 500) {
        super(message);
        this.name = 'LeadsServiceError';
        this.code = code;
        this.httpStatus = httpStatus;
    }
}

// =============================================================================
// DB row → Workiz-compatible Lead object (snake_case → PascalCase)
// =============================================================================
function rowToLead(row) {
    return {
        UUID: row.uuid,
        SerialId: row.serial_id,
        LeadDateTime: row.lead_date_time ? row.lead_date_time.toISOString() : null,
        LeadEndDateTime: row.lead_end_date_time ? row.lead_end_date_time.toISOString() : null,
        CreatedDate: row.created_at ? row.created_at.toISOString() : null,
        ClientId: row.id,
        Status: row.status,
        SubStatus: row.sub_status || null,
        LeadLost: row.lead_lost,
        PaymentDueDate: row.payment_due_date ? row.payment_due_date.toISOString() : null,

        Phone: row.phone || null,
        PhoneExt: row.phone_ext || null,
        SecondPhone: row.second_phone || null,
        SecondPhoneExt: row.second_phone_ext || null,
        Email: row.email || null,

        FirstName: row.first_name || null,
        LastName: row.last_name || null,
        Company: row.company || null,

        Address: row.address || null,
        Unit: row.unit || null,
        City: row.city || null,
        State: row.state || null,
        PostalCode: row.postal_code || null,
        Country: row.country || null,
        Latitude: row.latitude || null,
        Longitude: row.longitude || null,

        JobType: row.job_type || null,
        ReferralCompany: row.referral_company || null,
        Timezone: row.timezone || null,
        JobSource: row.job_source || null,
        LeadNotes: row.lead_notes || null,
        Comments: row.comments || null,

        Tags: row.tags || null,
        Team: row.team || null, // populated via JOIN
        WorkizLink: null, // no external link for self-hosted
    };
}

// =============================================================================
// PascalCase field → snake_case column mapping
// =============================================================================
const FIELD_MAP = {
    LeadDateTime: 'lead_date_time',
    LeadEndDateTime: 'lead_end_date_time',
    FirstName: 'first_name',
    LastName: 'last_name',
    Company: 'company',
    Phone: 'phone',
    PhoneExt: 'phone_ext',
    SecondPhone: 'second_phone',
    SecondPhoneExt: 'second_phone_ext',
    Email: 'email',
    Address: 'address',
    Unit: 'unit',
    City: 'city',
    State: 'state',
    PostalCode: 'postal_code',
    Country: 'country',
    Latitude: 'latitude',
    Longitude: 'longitude',
    JobType: 'job_type',
    JobSource: 'job_source',
    ReferralCompany: 'referral_company',
    Timezone: 'timezone',
    LeadNotes: 'lead_notes',
    Comments: 'comments',
    Tags: 'tags',
    Status: 'status',
    SubStatus: 'sub_status',
    PaymentDueDate: 'payment_due_date',
};

function mapFieldsToColumns(fields) {
    const columns = {};
    for (const [key, value] of Object.entries(fields)) {
        const col = FIELD_MAP[key];
        if (col) {
            columns[col] = value;
        }
    }
    return columns;
}

// =============================================================================
// List Leads
// =============================================================================
async function listLeads({ start_date, offset = 0, records = 100, only_open = true, status } = {}) {
    const conditions = [];
    const params = [];
    let paramIdx = 0;

    if (only_open) {
        conditions.push('l.lead_lost = false AND l.converted_to_job = false');
    }

    if (start_date) {
        paramIdx++;
        conditions.push(`l.created_at >= $${paramIdx}::date`);
        params.push(start_date);
    }

    if (status && status.length > 0) {
        paramIdx++;
        conditions.push(`l.status = ANY($${paramIdx}::text[])`);
        params.push(status);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    paramIdx++;
    const limitParam = paramIdx;
    params.push(Math.min(records, 100));

    paramIdx++;
    const offsetParam = paramIdx;
    params.push(offset);

    const sql = `
        SELECT l.*,
            COALESCE(
                json_agg(json_build_object('id', lta.id, 'name', lta.user_name))
                FILTER (WHERE lta.id IS NOT NULL), '[]'
            ) AS team
        FROM leads l
        LEFT JOIN lead_team_assignments lta ON lta.lead_id = l.id
        ${whereClause}
        GROUP BY l.id
        ORDER BY l.lead_date_time DESC NULLS LAST, l.created_at DESC
        LIMIT $${limitParam} OFFSET $${offsetParam}
    `;

    const { rows } = await db.query(sql, params);
    const results = rows.map(rowToLead);

    return {
        results,
        pagination: {
            offset,
            records,
            returned: results.length,
            has_more: results.length >= records,
        },
    };
}

// =============================================================================
// Get Lead by UUID
// =============================================================================
async function getLeadByUUID(uuid) {
    const sql = `
        SELECT l.*,
            COALESCE(
                json_agg(json_build_object('id', lta.id, 'name', lta.user_name))
                FILTER (WHERE lta.id IS NOT NULL), '[]'
            ) AS team
        FROM leads l
        LEFT JOIN lead_team_assignments lta ON lta.lead_id = l.id
        WHERE l.uuid = $1
        GROUP BY l.id
    `;

    const { rows } = await db.query(sql, [uuid]);
    if (rows.length === 0) {
        throw new LeadsServiceError('LEAD_NOT_FOUND', `Lead ${uuid} not found`, 404);
    }
    return rowToLead(rows[0]);
}

// =============================================================================
// Create Lead
// =============================================================================
async function createLead(fields) {
    const uuid = await generateUniqueUUID();
    const columns = mapFieldsToColumns(fields);

    // Always set uuid
    columns.uuid = uuid;

    const colNames = Object.keys(columns);
    const values = Object.values(columns);
    const placeholders = values.map((_, i) => `$${i + 1}`);

    const sql = `
        INSERT INTO leads (${colNames.join(', ')})
        VALUES (${placeholders.join(', ')})
        RETURNING uuid, serial_id, id
    `;

    const { rows } = await db.query(sql, values);
    return {
        UUID: rows[0].uuid,
        SerialId: rows[0].serial_id,
        ClientId: String(rows[0].id),
        link: null,
    };
}

// =============================================================================
// Update Lead
// =============================================================================
async function updateLead(uuid, fields) {
    const columns = mapFieldsToColumns(fields);

    if (Object.keys(columns).length === 0) {
        throw new LeadsServiceError('VALIDATION_ERROR', 'At least one field must be provided', 400);
    }

    const setClauses = [];
    const values = [];
    let idx = 0;

    for (const [col, val] of Object.entries(columns)) {
        idx++;
        setClauses.push(`${col} = $${idx}`);
        values.push(val);
    }

    idx++;
    values.push(uuid);

    const sql = `
        UPDATE leads SET ${setClauses.join(', ')}
        WHERE uuid = $${idx}
        RETURNING uuid, id
    `;

    const { rows } = await db.query(sql, values);
    if (rows.length === 0) {
        throw new LeadsServiceError('LEAD_NOT_FOUND', `Lead ${uuid} not found`, 404);
    }

    return {
        UUID: rows[0].uuid,
        ClientId: String(rows[0].id),
        link: null,
    };
}

// =============================================================================
// Mark Lost
// =============================================================================
async function markLost(uuid) {
    const sql = `
        UPDATE leads SET lead_lost = true, status = 'Lost'
        WHERE uuid = $1
        RETURNING uuid
    `;
    const { rows } = await db.query(sql, [uuid]);
    if (rows.length === 0) {
        throw new LeadsServiceError('LEAD_NOT_FOUND', `Lead ${uuid} not found`, 404);
    }
    return { message: 'Lead marked as lost' };
}

// =============================================================================
// Activate Lead
// =============================================================================
async function activateLead(uuid) {
    const sql = `
        UPDATE leads SET lead_lost = false, status = 'Submitted'
        WHERE uuid = $1
        RETURNING uuid
    `;
    const { rows } = await db.query(sql, [uuid]);
    if (rows.length === 0) {
        throw new LeadsServiceError('LEAD_NOT_FOUND', `Lead ${uuid} not found`, 404);
    }
    return { message: 'Lead activated' };
}

// =============================================================================
// Assign User
// =============================================================================
async function assignUser(uuid, userName) {
    // Get lead ID
    const { rows: leadRows } = await db.query('SELECT id FROM leads WHERE uuid = $1', [uuid]);
    if (leadRows.length === 0) {
        throw new LeadsServiceError('LEAD_NOT_FOUND', `Lead ${uuid} not found`, 404);
    }

    await db.query(
        'INSERT INTO lead_team_assignments (lead_id, user_name) VALUES ($1, $2) ON CONFLICT (lead_id, user_name) DO NOTHING',
        [leadRows[0].id, userName]
    );

    return {
        UUID: uuid,
        LeadId: String(leadRows[0].id),
        link: null,
    };
}

// =============================================================================
// Unassign User
// =============================================================================
async function unassignUser(uuid, userName) {
    const { rows: leadRows } = await db.query('SELECT id FROM leads WHERE uuid = $1', [uuid]);
    if (leadRows.length === 0) {
        throw new LeadsServiceError('LEAD_NOT_FOUND', `Lead ${uuid} not found`, 404);
    }

    await db.query(
        'DELETE FROM lead_team_assignments WHERE lead_id = $1 AND user_name = $2',
        [leadRows[0].id, userName]
    );

    return {
        UUID: uuid,
        LeadId: String(leadRows[0].id),
        link: null,
    };
}

// =============================================================================
// Convert Lead to Job
// =============================================================================
async function convertLead(uuid) {
    const sql = `
        UPDATE leads SET converted_to_job = true, status = 'Converted'
        WHERE uuid = $1
        RETURNING uuid, id
    `;
    const { rows } = await db.query(sql, [uuid]);
    if (rows.length === 0) {
        throw new LeadsServiceError('LEAD_NOT_FOUND', `Lead ${uuid} not found`, 404);
    }

    return {
        UUID: rows[0].uuid,
        ClientId: String(rows[0].id),
        link: null,
    };
}

// =============================================================================
// Exports
// =============================================================================
module.exports = {
    listLeads,
    getLeadByUUID,
    createLead,
    updateLead,
    markLost,
    activateLead,
    assignUser,
    unassignUser,
    convertLead,
    LeadsServiceError,
};
