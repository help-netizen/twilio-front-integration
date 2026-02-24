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
        SecondPhoneName: row.second_phone_name || null,
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
        ContactId: row.contact_id || null,
        ContactName: row.contact_name || null,
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
    SecondPhoneName: 'second_phone_name',
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
    contact_id: 'contact_id',
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
        SELECT l.*, c.full_name AS contact_name,
            COALESCE(
                json_agg(json_build_object('id', lta.id, 'name', lta.user_name))
                FILTER (WHERE lta.id IS NOT NULL), '[]'
            ) AS team
        FROM leads l
        LEFT JOIN lead_team_assignments lta ON lta.lead_id = l.id
        LEFT JOIN contacts c ON c.id = l.contact_id
        ${whereClause}
        GROUP BY l.id, c.full_name
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
// Get Lead by numeric ID
// =============================================================================
async function getLeadById(id, companyId = null) {
    const conditions = ['l.id = $1'];
    const params = [id];
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
        throw new LeadsServiceError('LEAD_NOT_FOUND', `Lead #${id} not found`, 404);
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

    // Normalize phone to E.164 format (+1XXXXXXXXXX for US)
    if (columns.phone) {
        const digits = columns.phone.replace(/\D/g, '');
        if (digits.length === 10) {
            columns.phone = '+1' + digits;
        } else if (digits.length === 11 && digits.startsWith('1')) {
            columns.phone = '+' + digits;
        } else if (digits.length > 10 && !columns.phone.startsWith('+')) {
            columns.phone = '+' + digits;
        }
    }

    // Normalize names to Title Case (e.g. "JOHN" → "John", "doe" → "Doe")
    const toTitleCase = (s) => s ? s.replace(/\S+/g, w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()) : s;
    if (columns.first_name) columns.first_name = toTitleCase(columns.first_name);
    if (columns.last_name) columns.last_name = toTitleCase(columns.last_name);

    // Always set company_id (fallback to default)
    const DEFAULT_COMPANY_ID = '00000000-0000-0000-0000-000000000001';
    columns.company_id = companyId || DEFAULT_COMPANY_ID;

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
    // 1. Fetch full lead
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
    const leadRow = leadRows[0];

    // 2. Create local job row in Blanc
    const serviceName = overrides.service?.name || lead.JobType || 'General Service';
    const address = overrides.address
        ? [overrides.address.line1, overrides.address.line2, overrides.address.city, overrides.address.state, overrides.address.postal_code].filter(Boolean).join(', ')
        : [leadRow.address, leadRow.unit, leadRow.city, leadRow.state, leadRow.postal_code].filter(Boolean).join(', ');
    const customerName = overrides.customer?.name || [leadRow.first_name, leadRow.last_name].filter(Boolean).join(' ') || null;
    const customerPhone = overrides.customer?.phone || leadRow.phone || null;
    const customerEmail = overrides.customer?.email || leadRow.email || null;

    const { rows: [jobRow] } = await db.query(`
        INSERT INTO jobs (
            lead_id, contact_id, blanc_status, service_name, address,
            customer_name, customer_phone, customer_email, company_id,
            job_type, job_source, description, metadata, comments
        ) VALUES ($1, $2, 'Submitted', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
        RETURNING id
    `, [
        leadRow.id,
        leadRow.contact_id || null,
        serviceName,
        address,
        customerName,
        customerPhone,
        customerEmail,
        leadRow.company_id || null,
        leadRow.job_type || serviceName,
        leadRow.job_source || null,
        overrides.service?.description || leadRow.lead_notes || leadRow.comments || null,
        leadRow.metadata || '{}',
        leadRow.comments || null,
    ]);
    const localJobId = jobRow.id;
    console.log(`[ConvertLead] Local job created: ${localJobId}`);

    // 3. Create Zenbooker job (if booking data provided or auto-create)
    let zenbookerJobId = overrides.zenbooker_job_id || null;

    if (!zenbookerJobId && overrides.zb_job_payload) {
        // Frontend sent full booking payload — create ZB job directly
        try {
            const zbResult = await zenbookerClient.createJob(overrides.zb_job_payload);
            zenbookerJobId = zbResult.job_id;
            console.log(`[ConvertLead] Zenbooker job created from booking: ${zenbookerJobId}`);
        } catch (err) {
            console.error('[ConvertLead] Zenbooker booking error:', err.response?.data || err.message);
            // Don't fail — local job is already created
        }
    } else if (!zenbookerJobId) {
        // No booking data — try auto-create from lead
        try {
            const zbResult = await zenbookerClient.createJobFromLead(lead);
            zenbookerJobId = zbResult.job_id;
            console.log(`[ConvertLead] Zenbooker job created: ${zenbookerJobId}`);
        } catch (err) {
            if (err.message === 'ZENBOOKER_API_KEY is not configured') {
                console.warn('[ConvertLead] Zenbooker not configured, skipping');
            } else {
                console.error('[ConvertLead] Zenbooker error:', err.response?.data || err.message);
                // Don't fail — local job is already created
            }
        }
    } else {
        console.log(`[ConvertLead] Using pre-created Zenbooker job: ${zenbookerJobId}`);
    }

    // 4. Update local job with ZB data and link contact
    if (zenbookerJobId) {
        try {
            const jobDetail = await zenbookerClient.getJob(zenbookerJobId);
            console.log(`[ConvertLead] Fetched ZB job detail for sync:`, jobDetail?.job_number, jobDetail?.start_date);

            // Sync ALL ZB fields back into local job (schedule, territory, techs, invoice, etc.)
            await db.query(`
                UPDATE jobs SET
                    zenbooker_job_id = $1,
                    job_number = COALESCE($3, job_number),
                    start_date = COALESCE($4, start_date),
                    end_date = COALESCE($5, end_date),
                    territory = COALESCE($6, territory),
                    assigned_techs = COALESCE($7::jsonb, assigned_techs),
                    notes = COALESCE($8::jsonb, notes),
                    invoice_total = COALESCE($9, invoice_total),
                    invoice_status = COALESCE($10, invoice_status),
                    zb_status = COALESCE($11, zb_status),
                    zb_canceled = COALESCE($12, zb_canceled),
                    zb_rescheduled = COALESCE($13, zb_rescheduled),
                    zb_raw = $14::jsonb,
                    updated_at = NOW()
                WHERE id = $2
            `, [
                zenbookerJobId,
                localJobId,
                jobDetail?.job_number || null,
                jobDetail?.start_date || null,
                jobDetail?.end_date || null,
                jobDetail?.territory?.name || null,
                JSON.stringify(jobDetail?.assigned_providers || []),
                JSON.stringify(jobDetail?.notes || []),
                jobDetail?.invoice?.total || null,
                jobDetail?.invoice?.status || null,
                jobDetail?.status || 'scheduled',
                !!jobDetail?.canceled,
                !!jobDetail?.rescheduled,
                JSON.stringify(jobDetail || {}),
            ]);

            // Link ZB customer to Blanc contact
            if (leadRow.contact_id) {
                const zbCustomerId = jobDetail?.customer?.id;
                if (zbCustomerId) {
                    await db.query(
                        `UPDATE contacts
                         SET zenbooker_customer_id = COALESCE(NULLIF(zenbooker_customer_id, ''), $1),
                             zenbooker_data = COALESCE(zenbooker_data, '{}'::jsonb) || jsonb_build_object('id', $1::text),
                             zenbooker_sync_status = 'linked',
                             zenbooker_synced_at = NOW()
                         WHERE id = $2`,
                        [zbCustomerId, leadRow.contact_id]
                    );
                    console.log(`[ConvertLead] Linked contact ${leadRow.contact_id} to ZB customer ${zbCustomerId}`);
                }
            }
        } catch (syncErr) {
            // Fallback: at minimum save the zenbooker_job_id
            console.warn(`[ConvertLead] Could not sync ZB job detail:`, syncErr.message);
            await db.query(
                `UPDATE jobs SET zenbooker_job_id = $1 WHERE id = $2`,
                [zenbookerJobId, localJobId]
            );
        }
    }

    // 5. Mark lead as converted + sync overridden fields back to lead
    const setClauses = [
        'converted_to_job = true',
        'status = $2',
        'zenbooker_job_id = COALESCE($3, zenbooker_job_id)',
    ];
    const updateParams = [uuid, 'Converted', zenbookerJobId];
    let pIdx = 3;

    // Sync back job type if changed in wizard
    if (overrides.service?.name && overrides.service.name !== leadRow.job_type) {
        pIdx++; setClauses.push(`job_type = $${pIdx}`); updateParams.push(overrides.service.name);
    }
    // Sync back description if changed
    if (overrides.service?.description && overrides.service.description !== (leadRow.lead_notes || '')) {
        pIdx++; setClauses.push(`lead_notes = $${pIdx}`); updateParams.push(overrides.service.description);
    }
    // Sync back address if overridden
    if (overrides.address) {
        if (overrides.address.line1 != null) { pIdx++; setClauses.push(`address = $${pIdx}`); updateParams.push(overrides.address.line1); }
        if (overrides.address.line2 != null) { pIdx++; setClauses.push(`unit = $${pIdx}`); updateParams.push(overrides.address.line2); }
        if (overrides.address.city != null) { pIdx++; setClauses.push(`city = $${pIdx}`); updateParams.push(overrides.address.city); }
        if (overrides.address.state != null) { pIdx++; setClauses.push(`state = $${pIdx}`); updateParams.push(overrides.address.state); }
        if (overrides.address.postal_code != null) { pIdx++; setClauses.push(`postal_code = $${pIdx}`); updateParams.push(overrides.address.postal_code); }
    }
    // Sync back customer fields if overridden
    if (overrides.customer?.phone && overrides.customer.phone !== leadRow.phone) {
        pIdx++; setClauses.push(`phone = $${pIdx}`); updateParams.push(overrides.customer.phone);
    }
    if (overrides.customer?.email && overrides.customer.email !== leadRow.email) {
        pIdx++; setClauses.push(`email = $${pIdx}`); updateParams.push(overrides.customer.email);
    }

    const updateConditions = ['uuid = $1'];
    if (companyId) {
        pIdx++; updateConditions.push(`company_id = $${pIdx}`); updateParams.push(companyId);
    }
    await db.query(`
        UPDATE leads SET ${setClauses.join(', ')}
        WHERE ${updateConditions.join(' AND ')}
    `, updateParams);

    // 6. Add lead comments/description as job notes (syncs to Zenbooker)
    try {
        const jobsService = require('./jobsService');
        const commentText = leadRow.comments?.trim();
        const descriptionText = (overrides.service?.description || leadRow.lead_notes || '')?.trim();

        // Add description as note if present
        if (descriptionText) {
            await jobsService.addNote(localJobId, `[Lead Description] ${descriptionText}`);
            console.log(`[ConvertLead] Added description as note to job ${localJobId}`);
        }
        // Add comments as note if present and different from description
        if (commentText && commentText !== descriptionText) {
            await jobsService.addNote(localJobId, `[Lead Comment] ${commentText}`);
            console.log(`[ConvertLead] Added comments as note to job ${localJobId}`);
        }
    } catch (noteErr) {
        console.error(`[ConvertLead] Note sync error (non-blocking):`, noteErr.message);
    }

    return {
        UUID: lead.UUID,
        ClientId: String(leadRow.id),
        job_id: localJobId,
        zenbooker_job_id: zenbookerJobId,
        link: `/jobs/${localJobId}`,
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

    const conditions = [
        `RIGHT(REGEXP_REPLACE(l.phone, '[^0-9]', '', 'g'), 10) = $1`,
        `l.status NOT IN ('Lost', 'Converted')`,
    ];
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
    getLeadById,
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
