'use strict';

const db = require('./connection');
const { requireCompanyId } = require('./crmUtils');
const { companyDateFilterBounds } = require('../utils/companyTime');

function queryFor(client) {
    return client?.query ? client.query.bind(client) : db.query;
}

function bounded(value, fallback = 50, max = 100) {
    const parsed = Number(value ?? fallback);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > max) {
        const err = new Error(`limit must be an integer from 1 to ${max}`);
        err.code = 'INVALID_QUERY';
        err.httpStatus = 400;
        throw err;
    }
    return parsed;
}

function optionalIsoDate(value, name) {
    if (value === undefined || value === null || value === '') return null;
    const stringValue = String(value);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(stringValue)) {
        throw Object.assign(new Error(`${name} must be a valid YYYY-MM-DD date`), {
            code: 'INVALID_QUERY',
            httpStatus: 400,
        });
    }
    const parsed = new Date(`${stringValue}T00:00:00.000Z`);
    if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== stringValue) {
        throw Object.assign(new Error(`${name} must be a valid YYYY-MM-DD date`), {
            code: 'INVALID_QUERY',
            httpStatus: 400,
        });
    }
    return stringValue;
}

async function getJob(companyId, jobId) {
    requireCompanyId(companyId);
    const { rows } = await db.query(
        `SELECT j.*,
                l.serial_id AS lead_serial_id,
                COALESCE(tags.items, '[]'::jsonb) AS tags
         FROM jobs j
         LEFT JOIN leads l
           ON l.id = j.lead_id
          AND l.company_id = j.company_id
         LEFT JOIN LATERAL (
             SELECT jsonb_agg(jsonb_build_object(
                        'id', jt.id, 'name', jt.name, 'color', jt.color,
                        'is_active', jt.is_active
                    ) ORDER BY jt.sort_order, jt.id) AS items
             FROM job_tag_assignments jta
             JOIN jobs owner
               ON owner.id = jta.job_id
              AND owner.company_id = $2
             JOIN job_tags jt
               ON jt.id = jta.tag_id
             WHERE owner.id = j.id
         ) tags ON true
         WHERE j.id = $1 AND j.company_id = $2`,
        [jobId, companyId]
    );
    return rows[0] || null;
}

async function getLead(companyId, leadUuid) {
    requireCompanyId(companyId);
    const { rows } = await db.query(
        `SELECT l.*,
                COALESCE(team.items, '[]'::jsonb) AS team
         FROM leads l
         LEFT JOIN LATERAL (
             SELECT jsonb_agg(jsonb_build_object('id', lta.id, 'name', lta.user_name)
                              ORDER BY lta.assigned_at, lta.id) AS items
             FROM lead_team_assignments lta
             JOIN leads owner
               ON owner.id = lta.lead_id
              AND owner.company_id = lta.company_id
             WHERE owner.id = l.id
               AND owner.company_id = $2
         ) team ON true
         WHERE l.uuid = $1 AND l.company_id = $2`,
        [leadUuid, companyId]
    );
    return rows[0] || null;
}

async function getContact(companyId, contactId) {
    requireCompanyId(companyId);
    const { rows } = await db.query(
        `SELECT c.*,
                COALESCE(emails.items, '[]'::jsonb) AS emails,
                COALESCE(addresses.items, '[]'::jsonb) AS addresses
         FROM contacts c
         LEFT JOIN LATERAL (
             SELECT jsonb_agg(jsonb_build_object(
                        'id', ce.id, 'email', ce.email, 'is_primary', ce.is_primary
                    ) ORDER BY ce.is_primary DESC, ce.created_at, ce.id) AS items
             FROM contact_emails ce
             JOIN contacts owner
               ON owner.id = ce.contact_id
              AND owner.company_id = $2
             WHERE owner.id = c.id
         ) emails ON true
         LEFT JOIN LATERAL (
             SELECT jsonb_agg(jsonb_build_object(
                        'id', ca.id, 'label', ca.label, 'is_primary', ca.is_primary,
                        'street_line1', ca.street_line1, 'street_line2', ca.street_line2,
                        'city', ca.city, 'state', ca.state, 'postal_code', ca.postal_code,
                        'country', ca.country
                    ) ORDER BY ca.is_primary DESC, ca.created_at, ca.id) AS items
             FROM contact_addresses ca
             JOIN contacts owner
               ON owner.id = ca.contact_id
              AND owner.company_id = $2
             WHERE owner.id = c.id
         ) addresses ON true
         WHERE c.id = $1 AND c.company_id = $2`,
        [contactId, companyId]
    );
    return rows[0] || null;
}

async function getContactHistory(companyId, contactId, limit = 50) {
    requireCompanyId(companyId);
    const pageLimit = bounded(limit, 50, 100);
    const contact = await getContact(companyId, contactId);
    if (!contact) return null;
    const [events, jobs, leads] = await Promise.all([
        db.query(
            `SELECT de.id, de.event_type, de.actor_type, de.actor_id, de.created_at
             FROM domain_events de
             JOIN contacts c
               ON c.id = $2
              AND c.company_id = de.company_id
             WHERE de.company_id = $1
               AND de.aggregate_type = 'contact'
               AND de.aggregate_id = c.id::text
             ORDER BY de.created_at DESC, de.id DESC
             LIMIT $3`,
            [companyId, contactId, pageLimit]
        ),
        db.query(
            `SELECT j.id, j.job_number, j.job_seq, j.public_code,
                    j.blanc_status AS status, j.service_name,
                    j.start_date, j.notes, j.created_at, j.updated_at
             FROM jobs j
             JOIN contacts c
               ON c.id = j.contact_id
              AND c.company_id = j.company_id
             WHERE j.company_id = $1 AND c.id = $2
             ORDER BY j.updated_at DESC, j.id DESC
             LIMIT $3`,
            [companyId, contactId, pageLimit]
        ),
        db.query(
            `SELECT l.id, l.uuid, l.serial_id, l.status, l.sub_status,
                    l.lead_notes, l.comments, l.structured_notes,
                    l.created_at, l.updated_at
             FROM leads l
             JOIN contacts c
               ON c.id = l.contact_id
              AND c.company_id = l.company_id
             WHERE l.company_id = $1 AND c.id = $2
             ORDER BY l.updated_at DESC, l.id DESC
             LIMIT $3`,
            [companyId, contactId, pageLimit]
        ),
    ]);
    return { contact, events: events.rows, jobs: jobs.rows, leads: leads.rows };
}

function financeFilters(companyId, filters, alias, includeArchived = false) {
    requireCompanyId(companyId);
    const params = [companyId];
    const conditions = [`${alias}.company_id = $1`];
    if (includeArchived && filters.include_archived !== true) conditions.push(`${alias}.archived_at IS NULL`);
    const add = (sql, value) => {
        if (value === undefined || value === null || value === '') return;
        params.push(value);
        conditions.push(sql.replace('?', `$${params.length}`));
    };
    add(`${alias}.status = ?`, filters.status);
    add(`${alias}.contact_id = ?`, filters.contact_id);
    add(`${alias}.lead_id = ?`, filters.lead_id);
    add(`${alias}.job_id = ?`, filters.job_id);
    return { params, conditions };
}

function isoTimestamp(value) {
    if (value === null || value === undefined) return null;
    const date = value instanceof Date ? value : new Date(value);
    return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function offsetPagination(limit, offset, results, total) {
    return {
        mode: 'offset',
        limit,
        returned: results.length,
        has_more: offset + results.length < total,
        next_cursor: null,
        total,
    };
}

function projectLeadSummary(row) {
    return {
        id: row.id,
        uuid: row.uuid,
        serial_id: row.serial_id,
        lead_seq: row.lead_seq,
        public_code: row.public_code,
        status: row.status,
        source: row.job_source ?? null,
        job_source: row.job_source ?? null,
        first_name: row.first_name ?? null,
        last_name: row.last_name ?? null,
        city: row.city ?? null,
        state: row.state ?? null,
        created_at: isoTimestamp(row.created_at),
        converted_at: isoTimestamp(row.converted_at),
        contact_id: row.contact_id ?? null,
        converted_to_job: row.converted_to_job === true,
    };
}

async function listAppLeads(companyId, filters = {}) {
    requireCompanyId(companyId);
    const limit = bounded(filters.limit, 50, 100);
    const offset = Number(filters.offset || 0);
    if (!Number.isInteger(offset) || offset < 0) {
        throw Object.assign(new Error('offset must be non-negative'), {
            code: 'INVALID_QUERY',
            httpStatus: 400,
        });
    }
    const params = [companyId];
    const conditions = ['l.company_id = $1'];
    const add = (sql, value) => {
        if (value === undefined || value === null || value === '') return;
        params.push(value);
        conditions.push(sql.replace('?', `$${params.length}`));
    };
    add('l.status = ?', filters.status);
    add('l.job_source = ?', filters.source);
    const dateBounds = companyDateFilterBounds(
        filters.created_from,
        filters.created_to,
        filters.companyTimezone
    );
    add('l.created_at >= ?', dateBounds.fromInclusive);
    add('l.created_at < ?', dateBounds.toExclusive);
    if (filters.search) {
        params.push(`%${String(filters.search).trim()}%`);
        conditions.push(`(
            l.uuid ILIKE $${params.length}
            OR l.lead_seq::text ILIKE $${params.length}
            OR l.serial_id::text ILIKE $${params.length}
            OR CONCAT_WS(' ', l.first_name, l.last_name) ILIKE $${params.length}
            OR l.city ILIKE $${params.length}
            OR l.state ILIKE $${params.length}
            OR l.job_source ILIKE $${params.length}
        )`);
    }
    params.push(limit, offset);
    const { rows } = await db.query(
        `SELECT l.id,
                l.uuid,
                l.serial_id,
                l.lead_seq,
                l.public_code,
                l.status,
                l.job_source,
                l.first_name,
                l.last_name,
                l.city,
                l.state,
                l.created_at,
                l.converted_at,
                l.contact_id,
                l.converted_to_job,
                COUNT(*) OVER()::int AS _total
         FROM leads l
         WHERE ${conditions.join(' AND ')}
         ORDER BY l.created_at DESC, l.id DESC
         LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params
    );
    const total = Number(rows[0]?._total || 0);
    const results = rows.map(projectLeadSummary);
    return { results, pagination: offsetPagination(limit, offset, results, total) };
}

async function getAppLead(companyId, leadId) {
    requireCompanyId(companyId);
    const { rows } = await db.query(
        `SELECT l.id,
                l.uuid,
                l.serial_id,
                l.lead_seq,
                l.public_code,
                l.status,
                l.job_source,
                l.first_name,
                l.last_name,
                l.city,
                l.state,
                l.created_at,
                l.converted_at,
                l.contact_id,
                l.converted_to_job,
                l.phone,
                l.email,
                l.address,
                l.job_type,
                l.lead_notes
         FROM leads l
         WHERE l.id = $1 AND l.company_id = $2`,
        [leadId, companyId]
    );
    const row = rows[0];
    if (!row) return null;
    return {
        ...projectLeadSummary(row),
        phone: row.phone ?? null,
        email: row.email ?? null,
        address: row.address ?? null,
        job_type: row.job_type ?? null,
        lead_notes: row.lead_notes ?? null,
    };
}

function projectInvoiceSummary(row) {
    return {
        id: row.id,
        public_code: row.public_code ?? null,
        invoice_number: row.invoice_number,
        status: row.status,
        total: row.total,
        amount_paid: row.amount_paid,
        balance_due: row.balance_due,
        job_id: row.job_id ?? null,
        contact_id: row.contact_id ?? null,
        created_at: isoTimestamp(row.created_at),
        due_at: isoTimestamp(row.due_at),
    };
}

async function listAppInvoices(companyId, filters = {}) {
    requireCompanyId(companyId);
    const limit = bounded(filters.limit, 50, 100);
    const offset = Number(filters.offset || 0);
    if (!Number.isInteger(offset) || offset < 0) {
        throw Object.assign(new Error('offset must be non-negative'), {
            code: 'INVALID_QUERY',
            httpStatus: 400,
        });
    }
    const params = [companyId];
    const conditions = ['i.company_id = $1'];
    const add = (sql, value) => {
        if (value === undefined || value === null || value === '') return;
        params.push(value);
        conditions.push(sql.replace('?', `$${params.length}`));
    };
    add('i.status = ?', filters.status);
    add('i.job_id = ?', filters.job_id);
    const dateBounds = companyDateFilterBounds(
        filters.created_from,
        filters.created_to,
        filters.companyTimezone
    );
    add('i.created_at >= ?', dateBounds.fromInclusive);
    add('i.created_at < ?', dateBounds.toExclusive);
    params.push(limit, offset);
    const { rows } = await db.query(
        `SELECT i.id,
                i.public_code,
                i.invoice_number,
                i.status,
                i.total,
                i.amount_paid,
                (i.total - i.amount_paid) AS balance_due,
                i.job_id,
                i.contact_id,
                i.created_at,
                i.due_date AS due_at,
                COUNT(*) OVER()::int AS _total
         FROM invoices i
         WHERE ${conditions.join(' AND ')}
         ORDER BY i.created_at DESC, i.id DESC
         LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params
    );
    const total = Number(rows[0]?._total || 0);
    const results = rows.map(projectInvoiceSummary);
    return { results, pagination: offsetPagination(limit, offset, results, total) };
}

function projectPaymentSummary(row) {
    return {
        id: row.id,
        amount: row.amount,
        status: row.status,
        method: row.method ?? null,
        job_id: row.job_id ?? null,
        invoice_id: row.invoice_id ?? null,
        paid_at: isoTimestamp(row.paid_at),
    };
}

async function listAppPayments(companyId, filters = {}) {
    requireCompanyId(companyId);
    const limit = bounded(filters.limit, 50, 100);
    const offset = Number(filters.offset || 0);
    if (!Number.isInteger(offset) || offset < 0) {
        throw Object.assign(new Error('offset must be non-negative'), {
            code: 'INVALID_QUERY',
            httpStatus: 400,
        });
    }
    const params = [companyId];
    const conditions = ['t.company_id = $1'];
    const add = (sql, value) => {
        if (value === undefined || value === null || value === '') return;
        params.push(value);
        conditions.push(sql.replace('?', `$${params.length}`));
    };
    add('t.job_id = ?', filters.job_id);
    add('t.invoice_id = ?', filters.invoice_id);
    const dateBounds = companyDateFilterBounds(
        filters.paid_from,
        filters.paid_to,
        filters.companyTimezone
    );
    add('COALESCE(t.processed_at, t.created_at) >= ?', dateBounds.fromInclusive);
    add('COALESCE(t.processed_at, t.created_at) < ?', dateBounds.toExclusive);
    params.push(limit, offset);
    const { rows } = await db.query(
        `SELECT t.id,
                t.amount,
                t.status,
                t.payment_method AS method,
                t.job_id,
                t.invoice_id,
                COALESCE(t.processed_at, t.created_at) AS paid_at,
                COUNT(*) OVER()::int AS _total
         FROM payment_transactions t
         WHERE ${conditions.join(' AND ')}
         ORDER BY COALESCE(t.processed_at, t.created_at) DESC, t.id DESC
         LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params
    );
    const total = Number(rows[0]?._total || 0);
    const results = rows.map(projectPaymentSummary);
    return { results, pagination: offsetPagination(limit, offset, results, total) };
}

function projectEstimateSummary(row) {
    return {
        id: row.id,
        public_code: row.public_code ?? null,
        estimate_number: row.estimate_number,
        status: row.status,
        subtotal: row.subtotal,
        tax_amount: row.tax_amount,
        total: row.total,
        contact_id: row.contact_id ?? null,
        job_id: row.job_id ?? null,
        lead_id: row.lead_id ?? null,
        accepted_at: isoTimestamp(row.accepted_at),
        created_at: isoTimestamp(row.created_at),
        items_count: Number(row.items_count || 0),
        order_list_count: Number(row.order_list_count || 0),
    };
}

function projectEstimateItem(item = {}) {
    return {
        name: item.name,
        description: item.description ?? null,
        quantity: item.quantity,
        unit: item.unit ?? null,
        unit_price: item.unit_price,
        amount: item.amount,
        item_type: item.item_type ?? null,
    };
}

function projectOrderListItem(item = {}) {
    return {
        part_number: item.part_number,
        part_name: item.part_name,
        quantity: Number(item.quantity),
    };
}

async function listEstimates(companyId, filters = {}) {
    requireCompanyId(companyId);
    const limit = bounded(filters.limit, 50, 100);
    const offset = Number(filters.offset || 0);
    if (!Number.isInteger(offset) || offset < 0) throw Object.assign(new Error('offset must be non-negative'), { code: 'INVALID_QUERY', httpStatus: 400 });
    const params = [companyId];
    const conditions = ['e.company_id = $1', 'e.archived_at IS NULL'];
    const add = (sql, value) => {
        if (value === undefined || value === null || value === '') return;
        params.push(value);
        conditions.push(sql.replace('?', `$${params.length}`));
    };
    add('e.status = ?', filters.status);
    const dateBounds = companyDateFilterBounds(
        filters.accepted_from,
        filters.accepted_to,
        filters.companyTimezone
    );
    add('e.accepted_at >= ?', dateBounds.fromInclusive);
    add('e.accepted_at < ?', dateBounds.toExclusive);
    if (filters.search) {
        params.push(`%${String(filters.search).trim()}%`);
        conditions.push(`(e.estimate_number ILIKE $${params.length} OR e.summary ILIKE $${params.length} OR e.notes ILIKE $${params.length})`);
    }
    params.push(limit, offset);
    const { rows } = await db.query(
        `SELECT e.id,
                e.public_code,
                e.estimate_number,
                e.status,
                e.subtotal,
                e.tax_amount,
                e.total,
                e.contact_id,
                e.job_id,
                e.lead_id,
                e.accepted_at,
                e.created_at,
                (SELECT COUNT(*)::int
                 FROM estimate_items ei
                 JOIN estimates item_owner
                   ON item_owner.id = ei.estimate_id
                  AND item_owner.company_id = e.company_id
                 WHERE item_owner.id = e.id) AS items_count,
                COALESCE(jsonb_array_length(e.order_list), 0)::int AS order_list_count,
                COUNT(*) OVER()::int AS _total
         FROM estimates e
         WHERE ${conditions.join(' AND ')}
         ORDER BY e.created_at DESC, e.id DESC
         LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params
    );
    const total = Number(rows[0]?._total || 0);
    const results = rows.map(projectEstimateSummary);
    return {
        results,
        pagination: {
            mode: 'offset',
            limit,
            returned: results.length,
            has_more: offset + results.length < total,
            next_cursor: null,
            total,
        },
    };
}

async function getEstimate(companyId, estimateId) {
    requireCompanyId(companyId);
    const { rows } = await db.query(
        `SELECT e.id,
                e.public_code,
                e.estimate_number,
                e.status,
                e.subtotal,
                e.tax_amount,
                e.total,
                e.contact_id,
                e.job_id,
                e.lead_id,
                e.accepted_at,
                e.created_at,
                COALESCE(items.items_count, 0)::int AS items_count,
                COALESCE(jsonb_array_length(e.order_list), 0)::int AS order_list_count,
                COALESCE(items.items, '[]'::jsonb) AS items,
                e.order_list
         FROM estimates e
         LEFT JOIN LATERAL (
             SELECT COUNT(*)::int AS items_count,
                    jsonb_agg(jsonb_build_object(
                        'name', ei.name,
                        'description', ei.description,
                        'quantity', ei.quantity,
                        'unit', ei.unit,
                        'unit_price', ei.unit_price,
                        'amount', ei.amount,
                        'item_type', ei.item_type
                    ) ORDER BY ei.sort_order, ei.id) AS items
             FROM estimate_items ei
             JOIN estimates owner
               ON owner.id = ei.estimate_id
              AND owner.company_id = $2
             WHERE owner.id = e.id
         ) items ON true
         WHERE e.id = $1 AND e.company_id = $2`,
        [estimateId, companyId]
    );
    const row = rows[0];
    if (!row) return null;
    return {
        ...projectEstimateSummary(row),
        items: (Array.isArray(row.items) ? row.items : []).map(projectEstimateItem),
        order_list: (Array.isArray(row.order_list) ? row.order_list : []).map(projectOrderListItem),
    };
}

async function listInvoices(companyId, filters = {}) {
    const limit = bounded(filters.limit, 50, 100);
    const offset = Number(filters.offset || 0);
    if (!Number.isInteger(offset) || offset < 0) throw Object.assign(new Error('offset must be non-negative'), { code: 'INVALID_QUERY', httpStatus: 400 });
    const { params, conditions } = financeFilters(companyId, filters, 'i', false);
    if (filters.estimate_id) {
        params.push(filters.estimate_id);
        conditions.push(`i.estimate_id = $${params.length}`);
    }
    if (filters.search) {
        params.push(`%${String(filters.search).trim()}%`);
        conditions.push(`(i.invoice_number ILIKE $${params.length} OR i.title ILIKE $${params.length} OR i.notes ILIKE $${params.length})`);
    }
    params.push(limit, offset);
    const { rows } = await db.query(
        `SELECT i.*,
                c.full_name AS contact_name,
                j.job_number,
                l.serial_id AS lead_serial_id,
                e.estimate_number,
                COUNT(*) OVER()::int AS _total
         FROM invoices i
         LEFT JOIN contacts c ON c.id = i.contact_id AND c.company_id = i.company_id
         LEFT JOIN jobs j ON j.id = i.job_id AND j.company_id = i.company_id
         LEFT JOIN leads l ON l.id = i.lead_id AND l.company_id = i.company_id
         LEFT JOIN estimates e ON e.id = i.estimate_id AND e.company_id = i.company_id
         WHERE ${conditions.join(' AND ')}
         ORDER BY i.created_at DESC, i.id DESC
         LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params
    );
    const total = rows[0]?._total || 0;
    return { rows: rows.map(({ _total, ...row }) => row), total };
}

async function getInvoice(companyId, invoiceId, client = null) {
    requireCompanyId(companyId);
    const query = queryFor(client);
    const { rows } = await query(
        `SELECT i.*,
                c.full_name AS contact_name, c.email AS contact_email, c.phone_e164 AS contact_phone,
                j.job_number, l.serial_id AS lead_serial_id, e.estimate_number,
                COALESCE(items.items, '[]'::jsonb) AS items,
                COALESCE(payments.items, '[]'::jsonb) AS payments
         FROM invoices i
         LEFT JOIN contacts c ON c.id = i.contact_id AND c.company_id = i.company_id
         LEFT JOIN jobs j ON j.id = i.job_id AND j.company_id = i.company_id
         LEFT JOIN leads l ON l.id = i.lead_id AND l.company_id = i.company_id
         LEFT JOIN estimates e ON e.id = i.estimate_id AND e.company_id = i.company_id
         LEFT JOIN LATERAL (
             SELECT jsonb_agg(to_jsonb(ii) ORDER BY ii.sort_order, ii.id) AS items
             FROM invoice_items ii
             JOIN invoices owner
               ON owner.id = ii.invoice_id
              AND owner.company_id = $2
             WHERE owner.id = i.id
         ) items ON true
         LEFT JOIN LATERAL (
             SELECT jsonb_agg(jsonb_build_object(
                        'id', pt.id, 'status', pt.status, 'amount', pt.amount,
                        'currency', pt.currency, 'created_at', pt.created_at
                    ) ORDER BY pt.created_at DESC, pt.id DESC) AS items
             FROM payment_transactions pt
             JOIN invoices owner
               ON owner.id = pt.invoice_id
              AND owner.company_id = pt.company_id
             WHERE owner.id = i.id AND owner.company_id = $2
         ) payments ON true
         WHERE i.id = $1 AND i.company_id = $2`,
        [invoiceId, companyId]
    );
    return rows[0] || null;
}

async function listAssignees(companyId, limit = 100) {
    requireCompanyId(companyId);
    const pageLimit = bounded(limit, 100, 500);
    const { rows } = await db.query(
        `SELECT u.id, u.full_name AS name, u.email
         FROM company_memberships cm
         JOIN crm_users u
           ON u.id = cm.user_id
          AND u.company_id = cm.company_id
          AND u.status = 'active'
          AND COALESCE(u.kind, 'user') = 'user'
         WHERE cm.company_id = $1
           AND cm.status = 'active'
         ORDER BY u.full_name NULLS LAST, u.id
         LIMIT $2`,
        [companyId, pageLimit]
    );
    return { users: rows };
}

async function listCalls(companyId, filters = {}, providerScope = null) {
    requireCompanyId(companyId);
    const limit = bounded(filters.limit, 20, 50);
    const direction = filters.direction || null;
    if (direction && !['inbound', 'outbound'].includes(direction)) {
        throw Object.assign(new Error('direction must be inbound or outbound'), {
            code: 'INVALID_QUERY',
            httpStatus: 400,
        });
    }
    const contactId = filters.contact_id ?? null;
    if (contactId !== null && (!Number.isInteger(contactId) || contactId < 1)) {
        throw Object.assign(new Error('contact_id must be a positive integer'), {
            code: 'INVALID_QUERY',
            httpStatus: 400,
        });
    }
    const dateFrom = optionalIsoDate(filters.date_from, 'date_from');
    const dateTo = optionalIsoDate(filters.date_to, 'date_to');
    if (dateFrom && dateTo && dateFrom > dateTo) {
        throw Object.assign(new Error('date_from must not be after date_to'), {
            code: 'INVALID_QUERY',
            httpStatus: 400,
        });
    }

    const { rows } = await db.query(
        `SELECT c.id,
                c.direction,
                c.status,
                c.started_at,
                c.answered_at,
                c.ended_at,
                c.duration_sec,
                c.from_number,
                c.to_number,
                c.contact_id,
                co.full_name AS contact_name,
                c.answered_by,
                COUNT(*) OVER()::int AS _total
         FROM calls c
         JOIN companies tenant
           ON tenant.id = $1
          AND tenant.status = 'active'
         LEFT JOIN contacts co
           ON co.id = c.contact_id
          AND co.company_id = c.company_id
         WHERE c.company_id = tenant.id
           AND c.parent_call_sid IS NULL
           AND ($2::text IS NULL OR c.direction = $2)
           AND ($3::bigint IS NULL OR c.contact_id = $3)
           AND COALESCE(c.started_at, c.created_at) >= (
                COALESCE(
                    $4::date,
                    (CURRENT_TIMESTAMP AT TIME ZONE COALESCE(tenant.timezone, 'America/New_York'))::date - 13
                ) AT TIME ZONE COALESCE(tenant.timezone, 'America/New_York')
           )
           AND COALESCE(c.started_at, c.created_at) < (
                (
                    COALESCE(
                        $5::date,
                        (CURRENT_TIMESTAMP AT TIME ZONE COALESCE(tenant.timezone, 'America/New_York'))::date
                    ) + 1
                ) AT TIME ZONE COALESCE(tenant.timezone, 'America/New_York')
           )
           AND (
                $7::boolean = false
                OR (
                    $8::jsonb IS NOT NULL
                    AND EXISTS (
                        SELECT 1
                        FROM jobs visible_job
                        WHERE visible_job.company_id = c.company_id
                          AND visible_job.contact_id = c.contact_id
                          AND visible_job.assigned_provider_user_ids @> $8::jsonb
                    )
                )
           )
         ORDER BY c.started_at DESC NULLS LAST, c.id DESC
         LIMIT $6`,
        [
            companyId,
            direction,
            contactId,
            dateFrom,
            dateTo,
            limit,
            providerScope?.assignedOnly === true,
            providerScope?.assignedOnly && providerScope.userId
                ? JSON.stringify([String(providerScope.userId)])
                : null,
        ]
    );
    const total = rows[0]?._total || 0;
    return {
        rows: rows.map(({ _total, ...row }) => row),
        total,
    };
}

module.exports = {
    bounded,
    getJob,
    getLead,
    getContact,
    getContactHistory,
    listAppLeads,
    getAppLead,
    listAppInvoices,
    listAppPayments,
    listEstimates,
    getEstimate,
    listInvoices,
    getInvoice,
    listAssignees,
    listCalls,
};
