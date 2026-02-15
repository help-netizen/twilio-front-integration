/**
 * Leads Service
 * 
 * Self-contained PostgreSQL CRUD for leads.
 * Replaces the Workiz proxy — stores everything locally.
 */

const db = require('../db/connection');
const zenbookerClient = require('./zenbookerClient');

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
        Description: row.lead_notes || null,
        Comments: row.comments || null,

        Tags: row.tags || null,
        Team: row.team || null, // populated via JOIN
        WorkizLink: null, // no external link for self-hosted
        Metadata: row.metadata || {},
        // Flatten custom metadata as top-level keys for API convenience
        ...(row.metadata || {}),
    };
}

// =============================================================================
// Extract custom metadata fields from flat request body
// Looks up registered api_names in lead_custom_fields, picks matching keys
// =============================================================================
async function extractCustomMetadata(fields) {
    const { rows: registeredFields } = await db.query(
        `SELECT api_name FROM lead_custom_fields WHERE is_system = false`
    );
    const apiNames = new Set(registeredFields.map(r => r.api_name));

    // Start with explicit Metadata object if provided
    const meta = (fields.Metadata && typeof fields.Metadata === 'object')
        ? { ...fields.Metadata }
        : {};

    // Pick flat top-level keys that match registered custom field api_names
    for (const key of Object.keys(fields)) {
        if (apiNames.has(key)) {
            meta[key] = String(fields[key]);
        }
    }

    return Object.keys(meta).length > 0 ? meta : null;
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
    Description: 'lead_notes',
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
async function listLeads({ start_date, offset = 0, records = 100, only_open = true, status, companyId } = {}) {
    const conditions = [];
    const params = [];
    let paramIdx = 0;

    if (companyId) {
        paramIdx++;
        conditions.push(`l.company_id = $${paramIdx}`);
        params.push(companyId);
    }

    if (only_open) {
        conditions.push(`l.status NOT IN ('Lost', 'Converted')`);
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
        ORDER BY l.created_at DESC
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
async function getLeadByUUID(uuid, companyId = null) {
    const conditions = ['l.uuid = $1'];
    const params = [uuid];
    if (companyId) {
        conditions.push(`l.company_id = $2`);
        params.push(companyId);
    }
    const sql = `
        SELECT l.*,
            COALESCE(
                json_agg(json_build_object('id', lta.id, 'name', lta.user_name))
                FILTER (WHERE lta.id IS NOT NULL), '[]'
            ) AS team
        FROM leads l
        LEFT JOIN lead_team_assignments lta ON lta.lead_id = l.id
        WHERE ${conditions.join(' AND ')}
        GROUP BY l.id
    `;

    const { rows } = await db.query(sql, params);
    if (rows.length === 0) {
        throw new LeadsServiceError('LEAD_NOT_FOUND', `Lead ${uuid} not found`, 404);
    }
    return rowToLead(rows[0]);
}

// =============================================================================
// Create Lead
// =============================================================================
async function createLead(fields, companyId = null) {
    const uuid = await generateUniqueUUID();
    const columns = mapFieldsToColumns(fields);

    // Always set uuid
    columns.uuid = uuid;

    // Set company_id if provided
    if (companyId) {
        columns.company_id = companyId;
    }

    // Handle custom metadata fields (flat api_name keys + Metadata object)
    const meta = await extractCustomMetadata(fields);
    if (meta) {
        columns.metadata = JSON.stringify(meta);
    }

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
async function updateLead(uuid, fields, companyId = null) {
    const columns = mapFieldsToColumns(fields);

    // Handle custom metadata fields (flat api_name keys + Metadata object)
    // For updates, merge with existing metadata to avoid overwriting unset fields
    const meta = await extractCustomMetadata(fields);
    if (meta) {
        // Merge with existing metadata
        const { rows: existing } = await db.query(
            'SELECT metadata FROM leads WHERE uuid = $1', [uuid]
        );
        const existingMeta = existing.length > 0 ? (existing[0].metadata || {}) : {};
        columns.metadata = JSON.stringify({ ...existingMeta, ...meta });
    }

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
    const conditions = [`uuid = $${idx}`];

    if (companyId) {
        idx++;
        conditions.push(`company_id = $${idx}`);
        values.push(companyId);
    }

    const sql = `
        UPDATE leads SET ${setClauses.join(', ')}
        WHERE ${conditions.join(' AND ')}
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
async function markLost(uuid, companyId = null) {
    const conditions = ['uuid = $1'];
    const params = [uuid];
    if (companyId) {
        conditions.push(`company_id = $2`);
        params.push(companyId);
    }
    const sql = `
        UPDATE leads SET lead_lost = true, status = 'Lost'
        WHERE ${conditions.join(' AND ')}
        RETURNING uuid
    `;
    const { rows } = await db.query(sql, params);
    if (rows.length === 0) {
        throw new LeadsServiceError('LEAD_NOT_FOUND', `Lead ${uuid} not found`, 404);
    }
    return { message: 'Lead marked as lost' };
}

// =============================================================================
// Activate Lead
// =============================================================================
async function activateLead(uuid, companyId = null) {
    const conditions = ['uuid = $1'];
    const params = [uuid];
    if (companyId) {
        conditions.push(`company_id = $2`);
        params.push(companyId);
    }
    const sql = `
        UPDATE leads SET lead_lost = false, status = 'Submitted'
        WHERE ${conditions.join(' AND ')}
        RETURNING uuid
    `;
    const { rows } = await db.query(sql, params);
    if (rows.length === 0) {
        throw new LeadsServiceError('LEAD_NOT_FOUND', `Lead ${uuid} not found`, 404);
    }
    return { message: 'Lead activated' };
}

// =============================================================================
// Assign User
// =============================================================================
async function assignUser(uuid, userName, companyId = null) {
    // Get lead ID
    const conditions = ['uuid = $1'];
    const params = [uuid];
    if (companyId) {
        conditions.push(`company_id = $2`);
        params.push(companyId);
    }
    const { rows: leadRows } = await db.query(
        `SELECT id FROM leads WHERE ${conditions.join(' AND ')}`, params
    );
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
async function unassignUser(uuid, userName, companyId = null) {
    const conditions = ['uuid = $1'];
    const params = [uuid];
    if (companyId) {
        conditions.push(`company_id = $2`);
        params.push(companyId);
    }
    const { rows: leadRows } = await db.query(
        `SELECT id FROM leads WHERE ${conditions.join(' AND ')}`, params
    );
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
async function convertLead(uuid, overrides = {}, companyId = null) {
    // 1. Fetch full lead to get address/contact info for Zenbooker
    const conditions = ['uuid = $1'];
    const params = [uuid];
    if (companyId) {
        conditions.push(`company_id = $2`);
        params.push(companyId);
    }
    const { rows: leadRows } = await db.query(
        `SELECT * FROM leads WHERE ${conditions.join(' AND ')}`, params
    );
    if (leadRows.length === 0) {
        throw new LeadsServiceError('LEAD_NOT_FOUND', `Lead ${uuid} not found`, 404);
    }
    const lead = rowToLead(leadRows[0]);

    // 2. Create job in Zenbooker (or use pre-created job_id from booking dialog)
    let zenbookerJobId = overrides.zenbooker_job_id || null;

    if (!zenbookerJobId) {
        // No pre-created job — call Zenbooker auto-create
        try {
            const zbResult = await zenbookerClient.createJobFromLead(lead);
            zenbookerJobId = zbResult.job_id;
            console.log(`[ConvertLead] Zenbooker job created: ${zenbookerJobId}`);
        } catch (err) {
            // If Zenbooker API key not configured, skip silently
            if (err.message === 'ZENBOOKER_API_KEY is not configured') {
                console.warn('[ConvertLead] Zenbooker not configured, skipping job creation');
            } else {
                console.error('[ConvertLead] Zenbooker error:', err.response?.data || err.message);
                throw new LeadsServiceError(
                    'ZENBOOKER_ERROR',
                    `Failed to create Zenbooker job: ${err.response?.data?.error?.message || err.message}`,
                    502
                );
            }
        }
    } else {
        console.log(`[ConvertLead] Using pre-created Zenbooker job: ${zenbookerJobId}`);
    }

    // 3. Mark lead as converted and save Zenbooker job ID
    const updateConditions = ['uuid = $1'];
    const updateParams = [uuid, zenbookerJobId];
    if (companyId) {
        updateConditions.push(`company_id = $3`);
        updateParams.push(companyId);
    }
    const updateSql = `
        UPDATE leads
        SET converted_to_job = true, status = 'Converted',
            zenbooker_job_id = COALESCE($2, zenbooker_job_id)
        WHERE ${updateConditions.join(' AND ')}
        RETURNING uuid, id
    `;
    const { rows } = await db.query(updateSql, updateParams);

    return {
        UUID: rows[0].uuid,
        ClientId: String(rows[0].id),
        zenbooker_job_id: zenbookerJobId,
        link: null,
    };
}

// =============================================================================
// Get Lead by Phone (newest match)
// =============================================================================
async function getLeadByPhone(phone, companyId = null) {
    // Normalize: strip everything except digits, keep last 10 for US numbers
    const digits = (phone || '').replace(/\D/g, '');
    const last10 = digits.length >= 10 ? digits.slice(-10) : digits;
    if (!last10) return null;

    const conditions = [`RIGHT(REGEXP_REPLACE(l.phone, '[^0-9]', '', 'g'), 10) = $1`];
    const params = [last10];
    if (companyId) {
        conditions.push(`l.company_id = $2`);
        params.push(companyId);
    }

    const sql = `
        SELECT l.*,
            COALESCE(
                json_agg(json_build_object('id', lta.id, 'name', lta.user_name))
                FILTER (WHERE lta.id IS NOT NULL), '[]'
            ) AS team
        FROM leads l
        LEFT JOIN lead_team_assignments lta ON lta.lead_id = l.id
        WHERE ${conditions.join(' AND ')}
        GROUP BY l.id
        ORDER BY l.id DESC
        LIMIT 1
    `;

    const { rows } = await db.query(sql, params);
    return rows.length > 0 ? rowToLead(rows[0]) : null;
}

// =============================================================================
// Exports
// =============================================================================
module.exports = {
    listLeads,
    getLeadByUUID,
    getLeadByPhone,
    createLead,
    updateLead,
    markLost,
    activateLead,
    assignUser,
    unassignUser,
    convertLead,
    LeadsServiceError,
};
