/**
 * Contacts Service
 * 
 * PostgreSQL CRUD for contacts.
 * Supports upsert from Zenbooker customer data.
 */

const db = require('../db/connection');
const { toE164 } = require('../utils/phoneUtils');
const { resolveOrCreateContact } = require('./contactResolverService');
const { propagateContactDetails } = require('./contactPropagationService');
const { buildActiveAssignedContactPredicate } = require('../db/providerContactAccessQueries');
const {
    createCursorFingerprint,
    encodeCursor,
    decodeCursor,
    assertCursorOffsetExclusive,
    buildKeysetPredicate,
    bigintCursorExpression,
} = require('../utils/listCursor');

function queryFor(client) {
    return client?.query ? client.query.bind(client) : db.query;
}

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
async function listContacts({ search, offset, limit = 50, cursor, companyId, providerScope } = {}) {
    if (!companyId) {
        const err = new Error('Tenant context required');
        err.code = 'TENANT_CONTEXT_REQUIRED';
        err.httpStatus = 403;
        throw err;
    }
    if (!Number.isInteger(Number(limit)) || Number(limit) < 1 || Number(limit) > 100) {
        const err = new Error('limit must be an integer from 1 to 100');
        err.code = 'INVALID_QUERY';
        err.httpStatus = 400;
        throw err;
    }
    const pageLimit = Number(limit);
    if (offset !== undefined && (!Number.isInteger(Number(offset)) || Number(offset) < 0)) {
        const err = new Error('offset must be a non-negative integer');
        err.code = 'INVALID_QUERY';
        err.httpStatus = 400;
        throw err;
    }
    assertCursorOffsetExclusive(cursor, offset);

    const normalizedSearch = typeof search === 'string' ? search.trim() : '';
    const mode = offset === undefined ? 'cursor' : 'offset';
    const fingerprint = createCursorFingerprint({
        endpoint: 'contacts',
        company: String(companyId),
        visibility: {
            assigned_only: providerScope?.assignedOnly === true,
            user_id: providerScope?.assignedOnly ? String(providerScope.userId || '') : null,
        },
        filters: { search: normalizedSearch.toLocaleLowerCase('en-US') },
        sort: 'id',
        direction: 'desc',
        limit: pageLimit,
    });
    const cursorExpectation = {
        endpoint: 'contacts',
        sort: 'id',
        direction: 'desc',
        fingerprint,
        valueTypes: ['bigint'],
    };
    const decodedCursor = cursor ? decodeCursor(cursor, cursorExpectation) : null;

    const conditions = [];
    const params = [];
    let paramIdx = 0;

    paramIdx++;
    conditions.push(`c.company_id = $${paramIdx}`);
    params.push(companyId);

    // assigned_only providers see only contacts linked to their visible jobs (PF007).
    // ROLE-PULSE-SCOPE-001: this list feeds the Pulse sidebar, so restrict to contacts with
    // an ACTIVE job according to the one shared provider-contact predicate.
    if (providerScope?.assignedOnly) {
        if (!providerScope.userId) {
            conditions.push('FALSE');
        } else {
            paramIdx++;
            const userParam = paramIdx;
            conditions.push(buildActiveAssignedContactPredicate({
                jobsAlias: 'pj',
                contactIdExpression: 'c.id',
                companyPlaceholder: 'c.company_id',
                userPlaceholder: `$${userParam}`,
            }));
            params.push(JSON.stringify([providerScope.userId]));
        }
    }

    if (normalizedSearch) {
        paramIdx++;
        const searchPattern = `%${normalizedSearch}%`;
        conditions.push(`(
            c.full_name ILIKE $${paramIdx}
            OR c.phone_e164 ILIKE $${paramIdx}
            OR c.secondary_phone ILIKE $${paramIdx}
            OR c.email ILIKE $${paramIdx}
        )`);
        params.push(searchPattern);
    }

    const whereClause = `WHERE ${conditions.join(' AND ')}`;
    let total = null;
    if (!decodedCursor) {
        const countResult = await db.query(
            `SELECT COUNT(*)::int AS total FROM contacts c ${whereClause}`,
            params,
        );
        total = countResult.rows[0]?.total ?? 0;
    }

    const pageParams = params.slice();
    let cursorPredicate = '';
    if (decodedCursor) {
        const keyset = buildKeysetPredicate([
            { expression: 'c.id', direction: 'desc', type: 'bigint' },
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
        SELECT c.*, ${bigintCursorExpression('c.id')} AS __cursor_id
        FROM contacts c
        ${whereClause}${cursorPredicate}
        ORDER BY c.id DESC
        LIMIT $${limitParam}${offsetSql}
    `;

    const { rows: probedRows } = await db.query(sql, pageParams);
    const rows = probedRows.slice(0, pageLimit);
    const hasMore = probedRows.length > pageLimit;
    const results = rows.map(rowToContact);
    const lastRow = rows.at(-1);
    const nextCursor = mode === 'cursor' && hasMore && lastRow
        ? encodeCursor({
            endpoint: 'contacts',
            sort: 'id',
            direction: 'desc',
            fingerprint,
            values: [String(lastRow.__cursor_id)],
        }, cursorExpectation)
        : null;

    return {
        results,
        pagination: {
            mode,
            offset: mode === 'offset' ? Number(offset) : 0,
            limit: pageLimit,
            returned: results.length,
            has_more: hasMore,
            next_cursor: nextCursor,
            total,
        },
    };
}

// =============================================================================
// Get Contact by ID
// =============================================================================
async function getContactById(id, companyId = null, providerScope = null, client = null) {
    const contact = await getById(id, companyId, providerScope, client);
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
async function getById(id, companyId = null, providerScope = null, client = null) {
    const conditions = ['c.id = $1'];
    const params = [id];
    if (companyId) {
        params.push(companyId);
        conditions.push(`c.company_id = $${params.length}`);
    }
    if (providerScope?.assignedOnly) {
        if (!providerScope.userId) return null;
        if (client?.query) {
            const visibleJobs = await queryFor(client)(
                `SELECT pj.id
                 FROM jobs pj
                 JOIN contacts owner
                   ON owner.id = pj.contact_id
                  AND owner.company_id = pj.company_id
                 WHERE owner.id = $1
                   AND owner.company_id = $2
                   AND pj.assigned_provider_user_ids @> $3::jsonb
                 FOR SHARE OF pj`,
                [id, companyId, JSON.stringify([providerScope.userId])]
            );
            if (visibleJobs.rows.length === 0) return null;
        }
        params.push(JSON.stringify([providerScope.userId]));
        conditions.push(`EXISTS (
            SELECT 1 FROM jobs pj
            WHERE pj.contact_id = c.id
              AND pj.company_id = c.company_id
              AND pj.assigned_provider_user_ids @> $${params.length}::jsonb
        )`);
    }
    const sql = `SELECT c.*
                 FROM contacts c
                 WHERE ${conditions.join(' AND ')}
                 ${client?.query ? 'FOR SHARE OF c' : ''}`;
    const { rows } = await queryFor(client)(sql, params);
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
async function getContactEmails(contactId, primaryEmail = null, companyId = null) {
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
        if (!companyId) {
            const error = new Error('Company context is required');
            error.code = 'TENANT_CONTEXT_REQUIRED';
            error.httpStatus = 403;
            throw error;
        }
        const { rows } = await db.query(
            `SELECT ce.email
             FROM contact_emails ce
             JOIN contacts c
               ON c.id = ce.contact_id
              AND c.company_id = $2
             WHERE ce.contact_id = $1
             ORDER BY ce.is_primary DESC, ce.created_at`,
            [contactId, companyId]
        );
        for (const r of rows) push(r.email);
    }
    return out;
}

// =============================================================================
// Upsert from Zenbooker customer data
// =============================================================================
async function upsertFromZenbooker(customer, companyId) {
    if (!companyId) {
        const err = new Error('Tenant context required');
        err.code = 'TENANT_CONTEXT_REQUIRED';
        err.httpStatus = 403;
        throw err;
    }
    const customerId = String(customer.id);
    const fullName = [customer.first_name, customer.last_name].filter(Boolean).join(' ') || null;
    const phone = toE164(customer.phone) || customer.phone || null;
    const secondaryPhone = toE164(customer.secondary_phone) || customer.secondary_phone || null;
    const secondaryPhoneName = customer.secondary_phone_name || null;
    const email = customer.email || null;
    const notes = customer.notes || null;
    // Store full Zenbooker payload for rich display
    const zbData = JSON.stringify(customer);

    const resolution = await resolveOrCreateContact({
        companyId,
        externalId: customerId,
        contact: customer,
    });

    // ZB can enrich blanks, but it never replaces an Albusto-owned scalar.
    await db.query(
        `UPDATE contacts target
         SET full_name = COALESCE(NULLIF(BTRIM(target.full_name), ''), $2),
             first_name = COALESCE(NULLIF(BTRIM(target.first_name), ''), $3),
             last_name = COALESCE(NULLIF(BTRIM(target.last_name), ''), $4),
             notes = COALESCE(NULLIF(BTRIM(target.notes), ''), $5),
             zenbooker_data = $6::jsonb,
             zenbooker_sync_status = 'linked',
             zenbooker_synced_at = NOW(),
             zenbooker_last_error = NULL,
             updated_at = NOW()
         WHERE target.company_id = $1 AND target.id = $7`,
        [
            companyId,
            fullName,
            customer.first_name || null,
            customer.last_name || null,
            notes,
            zbData,
            resolution.contact_id,
        ]
    );

    await propagateContactDetails(
        companyId,
        resolution.contact_id,
        { phone, email },
        { source: 'zb_contact_sync' }
    );
    if (secondaryPhone) {
        await propagateContactDetails(
            companyId,
            resolution.contact_id,
            { phone: secondaryPhone },
            { source: 'zb_contact_sync' }
        );
    }

    if (secondaryPhoneName && secondaryPhone) {
        await db.query(
            `UPDATE contacts
             SET secondary_phone_name = COALESCE(
                     NULLIF(BTRIM(secondary_phone_name), ''),
                     $1
                 )
             WHERE company_id = $2
               AND id = $3
               AND RIGHT(REGEXP_REPLACE(COALESCE(secondary_phone, ''), '[^0-9]', '', 'g'), 10)
                   = RIGHT(REGEXP_REPLACE($4, '[^0-9]', '', 'g'), 10)`,
            [secondaryPhoneName, companyId, resolution.contact_id, secondaryPhone]
        );
    }

    const { rows } = await db.query(
        'SELECT * FROM contacts WHERE company_id = $1 AND id = $2',
        [companyId, resolution.contact_id]
    );
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
