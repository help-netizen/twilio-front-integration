/**
 * Estimates Queries Module
 * PF002-R2 Estimates Composer Refresh
 */
const db = require('./connection');

function toNumber(value, fallback = 0) {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
}

function normalizeDiscountType(type) {
    return type === 'fixed' || type === 'percentage' ? type : null;
}

function stripTotal(row) {
    if (!row) return row;
    const { _total, ...rest } = row;
    return rest;
}

async function listEstimates(companyId, filters = {}) {
    const {
        status,
        contactId,
        leadId,
        jobId,
        search,
        startDate,
        endDate,
        includeArchived = false,
        limit = 50,
        offset = 0,
    } = filters;

    const conditions = ['e.company_id = $1'];
    const params = [companyId];
    let idx = 1;

    if (!includeArchived) conditions.push('e.archived_at IS NULL');
    if (status) {
        idx++;
        conditions.push(`e.status = $${idx}`);
        params.push(status);
    }
    if (contactId) {
        idx++;
        conditions.push(`e.contact_id = $${idx}`);
        params.push(contactId);
    }
    if (leadId) {
        idx++;
        conditions.push(`e.lead_id = $${idx}`);
        params.push(leadId);
    }
    if (jobId) {
        idx++;
        conditions.push(`e.job_id = $${idx}`);
        params.push(jobId);
    }
    if (search) {
        idx++;
        conditions.push(`(
            e.estimate_number ILIKE $${idx}
            OR e.summary ILIKE $${idx}
            OR e.notes ILIKE $${idx}
            OR c.full_name ILIKE $${idx}
            OR j.job_number ILIKE $${idx}
        )`);
        params.push(`%${search}%`);
    }
    if (startDate) {
        idx++;
        conditions.push(`e.created_at >= $${idx}`);
        params.push(startDate);
    }
    if (endDate) {
        idx++;
        conditions.push(`e.created_at <= $${idx}`);
        params.push(endDate);
    }

    idx++;
    params.push(limit);
    const limitIdx = idx;
    idx++;
    params.push(offset);
    const offsetIdx = idx;

    const { rows } = await db.query(
        `SELECT e.*,
                c.full_name AS contact_name,
                j.job_number AS job_number,
                inv.id AS invoice_id,
                inv.invoice_number AS invoice_number,
                COUNT(*) OVER() AS _total
         FROM estimates e
         LEFT JOIN contacts c ON c.id = e.contact_id
         LEFT JOIN jobs j ON j.id = e.job_id AND j.company_id = e.company_id
         LEFT JOIN LATERAL (
            SELECT id, invoice_number
            FROM invoices
            WHERE estimate_id = e.id AND company_id = e.company_id
            ORDER BY created_at DESC
            LIMIT 1
         ) inv ON true
         WHERE ${conditions.join(' AND ')}
         ORDER BY e.created_at DESC
         LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
        params
    );

    return {
        rows: rows.map(stripTotal),
        total: rows.length > 0 ? parseInt(rows[0]._total, 10) : 0,
    };
}

async function getEstimateById(companyId, id) {
    const { rows } = await db.query(
        `SELECT e.*,
                c.full_name AS contact_name,
                c.email AS contact_email,
                c.phone_e164 AS contact_phone,
                j.job_number AS job_number,
                j.address AS service_address,
                COALESCE(
                    NULLIF(CONCAT_WS(', ',
                        NULLIF(CONCAT_WS(', ', ca.street_line1, ca.street_line2), ''),
                        NULLIF(CONCAT_WS(' ', ca.city, NULLIF(CONCAT_WS(' ', ca.state, ca.postal_code), '')), ''),
                        ca.country
                    ), ''),
                    j.address,
                    NULLIF(CONCAT_WS(', ',
                        NULLIF(CONCAT_WS(', ', l.address, l.unit), ''),
                        NULLIF(CONCAT_WS(' ', l.city, NULLIF(CONCAT_WS(' ', l.state, l.postal_code), '')), ''),
                        l.country
                    ), '')
                ) AS billing_address,
                l.serial_id AS lead_serial_id,
                inv.id AS invoice_id,
                inv.invoice_number AS invoice_number
         FROM estimates e
         LEFT JOIN contacts c ON c.id = e.contact_id
         LEFT JOIN jobs j ON j.id = e.job_id AND j.company_id = e.company_id
         LEFT JOIN leads l ON l.id = e.lead_id AND l.company_id = e.company_id
         LEFT JOIN LATERAL (
            SELECT street_line1, street_line2, city, state, postal_code, country
            FROM contact_addresses
            WHERE contact_id = e.contact_id
            ORDER BY is_primary DESC, created_at ASC
            LIMIT 1
         ) ca ON true
         LEFT JOIN LATERAL (
            SELECT id, invoice_number
            FROM invoices
            WHERE estimate_id = e.id AND company_id = e.company_id
            ORDER BY created_at DESC
            LIMIT 1
         ) inv ON true
         WHERE e.id = $1 AND e.company_id = $2`,
        [id, companyId]
    );
    return rows[0] || null;
}

async function getJobContext(companyId, jobId) {
    const { rows } = await db.query(
        `SELECT j.id,
                j.company_id,
                j.lead_id,
                j.contact_id,
                j.job_number,
                j.service_name,
                l.serial_id AS lead_serial_id
         FROM jobs j
         LEFT JOIN leads l ON l.id = j.lead_id AND l.company_id = j.company_id
         WHERE j.id = $1 AND j.company_id = $2`,
        [jobId, companyId]
    );
    return rows[0] || null;
}

async function getLeadContext(companyId, leadId) {
    const { rows } = await db.query(
        `SELECT id, company_id, contact_id, serial_id, first_name, last_name, email, phone
         FROM leads
         WHERE id = $1 AND company_id = $2`,
        [leadId, companyId]
    );
    return rows[0] || null;
}

async function nextEstimateSequence(companyId, { jobId, leadId }) {
    const params = [companyId];
    let clause = '';
    if (jobId) {
        params.push(jobId);
        clause = 'job_id = $2';
    } else {
        params.push(leadId);
        clause = 'lead_id = $2 AND job_id IS NULL';
    }

    const { rows } = await db.query(
        `SELECT COALESCE(MAX(estimate_sequence), 0) + 1 AS next_sequence
         FROM estimates
         WHERE company_id = $1 AND ${clause}`,
        params
    );
    return parseInt(rows[0]?.next_sequence || '1', 10);
}

function buildEstimateNumber({ leadSerialId, sequence }) {
    return `ESTIMATE L-${leadSerialId || '0'}-${sequence}`;
}

async function createEstimate(companyId, data) {
    const {
        contact_id,
        lead_id,
        job_id,
        estimate_number,
        estimate_sequence,
        summary,
        notes,
        internal_note,
        tax_rate,
        discount_type,
        discount_value,
        currency,
        signature_required,
        created_by,
    } = data;

    const { rows } = await db.query(
        `INSERT INTO estimates (
            company_id, contact_id, lead_id, job_id,
            estimate_number, estimate_sequence, summary, notes, internal_note, status,
            tax_rate, discount_type, discount_value, discount_amount,
            subtotal, tax_amount, total, currency, signature_required,
            created_by, updated_by
        )
        VALUES (
            $1, $2, $3, $4,
            $5, COALESCE($6, 1), $7, $8, $9, 'draft',
            COALESCE($10::numeric, 0), $11, COALESCE($12::numeric, 0), 0,
            0, 0, 0, COALESCE($13, 'USD'), COALESCE($14, false),
            $15, $15
        )
        RETURNING *`,
        [
            companyId,
            contact_id,
            lead_id || null,
            job_id || null,
            estimate_number,
            estimate_sequence || 1,
            summary || null,
            notes || null,
            internal_note || null,
            tax_rate != null ? tax_rate : 0,
            normalizeDiscountType(discount_type),
            discount_value != null ? discount_value : 0,
            currency || 'USD',
            !!signature_required,
            created_by || null,
        ]
    );
    return rows[0];
}

async function updateEstimate(id, companyId, data) {
    const allowedFields = [
        'contact_id', 'lead_id', 'job_id', 'estimate_number', 'estimate_sequence',
        'summary', 'notes', 'internal_note', 'tax_rate', 'discount_type',
        'discount_value', 'discount_amount', 'currency', 'signature_required',
        'signature_name', 'signature_consented_at', 'approved_snapshot', 'status',
        'sent_at', 'accepted_at', 'declined_at', 'updated_by',
    ];

    const sets = [];
    const params = [id, companyId];
    let idx = 2;

    for (const field of allowedFields) {
        if (data[field] !== undefined) {
            idx++;
            sets.push(`${field} = $${idx}`);
            params.push(data[field]);
        }
    }

    if (sets.length === 0) return getEstimateById(companyId, id);
    sets.push('updated_at = NOW()');

    const { rows } = await db.query(
        `UPDATE estimates
         SET ${sets.join(', ')}
         WHERE id = $1 AND company_id = $2
         RETURNING *`,
        params
    );
    return rows[0] || null;
}

async function archiveEstimate(id, companyId, archivedBy) {
    const { rows } = await db.query(
        `UPDATE estimates
         SET archived_at = NOW(), archived_by = $3, updated_at = NOW()
         WHERE id = $1 AND company_id = $2 AND archived_at IS NULL
         RETURNING *`,
        [id, companyId, archivedBy || null]
    );
    return rows[0] || null;
}

async function restoreEstimate(id, companyId, restoredBy) {
    const { rows } = await db.query(
        `UPDATE estimates
         SET archived_at = NULL, archived_by = NULL, status = 'draft', updated_by = $3, updated_at = NOW()
         WHERE id = $1 AND company_id = $2 AND archived_at IS NOT NULL
         RETURNING *`,
        [id, companyId, restoredBy || null]
    );
    return rows[0] || null;
}

async function updateEstimateStatus(id, companyId, status, timestampField) {
    const sets = ['status = $3', 'updated_at = NOW()'];
    if (timestampField) sets.push(`${timestampField} = NOW()`);
    const { rows } = await db.query(
        `UPDATE estimates SET ${sets.join(', ')}
         WHERE id = $1 AND company_id = $2
         RETURNING *`,
        [id, companyId, status]
    );
    return rows[0] || null;
}

async function getEstimateItems(estimateId) {
    const { rows } = await db.query(
        `SELECT * FROM estimate_items WHERE estimate_id = $1 ORDER BY sort_order ASC, id ASC`,
        [estimateId]
    );
    return rows;
}

async function addEstimateItem(estimateId, item) {
    const quantity = toNumber(item.quantity, 1);
    const unitPrice = toNumber(item.unit_price, 0);
    const amount = Number((quantity * unitPrice).toFixed(2));

    const { rows } = await db.query(
        `INSERT INTO estimate_items (
            estimate_id, sort_order, name, description, quantity, unit, unit_price,
            amount, taxable, metadata, item_type, category_id, price_book_item_id
        )
        VALUES (
            $1,
            COALESCE($2, (SELECT COALESCE(MAX(sort_order), -1) + 1 FROM estimate_items WHERE estimate_id = $1)),
            $3, $4, $5, $6, $7, $8, COALESCE($9, false), COALESCE($10::jsonb, '{}'::jsonb),
            $11, $12, $13
        )
        RETURNING *`,
        [
            estimateId,
            item.sort_order != null ? item.sort_order : null,
            item.name,
            item.description || null,
            quantity,
            item.unit || null,
            unitPrice,
            amount,
            !!item.taxable,
            JSON.stringify(item.metadata || {}),
            item.item_type || null,
            item.category_id || null,
            item.price_book_item_id || null,
        ]
    );
    return rows[0];
}

async function updateEstimateItem(itemId, data) {
    const current = await db.query(`SELECT * FROM estimate_items WHERE id = $1`, [itemId]);
    if (!current.rows[0]) return null;

    const next = { ...current.rows[0], ...data };
    const quantity = toNumber(next.quantity, 1);
    const unitPrice = toNumber(next.unit_price, 0);
    const amount = Number((quantity * unitPrice).toFixed(2));

    const { rows } = await db.query(
        `UPDATE estimate_items
         SET name = $2,
             description = $3,
             quantity = $4,
             unit = $5,
             unit_price = $6,
             amount = $7,
             taxable = $8,
             sort_order = $9,
             metadata = COALESCE($10::jsonb, '{}'::jsonb),
             item_type = $11,
             category_id = $12,
             price_book_item_id = $13,
             updated_at = NOW()
         WHERE id = $1
         RETURNING *`,
        [
            itemId,
            next.name,
            next.description || null,
            quantity,
            next.unit || null,
            unitPrice,
            amount,
            !!next.taxable,
            next.sort_order || 0,
            JSON.stringify(next.metadata || {}),
            next.item_type || null,
            next.category_id || null,
            next.price_book_item_id || null,
        ]
    );
    return rows[0] || null;
}

async function deleteEstimateItem(itemId) {
    const { rowCount } = await db.query(`DELETE FROM estimate_items WHERE id = $1`, [itemId]);
    return rowCount > 0;
}

async function replaceEstimateItems(estimateId, items = []) {
    await db.query(`DELETE FROM estimate_items WHERE estimate_id = $1`, [estimateId]);
    const created = [];
    for (let i = 0; i < items.length; i++) {
        created.push(await addEstimateItem(estimateId, { ...items[i], sort_order: i }));
    }
    return created;
}

async function recalculateEstimateTotals(estimateId) {
    const { rows } = await db.query(
        `WITH item_totals AS (
            SELECT
                estimate_id,
                COALESCE(SUM(amount), 0) AS subtotal,
                COALESCE(SUM(CASE WHEN taxable THEN amount ELSE 0 END), 0) AS taxable_subtotal
            FROM estimate_items
            WHERE estimate_id = $1
            GROUP BY estimate_id
        ),
        calc AS (
            SELECT
                e.id,
                COALESCE(it.subtotal, 0) AS subtotal,
                CASE
                    WHEN e.discount_type = 'percentage'
                        THEN ROUND(COALESCE(it.subtotal, 0) * LEAST(GREATEST(COALESCE(e.discount_value, 0), 0), 100) / 100, 2)
                    WHEN e.discount_type = 'fixed'
                        THEN LEAST(GREATEST(COALESCE(e.discount_value, 0), 0), COALESCE(it.subtotal, 0))
                    ELSE 0
                END AS discount_amount,
                COALESCE(it.taxable_subtotal, 0) AS taxable_subtotal
            FROM estimates e
            LEFT JOIN item_totals it ON it.estimate_id = e.id
            WHERE e.id = $1
        )
        UPDATE estimates e
        SET subtotal = calc.subtotal,
            discount_amount = calc.discount_amount,
            tax_amount = ROUND(GREATEST(calc.taxable_subtotal - calc.discount_amount, 0) * COALESCE(e.tax_rate, 0) / 100, 2),
            total = ROUND(calc.subtotal - calc.discount_amount + (GREATEST(calc.taxable_subtotal - calc.discount_amount, 0) * COALESCE(e.tax_rate, 0) / 100), 2),
            updated_at = NOW()
        FROM calc
        WHERE e.id = calc.id
        RETURNING e.*`,
        [estimateId]
    );
    return rows[0] || null;
}

async function createRevision(estimateId, snapshot, createdBy) {
    const { rows } = await db.query(
        `INSERT INTO estimate_revisions (estimate_id, revision_number, snapshot, created_by)
         VALUES (
            $1,
            COALESCE((SELECT MAX(revision_number) + 1 FROM estimate_revisions WHERE estimate_id = $1), 1),
            $2,
            $3
         )
         RETURNING *`,
        [estimateId, JSON.stringify(snapshot), createdBy || null]
    );
    return rows[0];
}

async function listRevisions(estimateId) {
    const { rows } = await db.query(
        `SELECT * FROM estimate_revisions WHERE estimate_id = $1 ORDER BY revision_number DESC`,
        [estimateId]
    );
    return rows;
}

async function createEvent(estimateId, eventType, actorType, actorId, metadata) {
    const { rows } = await db.query(
        `INSERT INTO estimate_events (estimate_id, event_type, actor_type, actor_id, metadata)
         VALUES ($1, $2, $3, $4, COALESCE($5::jsonb, '{}'::jsonb))
         RETURNING *`,
        [estimateId, eventType, actorType || 'user', actorId || null, JSON.stringify(metadata || {})]
    );
    return rows[0];
}

async function listEvents(estimateId) {
    const { rows } = await db.query(
        `SELECT * FROM estimate_events WHERE estimate_id = $1 ORDER BY created_at DESC`,
        [estimateId]
    );
    return rows;
}

module.exports = {
    listEstimates,
    getEstimateById,
    getJobContext,
    getLeadContext,
    nextEstimateSequence,
    buildEstimateNumber,
    createEstimate,
    updateEstimate,
    archiveEstimate,
    restoreEstimate,
    updateEstimateStatus,
    getEstimateItems,
    addEstimateItem,
    updateEstimateItem,
    deleteEstimateItem,
    replaceEstimateItems,
    recalculateEstimateTotals,
    createRevision,
    listRevisions,
    createEvent,
    listEvents,
};
