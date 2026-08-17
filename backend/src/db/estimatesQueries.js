/**
 * Estimates Queries Module
 * PF002-R2 Estimates Composer Refresh
 */
const db = require('./connection');
const { applyEstimatePayments } = require('./documentPaymentQueries');

function queryFor(client) {
    return client?.query ? client.query.bind(client) : db.query;
}

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
                COALESCE(NULLIF(c.full_name, ''),
                    CASE WHEN e.contact_id IS NULL THEN NULLIF(j.customer_name, '') END
                ) AS contact_name,
                COALESCE(NULLIF(c.email, ''),
                    CASE WHEN e.contact_id IS NULL THEN NULLIF(j.customer_email, '') END
                ) AS contact_email,
                COALESCE(NULLIF(c.phone_e164, ''),
                    CASE WHEN e.contact_id IS NULL THEN NULLIF(j.customer_phone, '') END
                ) AS contact_phone,
                j.job_number AS job_number,
                viewed.viewed_at AS viewed_at,
                inv.id AS invoice_id,
                inv.invoice_number AS invoice_number,
                COUNT(*) OVER() AS _total
         FROM estimates e
         LEFT JOIN jobs j ON j.id = e.job_id AND j.company_id = e.company_id
         LEFT JOIN contacts c
           ON c.id = COALESCE(e.contact_id, j.contact_id)
          AND c.company_id = e.company_id
         LEFT JOIN LATERAL (
            SELECT ee.created_at AS viewed_at
            FROM estimate_events ee
            JOIN estimates event_owner
              ON event_owner.id = ee.estimate_id
             AND event_owner.company_id = e.company_id
            WHERE ee.estimate_id = e.id
              AND ee.event_type = 'viewed'
            ORDER BY ee.created_at ASC
            LIMIT 1
         ) viewed ON true
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
        rows: await applyEstimatePayments(companyId, rows.map(stripTotal)),
        total: rows.length > 0 ? parseInt(rows[0]._total, 10) : 0,
    };
}

async function getEstimateById(companyId, id, client = null) {
    const query = queryFor(client);
    const { rows } = await query(
        `SELECT e.*,
                COALESCE(NULLIF(c.full_name, ''),
                    CASE WHEN e.contact_id IS NULL THEN NULLIF(j.customer_name, '') END
                ) AS contact_name,
                COALESCE(NULLIF(c.email, ''),
                    CASE WHEN e.contact_id IS NULL THEN NULLIF(j.customer_email, '') END
                ) AS contact_email,
                COALESCE(NULLIF(c.phone_e164, ''),
                    CASE WHEN e.contact_id IS NULL THEN NULLIF(j.customer_phone, '') END
                ) AS contact_phone,
                j.job_number AS job_number,
                j.job_seq AS job_seq,
                j.public_code AS job_public_code,
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
         LEFT JOIN jobs j ON j.id = e.job_id AND j.company_id = e.company_id
         LEFT JOIN contacts c
           ON c.id = COALESCE(e.contact_id, j.contact_id)
          AND c.company_id = e.company_id
         LEFT JOIN leads l ON l.id = e.lead_id AND l.company_id = e.company_id
         LEFT JOIN LATERAL (
            SELECT street_line1, street_line2, city, state, postal_code, country
            FROM contact_addresses ca_owned
            JOIN contacts ca_contact
              ON ca_contact.id = ca_owned.contact_id
             AND ca_contact.company_id = e.company_id
            WHERE ca_owned.contact_id = e.contact_id
            ORDER BY ca_owned.is_primary DESC, ca_owned.created_at ASC
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
    if (!rows[0]) return null;
    const [estimate] = await applyEstimatePayments(companyId, [rows[0]], client);
    return estimate;
}

/** Deliberately global resolver for a durable estimate public_code. */
async function getEstimateByCode(publicCode, client = null) {
    const query = queryFor(client);
    const { rows } = await query(
        `SELECT e.id, e.company_id, e.public_code, e.estimate_number
         FROM estimates e
         WHERE e.public_code = $1`,
        [publicCode]
    );
    return rows[0] || null;
}

/**
 * Serialize canonical Estimate-to-Invoice conversion on the tenant-owned
 * Estimate row. The caller must hold a transaction on `client`.
 */
async function lockEstimateForConversion(companyId, id, client) {
    if (!client?.query) {
        throw Object.assign(new Error('Conversion transaction is required'), {
            code: 'TRANSACTION_REQUIRED',
        });
    }
    const { rows } = await client.query(
        `SELECT id
         FROM estimates
         WHERE id = $1 AND company_id = $2
         FOR UPDATE`,
        [id, companyId]
    );
    return rows[0] || null;
}

/**
 * Load the exact conversion audit record authorized for Undo. The database
 * clock owns expiry so application/server clock skew cannot extend the window.
 */
async function getConversionEventForUndo(
    companyId,
    estimateId,
    invoiceId,
    undoWindowSeconds,
    client = null
) {
    const query = queryFor(client);
    const { rows } = await query(
        `SELECT ee.id,
                ee.created_at,
                ee.metadata,
                ee.created_at <= NOW() - ($4::INTEGER * INTERVAL '1 second') AS undo_expired
         FROM estimate_events ee
         JOIN estimates e
           ON e.id = ee.estimate_id
          AND e.company_id = $1
         JOIN invoices i
           ON i.id = $3
          AND i.company_id = e.company_id
          AND i.estimate_id = e.id
         WHERE ee.estimate_id = $2
           AND ee.event_type = 'converted_to_invoice'
           AND ee.metadata->>'invoice_id' = $3::TEXT
         ORDER BY ee.created_at DESC, ee.id DESC
         LIMIT 1`,
        [companyId, estimateId, invoiceId, undoWindowSeconds]
    );
    return rows[0] || null;
}

async function getJobContext(companyId, jobId, client = null) {
    const query = queryFor(client);
    const { rows } = await query(
        `SELECT j.id,
                j.company_id,
                j.lead_id,
                j.contact_id,
                j.job_number,
                j.job_seq,
                j.service_name,
                l.serial_id AS lead_serial_id,
                l.lead_seq AS lead_seq
         FROM jobs j
         LEFT JOIN leads l ON l.id = j.lead_id AND l.company_id = j.company_id
         WHERE j.id = $1 AND j.company_id = $2`,
        [jobId, companyId]
    );
    return rows[0] || null;
}

async function getLeadContext(companyId, leadId, client = null) {
    const query = queryFor(client);
    const { rows } = await query(
        `SELECT id, company_id, contact_id, serial_id, lead_seq,
                first_name, last_name, email, phone
         FROM leads
         WHERE id = $1 AND company_id = $2`,
        [leadId, companyId]
    );
    return rows[0] || null;
}

async function getContactContext(companyId, contactId, client = null) {
    const query = queryFor(client);
    const { rows } = await query(
        `SELECT id, company_id, full_name
         FROM contacts
         WHERE id = $1 AND company_id = $2`,
        [contactId, companyId]
    );
    return rows[0] || null;
}

function estimateNumberPrefix({ leadSeq, jobSeq }) {
    if (jobSeq) return `ESTIMATE ${jobSeq}-`;
    if (leadSeq) return `ESTIMATE L${leadSeq}-`;
    return 'ESTIMATE L0-';
}

function legacyEstimateNumberPrefix(legacyLeadSerialId) {
    return `ESTIMATE L-${legacyLeadSerialId || '0'}-`;
}

async function nextEstimateSequence(
    companyId,
    {
        leadSeq = null,
        jobSeq = null,
        legacyLeadSerialId = null,
        leadId = null,
        jobId = null,
    },
    client = null
) {
    const query = queryFor(client);
    const newPrefix = estimateNumberPrefix({ leadSeq, jobSeq });
    const legacyPrefix = legacyEstimateNumberPrefix(legacyLeadSerialId);
    // New-format rows are counted by their exact number namespace. The matching
    // parent's legacy rows seed the same MAX so numbering never restarts after
    // the format cutover.
    const { rows } = await query(
        `SELECT COALESCE(MAX(estimate_sequence), 0) + 1 AS next_sequence
         FROM estimates
         WHERE company_id = $1
           AND (
                estimate_number LIKE $2
                OR (
                    estimate_number LIKE $3
                    AND (
                        ($4::BIGINT IS NOT NULL AND job_id = $4)
                        OR ($5::BIGINT IS NOT NULL AND lead_id = $5 AND job_id IS NULL)
                        OR ($4::BIGINT IS NULL AND $5::BIGINT IS NULL
                            AND job_id IS NULL AND lead_id IS NULL)
                    )
                )
           )`,
        [companyId, `${newPrefix}%`, `${legacyPrefix}%`, jobId, leadId]
    );
    return parseInt(rows[0]?.next_sequence || '1', 10);
}

function buildEstimateNumber({ leadSeq, jobSeq, sequence }) {
    return `${estimateNumberPrefix({ leadSeq, jobSeq })}${sequence}`;
}

async function createEstimate(companyId, data, client = null) {
    const query = queryFor(client);
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
        order_list,
        created_by,
    } = data;

    const { rows } = await query(
        `INSERT INTO estimates (
            company_id, contact_id, lead_id, job_id,
            estimate_number, estimate_sequence, summary, notes, internal_note, status,
            tax_rate, discount_type, discount_value, discount_amount,
            subtotal, tax_amount, total, currency, signature_required,
            order_list, created_by, updated_by
        )
        VALUES (
            $1, $2, $3, $4,
            $5, COALESCE($6, 1), $7, $8, $9, 'draft',
            COALESCE($10::numeric, 0), $11, COALESCE($12::numeric, 0), 0,
            0, 0, 0, COALESCE($13, 'USD'), COALESCE($14, false),
            COALESCE($15::jsonb, '[]'::jsonb), $16, $16
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
            JSON.stringify(order_list || []),
            created_by || null,
        ]
    );
    return rows[0];
}

async function updateEstimate(id, companyId, data, client = null) {
    const query = queryFor(client);
    const allowedFields = [
        'contact_id', 'lead_id', 'job_id', 'estimate_number', 'estimate_sequence',
        'summary', 'notes', 'internal_note', 'tax_rate', 'discount_type',
        'discount_value', 'discount_amount', 'currency', 'signature_required',
        'signature_name', 'signature_consented_at', 'approved_snapshot', 'status',
        'sent_at', 'accepted_at', 'declined_at', 'updated_by', 'order_list',
    ];

    const sets = [];
    const params = [id, companyId];
    let idx = 2;

    for (const field of allowedFields) {
        if (data[field] !== undefined) {
            idx++;
            sets.push(`${field} = $${idx}${field === 'order_list' ? '::jsonb' : ''}`);
            params.push(field === 'order_list' ? JSON.stringify(data[field]) : data[field]);
        }
    }

    if (sets.length === 0) return getEstimateById(companyId, id, client);
    sets.push('updated_at = NOW()');

    const { rows } = await query(
        `UPDATE estimates
         SET ${sets.join(', ')}
         WHERE id = $1 AND company_id = $2
         RETURNING *`,
        params
    );
    return rows[0] || null;
}

async function archiveEstimate(id, companyId, archivedBy, client = null) {
    const query = queryFor(client);
    const { rows } = await query(
        `UPDATE estimates
         SET archived_at = NOW(), archived_by = $3, updated_at = NOW()
         WHERE id = $1 AND company_id = $2 AND archived_at IS NULL
         RETURNING *`,
        [id, companyId, archivedBy || null]
    );
    return rows[0] || null;
}

async function restoreEstimate(id, companyId, restoredBy, client = null) {
    const query = queryFor(client);
    const { rows } = await query(
        `UPDATE estimates
         SET archived_at = NULL, archived_by = NULL, status = 'draft', updated_by = $3, updated_at = NOW()
         WHERE id = $1 AND company_id = $2 AND archived_at IS NOT NULL
         RETURNING *`,
        [id, companyId, restoredBy || null]
    );
    return rows[0] || null;
}

async function updateEstimateStatus(id, companyId, status, timestampField, client = null) {
    const query = queryFor(client);
    const sets = ['status = $3', 'updated_at = NOW()'];
    if (timestampField) sets.push(`${timestampField} = NOW()`);
    const { rows } = await query(
        `UPDATE estimates SET ${sets.join(', ')}
         WHERE id = $1 AND company_id = $2
         RETURNING *`,
        [id, companyId, status]
    );
    return rows[0] || null;
}

async function getEstimateItems(companyId, estimateId, client = null) {
    const query = queryFor(client);
    const { rows } = await query(
        `SELECT ei.*
         FROM estimate_items ei
         JOIN estimates e
           ON e.id = ei.estimate_id
          AND e.company_id = $1
         WHERE ei.estimate_id = $2
         ORDER BY ei.sort_order ASC, ei.id ASC`,
        [companyId, estimateId]
    );
    return rows;
}

async function addEstimateItem(companyId, estimateId, item, client = null) {
    const query = queryFor(client);
    const quantity = toNumber(item.quantity, 1);
    const unitPrice = toNumber(item.unit_price, 0);
    const amount = Number((quantity * unitPrice).toFixed(2));

    const { rows } = await query(
        `INSERT INTO estimate_items (
            estimate_id, sort_order, name, description, quantity, unit, unit_price,
            amount, taxable, metadata, item_type, category_id, price_book_item_id
        )
        SELECT
            e.id,
            COALESCE($3, (SELECT COALESCE(MAX(sort_order), -1) + 1 FROM estimate_items WHERE estimate_id = e.id)),
            $4, $5, $6, $7, $8, $9, COALESCE($10, false), COALESCE($11::jsonb, '{}'::jsonb),
            $12, $13, $14
        FROM estimates e
        WHERE e.id = $2 AND e.company_id = $1
        RETURNING *`,
        [
            companyId,
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

async function updateEstimateItem(companyId, estimateId, itemId, data, client = null) {
    const query = queryFor(client);
    const current = await query(
        `SELECT ei.*
         FROM estimate_items ei
         JOIN estimates e
           ON e.id = ei.estimate_id
          AND e.company_id = $1
         WHERE ei.id = $2 AND ei.estimate_id = $3`,
        [companyId, itemId, estimateId]
    );
    if (!current.rows[0]) return null;

    const next = { ...current.rows[0], ...data };
    const quantity = toNumber(next.quantity, 1);
    const unitPrice = toNumber(next.unit_price, 0);
    const amount = Number((quantity * unitPrice).toFixed(2));

    const { rows } = await query(
        `UPDATE estimate_items
         SET name = $4,
             description = $5,
             quantity = $6,
             unit = $7,
             unit_price = $8,
             amount = $9,
             taxable = $10,
             sort_order = $11,
             metadata = COALESCE($12::jsonb, '{}'::jsonb),
             item_type = $13,
             category_id = $14,
             price_book_item_id = $15,
             updated_at = NOW()
         WHERE id = $2
           AND estimate_id = $3
           AND EXISTS (
                SELECT 1
                FROM estimates e
                WHERE e.id = estimate_items.estimate_id
                  AND e.company_id = $1
           )
         RETURNING *`,
        [
            companyId,
            itemId,
            estimateId,
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

async function deleteEstimateItem(companyId, estimateId, itemId, client = null) {
    const query = queryFor(client);
    const { rowCount } = await query(
        `DELETE FROM estimate_items
         WHERE id = $2
           AND estimate_id = $3
           AND EXISTS (
                SELECT 1
                FROM estimates e
                WHERE e.id = estimate_items.estimate_id
                  AND e.company_id = $1
           )`,
        [companyId, itemId, estimateId]
    );
    return rowCount > 0;
}

async function replaceEstimateItems(companyId, estimateId, items = [], client = null) {
    const query = queryFor(client);
    await query(
        `DELETE FROM estimate_items
         WHERE estimate_id = $2
           AND EXISTS (
                SELECT 1
                FROM estimates e
                WHERE e.id = estimate_items.estimate_id
                  AND e.company_id = $1
           )`,
        [companyId, estimateId]
    );
    const created = [];
    for (let i = 0; i < items.length; i++) {
        created.push(await addEstimateItem(
            companyId,
            estimateId,
            { ...items[i], sort_order: i },
            client
        ));
    }
    return created;
}

async function recalculateEstimateTotals(companyId, estimateId, client = null) {
    const query = queryFor(client);
    const { rows } = await query(
        `WITH item_totals AS (
            SELECT
                estimate_id,
                COALESCE(SUM(amount), 0) AS subtotal,
                COALESCE(SUM(CASE WHEN taxable THEN amount ELSE 0 END), 0) AS taxable_subtotal
            FROM estimate_items
            JOIN estimates item_owner
              ON item_owner.id = estimate_items.estimate_id
             AND item_owner.company_id = $1
            WHERE estimate_id = $2
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
            WHERE e.id = $2 AND e.company_id = $1
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
        [companyId, estimateId]
    );
    return rows[0] || null;
}

async function createRevision(companyId, estimateId, snapshot, createdBy, client = null) {
    const query = queryFor(client);
    const { rows } = await query(
        `INSERT INTO estimate_revisions (estimate_id, revision_number, snapshot, created_by)
         SELECT
            e.id,
            COALESCE((SELECT MAX(revision_number) + 1 FROM estimate_revisions WHERE estimate_id = e.id), 1),
            $3,
            $4
         FROM estimates e
         WHERE e.id = $2 AND e.company_id = $1
         RETURNING *`,
        [companyId, estimateId, JSON.stringify(snapshot), createdBy || null]
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

async function createEvent(companyId, estimateId, eventType, actorType, actorId, metadata, client = null) {
    const query = queryFor(client);
    const { rows } = await query(
        `INSERT INTO estimate_events (estimate_id, event_type, actor_type, actor_id, metadata)
         SELECT e.id, $3, $4, $5, COALESCE($6::jsonb, '{}'::jsonb)
         FROM estimates e
         WHERE e.id = $2 AND e.company_id = $1
         RETURNING *`,
        [
            companyId,
            estimateId,
            eventType,
            actorType || 'user',
            actorId || null,
            JSON.stringify(metadata || {}),
        ]
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

// =============================================================================
// Public token (SEND-DOC-001) — mirrors invoicesQueries 563–599
// =============================================================================

/**
 * Look up a readable estimate strictly by its public_token (the token IS the
 * auth). Archived, expired, and draft documents fail closed; answered documents
 * remain readable until the bearer link itself expires.
 */
async function getEstimateByPublicToken(publicToken, client = null) {
    if (!publicToken) return null;
    const query = queryFor(client);
    const { rows } = await query(
        // tenant-safety-allow R-natural-key: The opaque, expiring public token is the credential and resolves only its owning estimate.
        `SELECT e.*,
                COALESCE(NULLIF(c.full_name, ''), NULLIF(j.customer_name, '')) AS contact_name,
                COALESCE(NULLIF(c.email, ''), NULLIF(j.customer_email, '')) AS contact_email,
                COALESCE(NULLIF(c.phone_e164, ''), NULLIF(j.customer_phone, '')) AS contact_phone,
                j.job_number AS job_number,
                l.serial_id AS lead_serial_id,
                co.name AS company_name
         FROM estimates e
         LEFT JOIN jobs j ON j.id = e.job_id AND j.company_id = e.company_id
         LEFT JOIN contacts c
           ON c.id = COALESCE(j.contact_id, e.contact_id)
          AND c.company_id = e.company_id
         LEFT JOIN leads l ON l.id = e.lead_id AND l.company_id = e.company_id
         LEFT JOIN companies co ON co.id = e.company_id
         WHERE e.public_token = $1
           AND e.archived_at IS NULL
           AND e.public_token_expires_at > NOW()
           AND e.status = ANY($2::text[])
         LIMIT 1`,
        [publicToken, ['sent', 'viewed', 'approved', 'declined']]
    );
    if (!rows[0]) return null;
    const [estimate] = await applyEstimatePayments(
        rows[0].company_id,
        [rows[0]],
        client
    );
    return estimate;
}

/**
 * Resolve and lock the estimate authorized for a public customer action. The
 * status predicate is action-specific: approve remains resolvable after an
 * approval for idempotency, while decline stops resolving immediately after the
 * first successful decline.
 */
async function lockEstimateByPublicToken(publicToken, action, client) {
    if (!publicToken || !client?.query) return null;
    const allowedStatuses = action === 'approve'
        ? ['sent', 'viewed', 'approved']
        : action === 'decline'
            ? ['sent', 'viewed']
            : [];
    if (allowedStatuses.length === 0) return null;

    const { rows } = await client.query(
        // tenant-safety-allow R-natural-key: The opaque public token is the credential and resolves its owning company before any action.
        `SELECT e.*
         FROM estimates e
         WHERE e.public_token = $1
           AND e.archived_at IS NULL
           AND e.public_token_expires_at > NOW()
           AND e.status = ANY($2::text[])
         LIMIT 1
         FOR UPDATE OF e`,
        [publicToken, allowedStatuses]
    );
    return rows[0] || null;
}

/** First public open advances sent -> viewed and records exactly one audit event. */
async function markEstimateViewed(companyId, estimateId, client = null) {
    const query = queryFor(client);
    const { rows } = await query(
        `WITH changed AS (
            UPDATE estimates
            SET status = 'viewed', updated_at = NOW()
            WHERE id = $2
              AND company_id = $1
              AND archived_at IS NULL
              AND status = 'sent'
            RETURNING id
         )
         INSERT INTO estimate_events (
            estimate_id, event_type, actor_type, actor_id, metadata
         )
         SELECT id, 'viewed', 'client', NULL, '{"source":"public_link"}'::jsonb
         FROM changed
         RETURNING estimate_id`,
        [companyId, estimateId]
    );
    return rows.length > 0;
}

/** Resolve the active author assignment and company-local scheduling context. */
async function getDeclineTaskContext(companyId, estimateId, client = null) {
    const query = queryFor(client);
    const { rows } = await query(
        `SELECT COALESCE(NULLIF(c.timezone, ''), 'America/New_York') AS timezone,
                author.id AS owner_user_id
         FROM estimates e
         JOIN companies c ON c.id = e.company_id
         LEFT JOIN crm_users author
           ON author.id = e.created_by
          AND author.company_id = e.company_id
          AND author.status = 'active'
         WHERE e.id = $2
           AND e.company_id = $1`,
        [companyId, estimateId]
    );
    return rows[0] || null;
}

/** Persist a public_token with a database-clock expiry. */
async function setPublicToken(
    estimateId,
    companyId,
    token,
    client = null,
    lifetimeMonths = 18
) {
    const query = queryFor(client);
    const { rows } = await query(
        `UPDATE estimates
         SET public_token = $3,
             public_token_expires_at = NOW() + ($4::integer * INTERVAL '1 month'),
             updated_at = NOW()
         WHERE id = $1 AND company_id = $2
         RETURNING *`,
        [estimateId, companyId, token, lifetimeMonths]
    );
    return rows[0] || null;
}

module.exports = {
    listEstimates,
    getEstimateById,
    getEstimateByCode,
    lockEstimateForConversion,
    getConversionEventForUndo,
    getJobContext,
    getLeadContext,
    getContactContext,
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
    getEstimateByPublicToken,
    lockEstimateByPublicToken,
    markEstimateViewed,
    getDeclineTaskContext,
    setPublicToken,
};
