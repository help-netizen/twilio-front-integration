/**
 * Leads Service
 * 
 * Self-contained PostgreSQL CRUD for leads.
 * Replaces the Workiz proxy — stores everything locally.
 */

const db = require('../db/connection');
const fsmService = require('./fsmService');
const eventBus = require('./eventBus');
const { convertLeadWithJob } = require('./leadConversionService');
const {
    logLeadContactActivity,
    systemActor,
} = require('./leadContactActivityService');
const { withTransaction } = require('./transactionService');
const {
    createCursorFingerprint,
    encodeCursor,
    decodeCursor,
    assertCursorOffsetExclusive,
    buildKeysetPredicate,
    timestampCursorExpression,
    bigintCursorExpression,
} = require('../utils/listCursor');

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

async function generateUniqueUUID(client = db) {
    for (let attempt = 0; attempt < 10; attempt++) {
        const uuid = generateUUID();
        const { rows } = await client.query('SELECT 1 FROM leads WHERE uuid = $1', [uuid]);
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

function domainActor(activityActor, fallbackType = 'system') {
    return {
        actorType: activityActor?.type || fallbackType,
        actorId: activityActor?.type === 'user' ? activityActor.id || null : null,
    };
}

async function resolveActiveAssigneeUserId(client, companyId, identity) {
    const value = String(identity || '').trim();
    if (!value) return null;
    const { rows } = await client.query(
        `SELECT u.id
         FROM company_memberships m
         JOIN crm_users u
           ON u.id = m.user_id
          AND u.status = 'active'
          AND u.onboarding_status = 'active'
          AND COALESCE(u.kind, 'user') = 'user'
         WHERE m.company_id = $1
           AND m.status = 'active'
           AND (
                u.id::text = $2
                OR lower(u.full_name) = lower($2)
                OR lower(u.email) = lower($2)
           )
         ORDER BY u.id
         LIMIT 2`,
        [companyId, value]
    );
    return rows.length === 1 ? String(rows[0].id) : null;
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
        gclid: row.gclid || null,

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

        structured_notes: row.structured_notes || [],
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
const RESERVED_METADATA_KEYS = ['rely_filter'];

async function extractCustomMetadata(fields, client = db) {
    const { rows: registeredFields } = await client.query(
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

    // RELY-LEADS-SETTINGS-001: server-owned metadata namespaces cannot be set
    // through either an external Metadata object or a registered flat api_name.
    for (const key of RESERVED_METADATA_KEYS) delete meta[key];

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
    gclid: 'gclid',
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
const LEAD_LIST_SORTS = Object.freeze({
    Status: { expression: `LOWER(COALESCE(l.status, '')) COLLATE "C"`, type: 'text' },
    FirstName: { expression: `LOWER(COALESCE(l.first_name, '')) COLLATE "C"`, type: 'text' },
    Phone: { expression: `LOWER(COALESCE(l.phone, '')) COLLATE "C"`, type: 'text' },
    Email: { expression: `LOWER(COALESCE(l.email, '')) COLLATE "C"`, type: 'text' },
    City: { expression: `LOWER(COALESCE(l.city, '')) COLLATE "C"`, type: 'text' },
    JobType: { expression: `LOWER(COALESCE(l.job_type, '')) COLLATE "C"`, type: 'text' },
    JobSource: { expression: `LOWER(COALESCE(l.job_source, '')) COLLATE "C"`, type: 'text' },
    CreatedDate: {
        expression: 'l.created_at',
        projection: timestampCursorExpression('l.created_at'),
        type: 'timestamp',
    },
    SerialId: { expression: 'l.serial_id', projection: bigintCursorExpression('l.serial_id'), type: 'bigint' },
});

function normalizeListValues(values) {
    if (!Array.isArray(values)) return [];
    return [...new Set(values.map(value => String(value).trim()).filter(Boolean))].sort();
}

async function listLeads({
    start_date,
    end_date,
    offset,
    records,
    limit,
    cursor,
    only_open = true,
    status,
    search,
    source,
    job_type,
    rejected_only = false,
    sort_by = 'CreatedDate',
    sort_order = 'desc',
    companyId,
} = {}) {
    if (!companyId) {
        throw new LeadsServiceError('TENANT_CONTEXT_REQUIRED', 'Company context is required', 403);
    }

    const requestedLimit = limit ?? records ?? 100;
    if (!Number.isInteger(Number(requestedLimit)) || Number(requestedLimit) < 1 || Number(requestedLimit) > 100) {
        throw new LeadsServiceError('INVALID_QUERY', 'limit must be an integer from 1 to 100', 400);
    }
    const pageLimit = Number(requestedLimit);
    if (offset !== undefined && (!Number.isInteger(Number(offset)) || Number(offset) < 0)) {
        throw new LeadsServiceError('INVALID_QUERY', 'offset must be a non-negative integer', 400);
    }
    assertCursorOffsetExclusive(cursor, offset);

    const sort = LEAD_LIST_SORTS[sort_by];
    if (!sort || (sort_order !== 'asc' && sort_order !== 'desc')) {
        throw new LeadsServiceError('INVALID_QUERY', 'Invalid lead sort', 400);
    }

    const normalizedStatus = normalizeListValues(status);
    const normalizedSources = normalizeListValues(source);
    const normalizedJobTypes = normalizeListValues(job_type);
    const normalizedSearch = typeof search === 'string' ? search.trim() : '';
    const mode = offset === undefined ? 'cursor' : 'offset';
    const fingerprint = createCursorFingerprint({
        endpoint: 'leads',
        company: String(companyId),
        visibility: 'company',
        filters: {
            start_date: start_date || null,
            end_date: end_date || null,
            only_open: Boolean(only_open),
            status: normalizedStatus,
            search: normalizedSearch.toLocaleLowerCase('en-US'),
            source: normalizedSources,
            job_type: normalizedJobTypes,
            rejected_only: Boolean(rejected_only),
        },
        sort: sort_by,
        direction: sort_order,
        limit: pageLimit,
    });
    const cursorExpectation = {
        endpoint: 'leads',
        sort: sort_by,
        direction: sort_order,
        fingerprint,
        valueTypes: [sort.type, 'bigint'],
    };
    const decodedCursor = cursor ? decodeCursor(cursor, cursorExpectation) : null;

    const conditions = [];
    const params = [];
    conditions.push('l.company_id = $1');
    params.push(companyId);

    if (only_open) {
        conditions.push(`l.status NOT IN ('Lost', 'Converted')`);
    }

    if (start_date) {
        conditions.push(`l.created_at >= $${params.length + 1}::date`);
        params.push(start_date);
    }

    if (end_date) {
        conditions.push(`l.created_at < ($${params.length + 1}::date + interval '1 day')`);
        params.push(end_date);
    }

    if (normalizedStatus.length > 0) {
        conditions.push(`l.status = ANY($${params.length + 1}::text[])`);
        params.push(normalizedStatus);
    }

    if (normalizedSearch) {
        const searchParam = `$${params.length + 1}`;
        conditions.push(`(
            CONCAT_WS(' ', l.first_name, l.last_name) ILIKE ${searchParam}
            OR l.company ILIKE ${searchParam}
            OR l.phone ILIKE ${searchParam}
            OR l.email ILIKE ${searchParam}
            OR l.serial_id::text ILIKE ${searchParam}
            OR EXISTS (
                SELECT 1
                FROM lead_custom_fields lcf
                WHERE lcf.company_id = l.company_id
                  AND lcf.is_searchable = true
                  AND lcf.is_system = false
                  AND COALESCE(l.metadata ->> lcf.api_name, '') ILIKE ${searchParam}
            )
        )`);
        params.push(`%${normalizedSearch}%`);
    }

    if (normalizedSources.length > 0) {
        conditions.push(`l.job_source = ANY($${params.length + 1}::text[])`);
        params.push(normalizedSources);
    }

    if (normalizedJobTypes.length > 0) {
        conditions.push(`l.job_type = ANY($${params.length + 1}::text[])`);
        params.push(normalizedJobTypes);
    }

    if (rejected_only) {
        conditions.push(`l.metadata @> '{"rely_filter":{"rejected":true}}'::jsonb`);
    }

    const whereClause = `WHERE ${conditions.join(' AND ')}`;
    let total = null;
    if (!decodedCursor) {
        const countResult = await db.query(
            `SELECT COUNT(*)::int AS total FROM leads l ${whereClause}`,
            params,
        );
        total = countResult.rows[0]?.total ?? 0;
    }

    const pageParams = params.slice();
    let cursorPredicate = '';
    if (decodedCursor) {
        const keyset = buildKeysetPredicate([
            { expression: sort.expression, direction: sort_order, type: sort.type },
            { expression: 'l.id', direction: sort_order, type: 'bigint' },
        ], decodedCursor.values, pageParams.length + 1);
        cursorPredicate = ` AND ${keyset.sql}`;
        pageParams.push(...keyset.params);
    }

    const limitParam = pageParams.length + 1;
    pageParams.push(pageLimit + 1);
    let offsetSql = '';
    if (mode === 'offset') {
        const offsetParam = pageParams.length + 1;
        pageParams.push(Number(offset));
        offsetSql = ` OFFSET $${offsetParam}`;
    }

    const sql = `
        SELECT l.*, c.full_name AS contact_name,
            ${sort.projection || sort.expression} AS __cursor_value,
            ${bigintCursorExpression('l.id')} AS __cursor_id
        FROM leads l
        LEFT JOIN contacts c ON c.id = l.contact_id AND c.company_id = l.company_id
        ${whereClause}${cursorPredicate}
        ORDER BY ${sort.expression} ${sort_order.toUpperCase()}, l.id ${sort_order.toUpperCase()}
        LIMIT $${limitParam}${offsetSql}
    `;

    const { rows: probedRows } = await db.query(sql, pageParams);
    const pageRows = probedRows.slice(0, pageLimit);
    const hasMore = probedRows.length > pageLimit;

    let teamsByLeadId = new Map();
    if (pageRows.length > 0) {
        const pageIds = pageRows.map(row => String(row.id));
        const teamResult = await db.query(
            `SELECT lta.lead_id::text AS lead_id,
                json_agg(json_build_object('id', lta.id, 'name', lta.user_name) ORDER BY lta.id) AS team
             FROM lead_team_assignments lta
             WHERE lta.company_id = $1 AND lta.lead_id = ANY($2::bigint[])
             GROUP BY lta.lead_id`,
            [companyId, pageIds],
        );
        teamsByLeadId = new Map(teamResult.rows.map(row => [String(row.lead_id), row.team]));
    }

    const hydratedRows = pageRows.map(row => ({
        ...row,
        team: teamsByLeadId.get(String(row.id)) || row.team || [],
    }));
    const results = hydratedRows.map(rowToLead);
    const lastRow = pageRows.at(-1);
    const nextCursor = mode === 'cursor' && hasMore && lastRow
        ? encodeCursor({
            endpoint: 'leads',
            sort: sort_by,
            direction: sort_order,
            fingerprint,
            values: [String(lastRow.__cursor_value), String(lastRow.__cursor_id)],
        }, cursorExpectation)
        : null;

    return {
        results,
        pagination: {
            mode,
            offset: mode === 'offset' ? Number(offset) : 0,
            records: pageLimit,
            limit: pageLimit,
            returned: results.length,
            has_more: hasMore,
            next_cursor: nextCursor,
            total,
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
async function mutateLeadWithActivity(activityActor, work, buildActivities) {
    const actor = activityActor || systemActor('Albusto', 'crm');
    return withTransaction(async (client) => {
        const result = await work(client);
        const activities = buildActivities(result).filter(Boolean);
        for (const activity of activities) {
            await logLeadContactActivity({
                companyId: activity.companyId,
                entityType: 'lead',
                action: activity.action,
                entityId: activity.entityId,
                actor,
                ...(activity.summary ? { summary: activity.summary } : {}),
            }, { client });
        }
        return result;
    });
}

async function createLead(fields, companyId, {
    systemMetadata = null,
    activityActor = null,
} = {}) {
    if (!companyId) {
        throw new LeadsServiceError('TENANT_CONTEXT_REQUIRED', 'Company context is required', 403);
    }
    const columns = mapFieldsToColumns(fields);

    // Converted is not a status a caller may assert — it is what linking a job
    // MAKES true, and leadConversionService sets it together with
    // converted_to_job. updateLead has refused this since mig245; createLead did
    // not, so a lead born "Converted" carried converted_to_job = false, which the
    // constraint refuses. The whole INSERT rolled back and the lead was lost —
    // invisibly, because the operator then made the job by hand and only the
    // channel attribution went missing with it.
    if (columns.status === 'Converted') {
        throw new LeadsServiceError(
            'CONVERSION_REQUIRED',
            'Converted status can only be set by linking a job',
            409
        );
    }

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

    // Every write has an explicit tenant; workers do not have req/companyFilter.
    columns.company_id = companyId;

    let insertedLeadId;
    const result = await mutateLeadWithActivity(
        activityActor,
        async (client) => {
            columns.uuid = await generateUniqueUUID(client);

            // Handle custom metadata fields (flat api_name keys + Metadata object)
            const meta = await extractCustomMetadata(fields, client);
            const merged = { ...(meta || {}), ...(systemMetadata || {}) };
            if (Object.keys(merged).length > 0) {
                columns.metadata = JSON.stringify(merged);
            }

            const colNames = Object.keys(columns);
            const values = Object.values(columns);
            const placeholders = values.map((_, i) => `$${i + 1}`);

            const { rows } = await client.query(
                `INSERT INTO leads (${colNames.join(', ')})
                 VALUES (${placeholders.join(', ')})
                 RETURNING uuid, serial_id, id`,
                values
            );
            insertedLeadId = rows[0].id;
            return {
                UUID: rows[0].uuid,
                SerialId: rows[0].serial_id,
                ClientId: String(rows[0].id),
                link: null,
            };
        },
        inserted => [{
            companyId,
            action: 'lead.created',
            entityId: inserted.ClientId,
            summary: { status: columns.status || 'Submitted' },
        }]
    );

    emitLeadChange('lead.created', columns.company_id);
    // OUTBOUND-LEAD-CALL-001: post-insert domain event (REPAIR-ADVISOR pattern,
    // convertLead precedent). Fire-and-forget: a failing bus never breaks the
    // create. This single emit site covers ALL ingestion paths — UI routes,
    // external integrations, Yelp, Sara's createLead skill — they all funnel
    // through this function. The SSE emitLeadChange above is untouched.
    eventBus.emit(
        columns.company_id,
        'lead.created',
        {
            id: insertedLeadId,
            lead_id: insertedLeadId,
            serial_id: result.SerialId || null,
            source: columns.job_source || null,
            status: columns.status || 'Submitted',
            record_refs: [{ type: 'lead', id: insertedLeadId }],
        },
        {
            ...domainActor(activityActor),
            aggregateType: 'lead',
            aggregateId: insertedLeadId,
        }
    ).catch(() => {});
    return result;
}

// =============================================================================
// Update Lead
// =============================================================================
async function updateLead(uuid, fields, companyId = null, activityActor = null) {
    if (!companyId) {
        throw new LeadsServiceError('TENANT_CONTEXT_REQUIRED', 'Company context is required', 403);
    }
    const columns = mapFieldsToColumns(fields);
    let statusChanged = false;
    let expectedOldStatus = null;

    const result = await mutateLeadWithActivity(
        activityActor,
        async (client) => {
            if (columns.status) {
                const { rows: currentRows } = await client.query(
                    `SELECT status
                     FROM leads
                     WHERE uuid = $1 AND company_id = $2
                     FOR UPDATE`,
                    [uuid, companyId]
                );
                if (currentRows.length === 0) {
                    throw new LeadsServiceError('LEAD_NOT_FOUND', `Lead ${uuid} not found`, 404);
                }
                expectedOldStatus = currentRows[0].status;
                statusChanged = columns.status !== expectedOldStatus;
                if (statusChanged && columns.status === 'Converted') {
                    throw new LeadsServiceError(
                        'CONVERSION_REQUIRED',
                        'Converted status can only be set by linking a job',
                        409
                    );
                }
                if (statusChanged) {
                    const transition = await fsmService.resolveTransition(
                        companyId,
                        'lead',
                        expectedOldStatus,
                        columns.status,
                        { queryable: client }
                    );
                    if (transition.valid === false) {
                        throw new LeadsServiceError(
                            'FSM_TRANSITION_DENIED',
                            transition.error || `Lead status transition ${expectedOldStatus} → ${columns.status} is not allowed`,
                            403
                        );
                    }
                }
            }

            // Handle custom metadata fields (flat api_name keys + Metadata object)
            // For updates, merge with existing metadata to avoid overwriting unset fields.
            const meta = await extractCustomMetadata(fields, client);
            if (meta) {
                const { rows: existing } = await client.query(
                    'SELECT metadata FROM leads WHERE uuid = $1 AND company_id = $2',
                    [uuid, companyId]
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
            idx++;
            conditions.push(`company_id = $${idx}`);
            values.push(companyId);
            if (columns.status) {
                idx++;
                conditions.push(`status = $${idx}`);
                values.push(expectedOldStatus);
            }

            const { rows } = await client.query(
                `UPDATE leads SET ${setClauses.join(', ')}
                 WHERE ${conditions.join(' AND ')}
                 RETURNING uuid, id`,
                values
            );
            if (rows.length === 0) {
                throw new LeadsServiceError(
                    'LEAD_STATUS_CONFLICT',
                    'Lead status changed while this update was in progress',
                    409
                );
            }

            return {
                UUID: rows[0].uuid,
                ClientId: String(rows[0].id),
                link: null,
            };
        },
        updated => [
            Object.keys(columns).some(column => column !== 'status') && {
                companyId,
                action: 'lead.updated',
                entityId: updated.ClientId,
            },
            statusChanged && {
                companyId,
                action: 'lead.status_changed',
                entityId: updated.ClientId,
                summary: { status: columns.status },
            },
        ]
    );

    // Only a status change can move a lead in/out of the "new" set → refresh badge.
    if (columns.status) emitLeadChange('lead.updated', companyId);

    if (statusChanged && columns.status === 'Review') {
        eventBus.emit(companyId, 'lead.review_required', {
            lead_id: result.ClientId,
            status: 'Review',
            record_refs: [{ type: 'lead', id: result.ClientId }],
        }, {
            ...domainActor(activityActor),
            aggregateType: 'lead',
            aggregateId: result.ClientId,
        }).catch(() => {});
    }

    return result;
}

// =============================================================================
// Mark Lost
// =============================================================================
async function markLost(uuid, companyId = null, activityActor = null) {
    if (!companyId) {
        throw new LeadsServiceError('TENANT_CONTEXT_REQUIRED', 'Company context is required', 403);
    }
    const result = await mutateLeadWithActivity(
        activityActor,
        async (client) => {
            const { rows } = await client.query(
                `UPDATE leads SET lead_lost = true, status = 'Lost'
                 WHERE uuid = $1 AND company_id = $2
                 RETURNING uuid, id`,
                [uuid, companyId]
            );
            if (rows.length === 0) {
                throw new LeadsServiceError('LEAD_NOT_FOUND', `Lead ${uuid} not found`, 404);
            }
            return {
                UUID: rows[0].uuid,
                ClientId: String(rows[0].id),
                message: 'Lead marked as lost',
            };
        },
        updated => [{
            companyId,
            action: 'lead.lost',
            entityId: updated.ClientId,
            summary: { status: 'Lost' },
        }]
    );
    emitLeadChange('lead.updated', companyId);
    return result;
}

// =============================================================================
// Activate Lead
// =============================================================================
async function activateLead(uuid, companyId = null, activityActor = null) {
    if (!companyId) {
        throw new LeadsServiceError('TENANT_CONTEXT_REQUIRED', 'Company context is required', 403);
    }
    const result = await mutateLeadWithActivity(
        activityActor,
        async (client) => {
            const { rows } = await client.query(
                `UPDATE leads SET lead_lost = false, status = 'Submitted'
                 WHERE uuid = $1 AND company_id = $2
                 RETURNING uuid, id`,
                [uuid, companyId]
            );
            if (rows.length === 0) {
                throw new LeadsServiceError('LEAD_NOT_FOUND', `Lead ${uuid} not found`, 404);
            }
            return {
                UUID: rows[0].uuid,
                ClientId: String(rows[0].id),
                message: 'Lead activated',
            };
        },
        updated => [{
            companyId,
            action: 'lead.reactivated',
            entityId: updated.ClientId,
            summary: { status: 'Submitted' },
        }]
    );
    emitLeadChange('lead.updated', companyId);
    return result;
}

// =============================================================================
// Assign User
// =============================================================================
async function assignUser(uuid, userName, companyId = null, activityActor = null) {
    if (!companyId) {
        throw new LeadsServiceError('TENANT_CONTEXT_REQUIRED', 'Company context is required', 403);
    }
    const result = await mutateLeadWithActivity(
        activityActor,
        async (client) => {
            const { rows: leadRows } = await client.query(
                'SELECT id FROM leads WHERE uuid = $1 AND company_id = $2',
                [uuid, companyId]
            );
            if (leadRows.length === 0) {
                throw new LeadsServiceError('LEAD_NOT_FOUND', `Lead ${uuid} not found`, 404);
            }

            const assigneeUserId = await resolveActiveAssigneeUserId(client, companyId, userName);
            const assignment = await client.query(
                `INSERT INTO lead_team_assignments (lead_id, user_name)
                 VALUES ($1, $2)
                 ON CONFLICT (lead_id, user_name) DO NOTHING
                 RETURNING id`,
                [leadRows[0].id, userName]
            );

            return {
                UUID: uuid,
                LeadId: String(leadRows[0].id),
                ClientId: String(leadRows[0].id),
                assignee_user_id: assigneeUserId,
                assignment_changed: assignment.rowCount > 0,
                link: null,
            };
        },
        updated => [{
            companyId,
            action: 'lead.assigned',
            entityId: updated.ClientId,
        }]
    );
    if (result.assignment_changed && result.assignee_user_id) {
        eventBus.emit(companyId, 'lead.assigned', {
            lead_id: result.ClientId,
            assignee_user_ids: [result.assignee_user_id],
            record_refs: [{ type: 'lead', id: result.ClientId }],
        }, {
            ...domainActor(activityActor),
            aggregateType: 'lead',
            aggregateId: result.ClientId,
        }).catch(() => {});
    }
    delete result.assignee_user_id;
    delete result.assignment_changed;
    return result;
}

// =============================================================================
// Unassign User
// =============================================================================
async function unassignUser(uuid, userName, companyId = null, activityActor = null) {
    if (!companyId) {
        throw new LeadsServiceError('TENANT_CONTEXT_REQUIRED', 'Company context is required', 403);
    }
    const result = await mutateLeadWithActivity(
        activityActor,
        async (client) => {
            const { rows: leadRows } = await client.query(
                'SELECT id FROM leads WHERE uuid = $1 AND company_id = $2',
                [uuid, companyId]
            );
            if (leadRows.length === 0) {
                throw new LeadsServiceError('LEAD_NOT_FOUND', `Lead ${uuid} not found`, 404);
            }

            const previousAssigneeUserId = await resolveActiveAssigneeUserId(client, companyId, userName);
            const assignment = await client.query(
                `DELETE FROM lead_team_assignments
                 WHERE lead_id = $1 AND user_name = $2
                 RETURNING id`,
                [leadRows[0].id, userName]
            );

            return {
                UUID: uuid,
                LeadId: String(leadRows[0].id),
                ClientId: String(leadRows[0].id),
                previous_assignee_user_id: previousAssigneeUserId,
                assignment_changed: assignment.rowCount > 0,
                link: null,
            };
        },
        updated => [{
            companyId,
            action: 'lead.unassigned',
            entityId: updated.ClientId,
        }]
    );
    if (result.assignment_changed && result.previous_assignee_user_id) {
        eventBus.emit(companyId, 'lead.unassigned', {
            lead_id: result.ClientId,
            previous_recipient_user_ids: [result.previous_assignee_user_id],
            previous_assignee_user_ids: [result.previous_assignee_user_id],
            record_refs: [{ type: 'lead', id: result.ClientId }],
        }, {
            ...domainActor(activityActor),
            aggregateType: 'lead',
            aggregateId: result.ClientId,
        }).catch(() => {});
    }
    delete result.previous_assignee_user_id;
    delete result.assignment_changed;
    return result;
}

// =============================================================================
// Convert Lead to Job
// =============================================================================
async function claimLocalJobForConversion({
    leadRow,
    contactId,
    zenbookerJobId,
    localJobFields,
    leadUpdates,
    companyId,
    activityActor,
}) {
    try {
        const conversion = await convertLeadWithJob({
            companyId,
            leadId: leadRow.id,
            activityActor,
            leadUpdates,
            createOrReuseJob: async ({ client, lead }) => {
                const { rows: existingJobs } = await client.query(
                    `SELECT id, contact_id, zenbooker_job_id
                     FROM jobs
                     WHERE lead_id = $1 AND company_id = $2
                     ORDER BY id ASC
                     LIMIT 1
                     FOR UPDATE`,
                    [lead.id, companyId]
                );

                let localJobId;
                let localJobCreated = false;
                let existingZenbookerJobId = null;
                let activeZenbookerJobId = zenbookerJobId || null;

                if (existingJobs.length > 0) {
                    const existingJob = existingJobs[0];
                    localJobId = existingJob.id;
                    existingZenbookerJobId = existingJob.zenbooker_job_id || null;
                    activeZenbookerJobId = existingZenbookerJobId || activeZenbookerJobId;

                    const updates = [];
                    const updateParams = [];
                    if (!existingJob.contact_id && contactId) {
                        updateParams.push(contactId);
                        updates.push(`contact_id = $${updateParams.length}`);
                    }
                    if (!existingJob.zenbooker_job_id && zenbookerJobId) {
                        updateParams.push(zenbookerJobId);
                        updates.push(`zenbooker_job_id = $${updateParams.length}`);
                    }
                    if (updates.length > 0) {
                        updateParams.push(localJobId, companyId);
                        await client.query(
                            `UPDATE jobs SET ${updates.join(', ')}, updated_at = NOW()
                             WHERE id = $${updateParams.length - 1}
                               AND company_id = $${updateParams.length}`,
                            updateParams
                        );
                    }
                } else {
                    const { resolveAssignedProviderUserIds } = require('./jobsService');
                    const assignedProviderUserIds = await resolveAssignedProviderUserIds(
                        companyId,
                        localJobFields.initialAssignedTechs
                    );
                    const { rows: [jobRow] } = await client.query(`
                        INSERT INTO jobs (
                            lead_id, contact_id, zenbooker_job_id, blanc_status, service_name, address,
                            customer_name, customer_phone, customer_email, company_id,
                            job_type, job_source, description, metadata, comments,
                            start_date, end_date, assigned_techs, assigned_provider_user_ids
) VALUES ($1, $2, $3, 'Submitted', $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17::jsonb, $18::jsonb)
                        RETURNING id
                    `, [
                        lead.id,
                        contactId,
                        activeZenbookerJobId,
                        localJobFields.serviceName,
                        localJobFields.address,
                        localJobFields.customerName,
                        localJobFields.customerPhone,
                        localJobFields.customerEmail,
                        companyId,
                        lead.job_type || localJobFields.serviceName,
                        lead.job_source || null,
                        localJobFields.description,
                        lead.metadata || '{}',
                        lead.comments || null,
                        localJobFields.initialStartDate,
                        localJobFields.initialEndDate,
                        localJobFields.initialAssignedTechs,
                        assignedProviderUserIds,
                    ]);
                    localJobId = jobRow.id;
                    localJobCreated = true;
                }

                return {
                    jobId: localJobId,
                    jobCreated: localJobCreated,
                    jobStatus: 'Submitted',
                    zenbookerJobId: activeZenbookerJobId,
                    existingZenbookerJobId,
                    leadUpdates: {
                        ...(contactId ? { contact_id: contactId } : {}),
                        ...(activeZenbookerJobId ? { zenbooker_job_id: activeZenbookerJobId } : {}),
                    },
                };
            },
        });

        return {
            localJobId: conversion.jobId,
            localJobCreated: conversion.jobCreated,
            zenbookerJobId: conversion.zenbookerJobId,
            existingZenbookerJobId: conversion.existingZenbookerJobId,
            conversionChanged: conversion.conversionChanged,
        };
    } catch (err) {
        if (err?.code && err?.httpStatus) {
            throw new LeadsServiceError(err.code, err.message, err.httpStatus);
        }
        throw err;
    }
}

/**
 * ZB-DECOUPLE C4b — native conversion schedule. When the wizard sends
 * overrides.schedule = { start_at, end_at, technician_ids? } the conversion is
 * FULLY native: the local job carries the schedule/assignment and NO Zenbooker
 * job is created. technician_ids are validated on the mode-aware
 * roster and stored as canonical technicians.id UUIDs. Historical ZB ids are
 * accepted as input and resolved before the job write.
 */
async function resolveNativeSchedule(schedule, companyId) {
    if (!schedule || typeof schedule !== 'object') return null;
    const start = new Date(schedule.start_at);
    const end = new Date(schedule.end_at);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
        throw new LeadsServiceError('INVALID_SCHEDULE', 'schedule.start_at and schedule.end_at must be valid timestamps', 400);
    }
    if (end <= start) {
        throw new LeadsServiceError('INVALID_SCHEDULE', 'schedule.end_at must be after schedule.start_at', 400);
    }
    const rawIds = Array.isArray(schedule.technician_ids) ? schedule.technician_ids : [];
    const technicianRosterService = require('./technicianRosterService');
    const assigned = [];
    for (const raw of rawIds) {
        const id = String(raw ?? '').trim();
        if (!id) continue;
        let technician;
        try {
            technician = await technicianRosterService.requireActive(companyId, id);
        } catch {
            throw new LeadsServiceError('INVALID_TECHNICIAN', `schedule.technician_ids: ${id} is not on the active roster`, 400);
        }
        assigned.push({ id: String(technician.id), name: technician.name });
    }
    return {
        startISO: start.toISOString(),
        endISO: end.toISOString(),
        assignedTechs: assigned.length ? JSON.stringify(assigned) : null,
    };
}

async function convertLead(uuid, overrides = {}, companyId = null, activityActor = null) {
    if (!companyId) {
        throw new LeadsServiceError('TENANT_CONTEXT_REQUIRED', 'Company context is required', 403);
    }
    // 1. Fetch full lead
    const { rows: leadRows } = await db.query(
        'SELECT * FROM leads WHERE uuid = $1 AND company_id = $2',
        [uuid, companyId]
    );
    if (leadRows.length === 0) {
        throw new LeadsServiceError('LEAD_NOT_FOUND', `Lead ${uuid} not found`, 404);
    }
    const lead = rowToLead(leadRows[0]);
    const leadRow = leadRows[0];

    // 1a. Ensure contact exists — create one if lead has no contact_id
    let contactId = leadRow.contact_id || null;
    if (!contactId) {
        const contactDedupeService = require('./contactDedupeService');
        const phone = overrides.customer?.phone || leadRow.phone;
        if (phone) {
            try {
                const resolved = await contactDedupeService.resolveContact({
                    first_name: leadRow.first_name || null,
                    last_name: leadRow.last_name || null,
                    phone,
                    email: overrides.customer?.email || leadRow.email || null,
                }, leadRow.company_id, { activityActor });
                if (resolved.contact_id) {
                    contactId = resolved.contact_id;
                    // Link contact back to the lead
                    await db.query(
                        'UPDATE leads SET contact_id = $1 WHERE id = $2 AND company_id = $3',
                        [contactId, leadRow.id, companyId]
                    );
                    console.log(`[ConvertLead] ${resolved.status === 'created' ? 'Created' : 'Found'} contact ${contactId} for lead ${leadRow.id}`);
                }
            } catch (err) {
                console.error('[ConvertLead] Contact resolve error (non-blocking):', err.message);
            }
        }
    }

    // 2. Claim or create the local job row in Albusto.
    // This makes conversion idempotent: a retry reuses the same local job instead
    // of inserting a duplicate.
    const serviceName = overrides.service?.name || lead.JobType || 'General Service';
    const address = overrides.address
        ? [overrides.address.line1, overrides.address.line2, overrides.address.city, overrides.address.state, overrides.address.postal_code].filter(Boolean).join(', ')
        : [leadRow.address, leadRow.unit, leadRow.city, leadRow.state, leadRow.postal_code].filter(Boolean).join(', ');
    const customerName = overrides.customer?.name || [leadRow.first_name, leadRow.last_name].filter(Boolean).join(' ') || null;
    const customerPhone = overrides.customer?.phone || leadRow.phone || null;
    const customerEmail = overrides.customer?.email || leadRow.email || null;

    // Extract scheduling data from zb_job_payload so local job always has it
    let initialStartDate = null;
    let initialEndDate = null;
    let initialAssignedTechs = null;
    if (overrides.zb_job_payload) {
        const zbp = overrides.zb_job_payload;
        if (zbp.timeslot?.start) initialStartDate = zbp.timeslot.start;
        if (zbp.timeslot?.end) initialEndDate = zbp.timeslot.end;
        if (zbp.assigned_providers?.length) {
            const technicianRosterService = require('./technicianRosterService');
            const assignments = zbp.assigned_providers.map(provider =>
                provider && typeof provider === 'object' ? provider : { id: provider }
            );
            initialAssignedTechs = JSON.stringify(
                await technicianRosterService.canonicalizeAssignments(companyId, assignments)
            );
        }
    }

    // ZB-DECOUPLE C4b: a native schedule wins over any legacy payload-derived values.
    const nativeSchedule = await resolveNativeSchedule(overrides.schedule, companyId);
    if (nativeSchedule) {
        initialStartDate = nativeSchedule.startISO;
        initialEndDate = nativeSchedule.endISO;
        initialAssignedTechs = nativeSchedule.assignedTechs;
    }

    let zenbookerJobId = overrides.zenbooker_job_id || null;
    const conversionLeadUpdates = {};
    if (overrides.service?.name && overrides.service.name !== leadRow.job_type) {
        conversionLeadUpdates.job_type = overrides.service.name;
    }
    if (overrides.service?.description && overrides.service.description !== (leadRow.lead_notes || '')) {
        conversionLeadUpdates.lead_notes = overrides.service.description;
    }
    if (overrides.address) {
        if (overrides.address.line1 != null) conversionLeadUpdates.address = overrides.address.line1;
        if (overrides.address.line2 != null) conversionLeadUpdates.unit = overrides.address.line2;
        if (overrides.address.city != null) conversionLeadUpdates.city = overrides.address.city;
        if (overrides.address.state != null) conversionLeadUpdates.state = overrides.address.state;
        if (overrides.address.postal_code != null) conversionLeadUpdates.postal_code = overrides.address.postal_code;
    }
    if (overrides.customer?.phone && overrides.customer.phone !== leadRow.phone) {
        conversionLeadUpdates.phone = overrides.customer.phone;
    }
    if (overrides.customer?.email && overrides.customer.email !== leadRow.email) {
        conversionLeadUpdates.email = overrides.customer.email;
    }

    const claimedJob = await claimLocalJobForConversion({
        leadRow,
        contactId,
        zenbookerJobId,
        localJobFields: {
            serviceName,
            address,
            customerName,
            customerPhone,
            customerEmail,
            description: (overrides.service?.description
                || overrides.zb_job_payload?.services?.[0]?.custom_service?.description
                || overrides.zb_job_payload?.services?.[0]?.description
                || leadRow.lead_notes
                || leadRow.comments
                || '').trim() || null,
            initialStartDate,
            initialEndDate,
            initialAssignedTechs,
        },
        leadUpdates: conversionLeadUpdates,
        companyId,
        activityActor,
    });

    const localJobId = claimedJob.localJobId;
    const localJobCreated = claimedJob.localJobCreated;
    zenbookerJobId = claimedJob.zenbookerJobId;

    if (localJobCreated) {
        console.log(`[ConvertLead] Local job created: ${localJobId}`);
    } else {
        console.log(`[ConvertLead] Reusing existing local job ${localJobId} for lead ${leadRow.id}`);
    }

    // 2a. Link contact to timeline (adopt orphan timeline)
    // Only adopt if the timeline's phone matches the contact's phone —
    // prevents cross-contamination when user changes phone in the wizard
    if (localJobCreated && overrides.timeline_id && contactId) {
        try {
            const contactRow = await db.query(
                `SELECT phone_e164, secondary_phone
                 FROM contacts
                 WHERE id = $1 AND company_id = $2`,
                [contactId, companyId]
            );
            const c = contactRow.rows[0];
            const contactDigits = [];
            if (c?.phone_e164) contactDigits.push(c.phone_e164.replace(/\D/g, '').slice(-10));
            if (c?.secondary_phone) contactDigits.push(c.secondary_phone.replace(/\D/g, '').slice(-10));

            const tlRow = await db.query(
                `SELECT phone_e164
                 FROM timelines
                 WHERE id = $1 AND company_id = $2 AND contact_id IS NULL`,
                [overrides.timeline_id, companyId]
            );
            const tl = tlRow.rows[0];

            if (tl) {
                const tlDigits = tl.phone_e164 ? tl.phone_e164.replace(/\D/g, '').slice(-10) : null;
                const phoneMatches = tlDigits && contactDigits.includes(tlDigits);

                if (phoneMatches) {
                    await db.query(
                        `UPDATE timelines SET contact_id = $1, phone_e164 = NULL, updated_at = now()
                         WHERE id = $2 AND company_id = $3 AND contact_id IS NULL`,
                        [contactId, overrides.timeline_id, companyId]
                    );
                    await db.query(
                        `UPDATE calls SET contact_id = $1
                         WHERE timeline_id = $2 AND company_id = $3 AND contact_id IS NULL`,
                        [contactId, overrides.timeline_id, companyId]
                    );
                    console.log(`[ConvertLead] Linked timeline ${overrides.timeline_id} to contact ${contactId}`);
                } else {
                    console.warn(`[ConvertLead] Skipped timeline ${overrides.timeline_id} adoption — phone mismatch (timeline: ${tl.phone_e164}, contact digits: ${contactDigits.join(',')})`);
                }
            }
        } catch (err) {
            console.error('[ConvertLead] Timeline linking error (non-blocking):', err.message);
        }
    }

    // 3. Add lead comments as local job notes.
    try {
        const jobsService = require('./jobsService');
        const commentText = leadRow.comments?.trim();

        // Add comments as note if present
        if (localJobCreated && commentText) {
            await jobsService.addNote(
                localJobId,
                `[Lead Comment] ${commentText}`,
                [],
                null,
                null,
                null,
                companyId
            );
            console.log(`[ConvertLead] Added comments as note to job ${localJobId}`);
        }
    } catch (noteErr) {
        console.error(`[ConvertLead] Note sync error (non-blocking):`, noteErr.message);
    }

    emitLeadChange('lead.updated', companyId);

    // [CHANGE START] REPAIR-ADVISOR-001 (T6): post-commit domain event for the
    // AI Repair Advisor subscriber — ONLY when a NEW local job was created during
    // this conversion. The reuse/claim-existing branch (localJobCreated===false)
    // stays note-free so a retry never produces a duplicate advisor note (§3.2).
    // Fire-and-forget: a failing bus never breaks the conversion.
    if (localJobCreated) {
        eventBus.emit(
            companyId,
            'job.created',
            {
                id: localJobId,
                job_id: localJobId,
                record_refs: [{ type: 'job', id: localJobId }],
            },
            {
                ...domainActor(activityActor),
                aggregateType: 'job',
                aggregateId: localJobId,
            }
        ).catch(() => {});
    }
    // [CHANGE END]

    eventBus.emit(companyId, 'lead.converted', {
        lead_id: leadRow.id,
        job_id: localJobId,
        status: 'Converted',
        record_refs: [
            { type: 'lead', id: leadRow.id },
            { type: 'job', id: localJobId },
        ],
    }, {
        ...domainActor(activityActor),
        aggregateType: 'lead',
        aggregateId: leadRow.id,
    }).catch(() => {});

    return {
        UUID: lead.UUID,
        ClientId: String(leadRow.id),
        job_id: localJobId,
        zenbooker_job_id: zenbookerJobId,
        zb_warning: null,
        link: `/jobs/${localJobId}`,
    };
}

// =============================================================================
// Get Leads by Phone — BATCH (resolves N phones in 1 query)
// =============================================================================
async function getLeadsByPhones(phones, companyId = null) {
    if (!phones || phones.length === 0) return {};

    // Normalize all phones to last-10-digits
    const normalized = phones
        .map(p => (p || '').replace(/\D/g, ''))
        .map(d => d.length >= 10 ? d.slice(-10) : d)
        .filter(d => d.length > 0);
    if (normalized.length === 0) return {};

    const unique = [...new Set(normalized)];

    const conditions = [
        `RIGHT(REGEXP_REPLACE(l.phone, '[^0-9]', '', 'g'), 10) = ANY($1::text[])`,
        `l.status NOT IN ('Lost', 'Converted')`,
    ];
    const params = [unique];
    if (companyId) {
        conditions.push(`l.company_id = $2`);
        params.push(companyId);
    }

    // Fetch all matching leads, pick newest per phone (DISTINCT ON)
    const sql = `
        SELECT DISTINCT ON (RIGHT(REGEXP_REPLACE(l.phone, '[^0-9]', '', 'g'), 10))
            l.*,
            RIGHT(REGEXP_REPLACE(l.phone, '[^0-9]', '', 'g'), 10) AS _phone_key,
            COALESCE(
                json_agg(json_build_object('id', lta.id, 'name', lta.user_name))
                FILTER (WHERE lta.id IS NOT NULL), '[]'
            ) AS team
        FROM leads l
        LEFT JOIN lead_team_assignments lta ON lta.lead_id = l.id
        WHERE ${conditions.join(' AND ')}
        GROUP BY l.id
        ORDER BY RIGHT(REGEXP_REPLACE(l.phone, '[^0-9]', '', 'g'), 10), l.id DESC
    `;

    const { rows } = await db.query(sql, params);

    // Filter out leads whose contact already has a job (same logic as getLeadByPhone)
    const contactIds = rows.map(r => r.contact_id).filter(Boolean);
    let contactsWithJobs = new Set();
    if (contactIds.length > 0) {
        const { rows: jobRows } = await db.query(
            `SELECT DISTINCT contact_id FROM jobs WHERE contact_id = ANY($1::int[])`,
            [contactIds]
        );
        contactsWithJobs = new Set(jobRows.map(r => r.contact_id));
    }

    const result = {};
    for (const row of rows) {
        if (row.contact_id && contactsWithJobs.has(row.contact_id)) continue;
        result[row._phone_key] = rowToLead(row);
    }

    return result;
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
    if (rows.length === 0) return null;

    // If the lead's contact already has a job, skip the lead so PulsePage
    // shows the contact panel instead of the stale lead card.
    const lead = rows[0];
    if (lead.contact_id) {
        const { rows: jobRows } = await db.query(
            `SELECT 1 FROM jobs WHERE contact_id = $1 LIMIT 1`,
            [lead.contact_id]
        );
        if (jobRows.length > 0) return null;
    }

    return rowToLead(lead);
}

// =============================================================================
// Get Lead by contact_id (newest OPEN match) — EMAIL-LEAD-ORIGIN-001
// Byte-for-byte the shape of getLeadByPhone, keyed on l.contact_id (uses
// idx_leads_contact_id) so a phoneless email-origin contact card can detect an
// already-linked lead and show LeadDetailPanel instead of re-offering the wizard.
// =============================================================================
async function getLeadByContact(contactId, companyId = null) {
    if (!contactId) return null;

    const conditions = [
        `l.contact_id = $1`,
        `l.status NOT IN ('Lost', 'Converted')`,
    ];
    const params = [contactId];
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
    if (rows.length === 0) return null;

    // If the lead's contact already has a job, skip the lead so PulsePage
    // shows the contact panel instead of the stale lead card.
    const lead = rows[0];
    if (lead.contact_id) {
        const { rows: jobRows } = await db.query(
            `SELECT 1 FROM jobs WHERE contact_id = $1 LIMIT 1`,
            [lead.contact_id]
        );
        if (jobRows.length > 0) return null;
    }

    return rowToLead(lead);
}

// =============================================================================
// Get OPEN leads by contact_id — NON-SUPPRESSING (AGENT-SKILLS-002 §3.1-A)
// Company-scoped, ALL open leads for the contact, newest-first. Unlike
// getLeadByContact (@1157) this does NOT hide the lead when the contact also has
// a job — that suppression is exactly the "contact with both a lead and a job"
// case the voice agent must SURFACE (lead-aware overview + bookOnLead). Used by
// getCustomerOverview (surfacing) and bookOnLead (find-the-lead-to-update).
//
// "Open" = the shipped terminal set (Lost / Converted) excluded, matched
// case-insensitively (getLeadByContact/getLeadsByPhone use the exact-case tokens;
// we compare UPPER(status) so a lower/mixed-case row can never look "open" by
// accident). Ordered newest proposed-slot first (lead_date_time DESC NULLS LAST),
// id DESC as a stable tiebreak → caller takes [0] as "the" open lead.
// =============================================================================
async function getOpenLeadsByContact(contactId, companyId = null) {
    if (!contactId) return [];

    const conditions = [
        `l.contact_id = $1`,
        `UPPER(l.status) NOT IN ('LOST', 'CONVERTED')`,
    ];
    const params = [contactId];
    if (companyId) {
        conditions.push(`l.company_id = $2`);
        params.push(companyId);
    }

    const sql = `
        SELECT l.*, c.full_name AS contact_name,
            COALESCE(
                json_agg(json_build_object('id', lta.id, 'name', lta.user_name))
                FILTER (WHERE lta.id IS NOT NULL), '[]'
            ) AS team
        FROM leads l
        LEFT JOIN lead_team_assignments lta ON lta.lead_id = l.id
        LEFT JOIN contacts c ON c.id = l.contact_id
        WHERE ${conditions.join(' AND ')}
        GROUP BY l.id, c.full_name
        ORDER BY l.lead_date_time DESC NULLS LAST, l.id DESC
    `;

    const { rows } = await db.query(sql, params);
    return rows.map(rowToLead);
}

// =============================================================================
// Get Available Lead Transitions (FSM-aware)
// =============================================================================
async function getLeadTransitions(companyId, currentStatus, userRoles) {
    const result = await fsmService.getAvailableActions(companyId, 'lead', currentStatus, userRoles);
    if (!result.fallback) {
        return result.actions;
    }
    // Fallback: permissive (no restrictions without FSM)
    return [];
}

// =============================================================================
// Exports
// =============================================================================
// =============================================================================
// LEADS-NEW-BADGE-001 — "new / unactioned" lead counter + live events
// =============================================================================

// Statuses that count as "new / not yet actioned" for the nav badge. The DB
// default on creation is 'Submitted'; 'New'/'Review' are the other pre-contact
// states. Single source of truth — the count query and any UI reuse this.
const NEW_LEAD_STATUSES = ['Submitted', 'New', 'Review'];

// Company-scoped count of new/unactioned leads (excludes lost). Used by the
// GET /api/leads/new-count endpoint that feeds the nav badge.
async function countNewLeads(companyId) {
    if (!companyId) return 0;
    const { rows } = await db.query(
        `SELECT COUNT(*)::int AS count FROM leads
         WHERE company_id = $1 AND lead_lost = false AND status = ANY($2::text[])
           AND NOT COALESCE(metadata @> '{"rely_filter":{"rejected":true}}'::jsonb, false)`,
        [companyId, NEW_LEAD_STATUSES]
    );
    return rows[0]?.count || 0;
}

// Notify same-company clients so the "new leads" badge refreshes live. Payload
// carries company scope only; the realtime boundary projects the invalidation,
// and the client refetches its own company-scoped count. Best-effort — a broadcast failure
// never breaks the lead write.
function emitLeadChange(eventType, companyId) {
    if (!companyId) return;
    try {
        require('./realtimeService').broadcast(eventType, {
            company_id: companyId,
        });
    } catch (err) {
        console.warn('[leadsService] lead event broadcast failed:', err.message);
    }
}

module.exports = {
    listLeads,
    RESERVED_METADATA_KEYS,
    NEW_LEAD_STATUSES,
    countNewLeads,
    getLeadByUUID,
    getLeadById,
    getLeadByPhone,
    getLeadByContact,
    getOpenLeadsByContact,
    getLeadsByPhones,
    createLead,
    updateLead,
    markLost,
    activateLead,
    assignUser,
    unassignUser,
    convertLead,
    resolveNativeSchedule,
    getLeadTransitions,
    LeadsServiceError,
};
