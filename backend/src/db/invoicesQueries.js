/**
 * Invoices Queries Module
 * PF003 Invoices MVP — Sprint 4
 *
 * Database queries for invoices, invoice items, revisions, and events.
 */
const db = require('./connection');

// =============================================================================
// Invoice CRUD
// =============================================================================

/**
 * List invoices with dynamic filters and pagination.
 *
 * @param {string}   companyId
 * @param {Object}   filters
 * @param {string}  [filters.status]
 * @param {string}  [filters.contactId]
 * @param {string}  [filters.leadId]
 * @param {string}  [filters.jobId]
 * @param {string}  [filters.estimateId]
 * @param {string}  [filters.search]
 * @param {string}  [filters.startDate]
 * @param {string}  [filters.endDate]
 * @param {number}  [filters.limit=50]
 * @param {number}  [filters.offset=0]
 * @returns {Promise<{rows: object[], total: number}>}
 */
async function listInvoices(companyId, filters = {}) {
    const {
        status,
        contactId,
        leadId,
        jobId,
        estimateId,
        search,
        startDate,
        endDate,
        limit = 50,
        offset = 0,
    } = filters;

    const conditions = ['i.company_id = $1'];
    const params = [companyId];
    let idx = 1;

    if (status) {
        idx++;
        conditions.push(`i.status = $${idx}`);
        params.push(status);
    }
    if (contactId) {
        idx++;
        conditions.push(`i.contact_id = $${idx}`);
        params.push(contactId);
    }
    if (leadId) {
        idx++;
        conditions.push(`i.lead_id = $${idx}`);
        params.push(leadId);
    }
    if (jobId) {
        idx++;
        conditions.push(`i.job_id = $${idx}`);
        params.push(jobId);
    }
    if (estimateId) {
        idx++;
        conditions.push(`i.estimate_id = $${idx}`);
        params.push(estimateId);
    }
    if (search) {
        idx++;
        conditions.push(`(i.invoice_number ILIKE $${idx} OR i.title ILIKE $${idx} OR i.notes ILIKE $${idx})`);
        params.push(`%${search}%`);
    }
    if (startDate) {
        idx++;
        conditions.push(`i.created_at >= $${idx}`);
        params.push(startDate);
    }
    if (endDate) {
        idx++;
        conditions.push(`i.created_at <= $${idx}`);
        params.push(endDate);
    }

    const where = conditions.join(' AND ');

    idx++;
    const limitIdx = idx;
    params.push(limit);

    idx++;
    const offsetIdx = idx;
    params.push(offset);

    const sql = `
        SELECT i.*,
               c.full_name AS contact_name,
               l.serial_id AS lead_serial_id,
               COUNT(*) OVER() AS _total
        FROM invoices i
        LEFT JOIN contacts c ON c.id = i.contact_id
        LEFT JOIN leads l ON l.id = i.lead_id AND l.company_id = i.company_id
        WHERE ${where}
        ORDER BY i.created_at DESC
        LIMIT $${limitIdx} OFFSET $${offsetIdx}
    `;

    const { rows } = await db.query(sql, params);

    const total = rows.length > 0 ? parseInt(rows[0]._total, 10) : 0;
    // Strip the _total column from each row
    const cleaned = rows.map(({ _total, ...rest }) => rest);

    return { rows: cleaned, total };
}

/**
 * Get a single invoice by ID (scoped to company).
 * Joins contact (for display name / email / phone), job, and lead
 * (so callers can reference `lead_serial_id` etc.).
 */
async function getInvoiceById(companyId, id) {
    const { rows } = await db.query(
        `SELECT i.*,
                c.full_name AS contact_name,
                c.email AS contact_email,
                c.phone_e164 AS contact_phone,
                j.job_number AS job_number,
                j.address AS service_address,
                l.serial_id AS lead_serial_id
         FROM invoices i
         LEFT JOIN contacts c ON c.id = i.contact_id
         LEFT JOIN jobs j ON j.id = i.job_id AND j.company_id = i.company_id
         LEFT JOIN leads l ON l.id = i.lead_id AND l.company_id = i.company_id
         WHERE i.id = $1 AND i.company_id = $2`,
        [id, companyId]
    );
    return rows[0] || null;
}

/**
 * Compute the next per-(job|lead) invoice sequence number.
 * Mirrors `nextEstimateSequence` from estimatesQueries.
 */
async function nextInvoiceSequence(companyId, { jobId, leadId }) {
    const params = [companyId];
    let clause = '';
    if (jobId) {
        params.push(jobId);
        clause = 'job_id = $2';
    } else if (leadId) {
        params.push(leadId);
        clause = 'lead_id = $2 AND job_id IS NULL';
    } else {
        // Fallback — global sequence per company when no job/lead linkage.
        clause = 'TRUE';
    }
    // Count existing invoices for the same job/lead bucket; sequence = count + 1.
    const { rows } = await db.query(
        `SELECT COUNT(*)::int + 1 AS next_sequence
         FROM invoices
         WHERE company_id = $1 AND ${clause}`,
        params
    );
    return parseInt(rows[0]?.next_sequence || '1', 10);
}

/**
 * Format an invoice number that mirrors the estimate scheme (`INVOICE L-{leadSerialId}-{seq}`).
 * Falls back to a job-id-based label when no lead serial is available.
 */
function buildInvoiceNumber({ leadSerialId, jobId, sequence }) {
    if (leadSerialId) return `INVOICE L-${leadSerialId}-${sequence}`;
    if (jobId) return `INVOICE J-${jobId}-${sequence}`;
    return `INVOICE ${sequence}`;
}

/**
 * Create a new invoice. If `invoice_number` is provided, it is used as-is;
 * otherwise we fall back to a per-day INV-YYYYMMDD-NNN sequence (legacy format).
 */
async function createInvoice(companyId, data) {
    const {
        contact_id,
        lead_id,
        job_id,
        estimate_id,
        invoice_number,
        title,
        notes,
        internal_note,
        tax_rate,
        discount_amount,
        payment_terms,
        due_date,
        currency,
        created_by,
    } = data;

    // Default invoice_number expression — used when the caller doesn't supply one.
    const fallbackNumberExpr = `'INV-' || TO_CHAR(NOW(), 'YYYYMMDD') || '-' || LPAD(
        (COALESCE(
            (SELECT MAX(NULLIF(regexp_replace(invoice_number, '^INV-\\d{8}-', ''), '')::int) + 1
             FROM invoices
             WHERE company_id = $1 AND invoice_number ~ ('^INV-' || TO_CHAR(NOW(), 'YYYYMMDD') || '-\\d+$')),
            1
        ))::text, 3, '0')`;
    const numberExpr = invoice_number ? '$15' : fallbackNumberExpr;

    const params = [
        companyId,
        contact_id,
        lead_id || null,
        job_id || null,
        estimate_id || null,
        title || null,
        notes || null,
        internal_note || null,
        tax_rate != null ? tax_rate : 0,
        payment_terms || null,
        due_date || null,
        currency || 'USD',
        discount_amount != null ? discount_amount : 0,
        created_by || null,
    ];
    if (invoice_number) params.push(invoice_number);

    const { rows } = await db.query(
        `INSERT INTO invoices (
            company_id, contact_id, lead_id, job_id, estimate_id,
            invoice_number, title, notes, internal_note, status,
            tax_rate, payment_terms, due_date, currency,
            subtotal, tax_amount, discount_amount, total, amount_paid, balance_due,
            created_by
        )
        VALUES (
            $1, $2, $3, $4, $5,
            ${numberExpr},
            $6, $7, $8, 'draft',
            COALESCE($9::numeric, 0), $10, $11, COALESCE($12, 'USD'),
            0, 0, COALESCE($13::numeric, 0), 0, 0, 0,
            $14
        )
        RETURNING *`,
        params
    );
    return rows[0];
}

/**
 * Update allowed fields on an invoice.
 */
async function updateInvoice(id, companyId, data) {
    const allowedFields = [
        'contact_id', 'lead_id', 'job_id', 'estimate_id',
        'title', 'notes', 'internal_note',
        'tax_rate', 'discount_amount', 'payment_terms', 'due_date', 'status',
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

    if (sets.length === 0) {
        return getInvoiceById(companyId, id);
    }

    sets.push('updated_at = NOW()');

    const { rows } = await db.query(
        `UPDATE invoices SET ${sets.join(', ')}
         WHERE id = $1 AND company_id = $2
         RETURNING *`,
        params
    );
    return rows[0] || null;
}

/**
 * Delete an invoice (hard delete).
 */
async function deleteInvoice(id, companyId) {
    const { rowCount } = await db.query(
        `DELETE FROM invoices WHERE id = $1 AND company_id = $2`,
        [id, companyId]
    );
    return rowCount > 0;
}

/**
 * Update invoice status and optionally set a timestamp field.
 */
async function updateInvoiceStatus(id, companyId, status, timestampField) {
    let sql;
    if (timestampField) {
        sql = `UPDATE invoices SET status = $3, ${timestampField} = NOW(), updated_at = NOW()
               WHERE id = $1 AND company_id = $2 RETURNING *`;
    } else {
        sql = `UPDATE invoices SET status = $3, updated_at = NOW()
               WHERE id = $1 AND company_id = $2 RETURNING *`;
    }
    const { rows } = await db.query(sql, [id, companyId, status]);
    return rows[0] || null;
}

// =============================================================================
// Invoice items
// =============================================================================

/**
 * Get all items for an invoice, ordered by sort_order.
 */
async function getInvoiceItems(invoiceId) {
    const { rows } = await db.query(
        `SELECT * FROM invoice_items WHERE invoice_id = $1 ORDER BY sort_order ASC, id ASC`,
        [invoiceId]
    );
    return rows;
}

/**
 * Add a line item to an invoice.
 */
async function addInvoiceItem(invoiceId, item) {
    const {
        name,
        description,
        quantity,
        unit_price,
        unit,
        taxable,
        metadata,
        sort_order,
    } = item;

    const amount = (quantity || 1) * (unit_price || 0);

    const { rows } = await db.query(
        `INSERT INTO invoice_items (
            invoice_id, name, description, quantity, unit_price, unit,
            amount, taxable, metadata, sort_order
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9,
            COALESCE($10, (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM invoice_items WHERE invoice_id = $1))
        )
        RETURNING *`,
        [
            invoiceId,
            name || '',
            description || '',
            quantity || 1,
            unit_price || 0,
            unit || null,
            amount,
            taxable != null ? taxable : true,
            // metadata column is NOT NULL; default to empty JSON object when not provided.
            JSON.stringify(metadata ?? {}),
            sort_order != null ? sort_order : null,
        ]
    );
    return rows[0];
}

/**
 * Replace ALL line items on an invoice with the given payload, atomically.
 *
 * INVOICE-EDIT-ITEMS-PERSIST-001 — the full editor (InvoiceEditorDialog) always
 * sends the complete `items` array (no per-item id) on update, but `updateInvoice`
 * only wrote scalar fields, so edited/added/removed items were silently dropped.
 * This delete-then-reinsert reconciliation runs on its own client inside a single
 * transaction so a partial failure never leaves the invoice with a torn item set.
 *
 * Reuses addInvoiceItem's column + amount logic (amount = (quantity||1)*(unit_price||0),
 * taxable defaults true, metadata defaults '{}'::jsonb, unit nullable). `sort_order`
 * comes from each item's own value when present, otherwise the array index.
 *
 * `items = []` is valid — it clears the invoice (summary-only invoices are allowed).
 * NOTE: totals are NOT recalculated here — the caller invokes
 * recalculateInvoiceTotals(invoiceId) AFTER this commits.
 *
 * @param {number|string} invoiceId
 * @param {Array<object>} items
 * @returns {Promise<object[]>} inserted rows, ordered by sort_order
 */
async function replaceInvoiceItems(invoiceId, items) {
    const list = Array.isArray(items) ? items : [];
    const client = await db.getClient();
    try {
        await client.query('BEGIN');
        await client.query(`DELETE FROM invoice_items WHERE invoice_id = $1`, [invoiceId]);

        for (let idx = 0; idx < list.length; idx++) {
            const item = list[idx] || {};
            const {
                name,
                description,
                quantity,
                unit_price,
                unit,
                taxable,
                metadata,
                sort_order,
            } = item;

            const amount = (quantity || 1) * (unit_price || 0);

            await client.query(
                `INSERT INTO invoice_items (
                    invoice_id, name, description, quantity, unit_price, unit,
                    amount, taxable, metadata, sort_order
                )
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
                [
                    invoiceId,
                    name || '',
                    description || '',
                    quantity || 1,
                    unit_price || 0,
                    unit || null,
                    amount,
                    taxable != null ? taxable : true,
                    // metadata column is NOT NULL; default to empty JSON object when not provided.
                    JSON.stringify(metadata ?? {}),
                    // Preserve the caller's explicit ordering; fall back to the array index.
                    sort_order != null ? sort_order : idx,
                ]
            );
        }

        await client.query('COMMIT');
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    } finally {
        client.release();
    }

    // Return the freshly-persisted items (ordered), reusing the shared reader.
    return getInvoiceItems(invoiceId);
}

/**
 * Update a line item.
 */
async function updateInvoiceItem(itemId, data) {
    const allowedFields = ['name', 'description', 'quantity', 'unit_price', 'unit', 'taxable', 'metadata', 'sort_order'];
    const sets = [];
    const params = [itemId];
    let idx = 1;

    for (const field of allowedFields) {
        if (data[field] !== undefined) {
            idx++;
            if (field === 'metadata') {
                sets.push(`${field} = $${idx}`);
                params.push(JSON.stringify(data[field]));
            } else {
                sets.push(`${field} = $${idx}`);
                params.push(data[field]);
            }
        }
    }

    if (sets.length === 0) {
        const { rows } = await db.query(`SELECT * FROM invoice_items WHERE id = $1`, [itemId]);
        return rows[0] || null;
    }

    // Always recalculate amount from the final quantity * unit_price
    // Use COALESCE to fall back to existing column value if not being updated
    sets.push(`amount = COALESCE(${data.quantity !== undefined ? `$${params.indexOf(data.quantity) + 1}` : 'quantity'}, 1) * COALESCE(${data.unit_price !== undefined ? `$${params.indexOf(data.unit_price) + 1}` : 'unit_price'}, 0)`);
    sets.push('updated_at = NOW()');

    const { rows } = await db.query(
        `UPDATE invoice_items SET ${sets.join(', ')} WHERE id = $1 RETURNING *`,
        params
    );
    return rows[0] || null;
}

/**
 * Delete a line item.
 */
async function deleteInvoiceItem(itemId) {
    const { rowCount } = await db.query(
        `DELETE FROM invoice_items WHERE id = $1`,
        [itemId]
    );
    return rowCount > 0;
}

/**
 * Recalculate invoice totals from its items.
 * Also updates balance_due = total - amount_paid.
 */
async function recalculateInvoiceTotals(invoiceId) {
    const { rows } = await db.query(
        `UPDATE invoices inv SET
            subtotal = COALESCE(sub.item_total, 0),
            tax_amount = ROUND(
                COALESCE(sub.item_total, 0) * COALESCE(inv.tax_rate, 0) / 100
            , 2),
            total = ROUND(
                COALESCE(sub.item_total, 0)
                - COALESCE(inv.discount_amount, 0)
                + COALESCE(sub.item_total, 0) * COALESCE(inv.tax_rate, 0) / 100
            , 2),
            balance_due = ROUND(
                COALESCE(sub.item_total, 0)
                - COALESCE(inv.discount_amount, 0)
                + COALESCE(sub.item_total, 0) * COALESCE(inv.tax_rate, 0) / 100
            , 2) - COALESCE(inv.amount_paid, 0),
            updated_at = NOW()
        FROM (
            SELECT invoice_id, SUM(amount) AS item_total
            FROM invoice_items
            WHERE invoice_id = $1
            GROUP BY invoice_id
        ) sub
        WHERE inv.id = $1 AND inv.id = sub.invoice_id
        RETURNING inv.*`,
        [invoiceId]
    );

    // If no items exist, the subquery returns nothing — handle that
    if (rows.length === 0) {
        const { rows: fallback } = await db.query(
            `UPDATE invoices SET subtotal = 0, tax_amount = 0, total = 0,
                    balance_due = 0 - COALESCE(amount_paid, 0), updated_at = NOW()
             WHERE id = $1 RETURNING *`,
            [invoiceId]
        );
        return fallback[0] || null;
    }

    return rows[0];
}

// =============================================================================
// Revisions
// =============================================================================

/**
 * Create a revision snapshot.
 */
async function createRevision(invoiceId, snapshot, createdBy) {
    const { rows } = await db.query(
        `INSERT INTO invoice_revisions (
            invoice_id, revision_number, snapshot, created_by
        )
        VALUES (
            $1,
            COALESCE((SELECT MAX(revision_number) + 1 FROM invoice_revisions WHERE invoice_id = $1), 1),
            $2,
            $3
        )
        RETURNING *`,
        [invoiceId, JSON.stringify(snapshot), createdBy || null]
    );
    return rows[0];
}

/**
 * List revisions for an invoice, newest first.
 */
async function listRevisions(invoiceId) {
    const { rows } = await db.query(
        `SELECT * FROM invoice_revisions WHERE invoice_id = $1 ORDER BY revision_number DESC`,
        [invoiceId]
    );
    return rows;
}

// =============================================================================
// Events (audit trail)
// =============================================================================

/**
 * Create an audit event.
 */
async function createEvent(invoiceId, eventType, actorType, actorId, metadata) {
    const { rows } = await db.query(
        `INSERT INTO invoice_events (invoice_id, event_type, actor_type, actor_id, metadata)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING *`,
        // metadata column is NOT NULL; default to empty JSON object when none provided.
        [invoiceId, eventType, actorType || 'user', actorId || null, JSON.stringify(metadata ?? {})]
    );
    return rows[0];
}

/**
 * List events for an invoice, newest first.
 */
async function listEvents(invoiceId) {
    const { rows } = await db.query(
        `SELECT * FROM invoice_events WHERE invoice_id = $1 ORDER BY created_at DESC`,
        [invoiceId]
    );
    return rows;
}

// =============================================================================
// Payments
// =============================================================================

/**
 * Record a payment against an invoice.
 * Updates amount_paid and balance_due. Sets paid_at if fully paid.
 */
async function recordPayment(id, companyId, amount) {
    const { rows } = await db.query(
        `UPDATE invoices SET
            amount_paid = COALESCE(amount_paid, 0) + $3,
            balance_due = total - (COALESCE(amount_paid, 0) + $3),
            paid_at = CASE WHEN total - (COALESCE(amount_paid, 0) + $3) <= 0 THEN NOW() ELSE paid_at END,
            updated_at = NOW()
         WHERE id = $1 AND company_id = $2
         RETURNING *`,
        [id, companyId, amount]
    );
    return rows[0] || null;
}

// =============================================================================
// Exports
// =============================================================================

/** Look up an invoice strictly by its public_token (no company scoping — the token IS the auth). */
async function getInvoiceByPublicToken(publicToken) {
    if (!publicToken) return null;
    const { rows } = await db.query(
        `SELECT i.*,
                c.full_name AS contact_name,
                c.email AS contact_email,
                c.phone_e164 AS contact_phone,
                j.job_number AS job_number,
                l.serial_id AS lead_serial_id
         FROM invoices i
         LEFT JOIN contacts c ON c.id = i.contact_id
         LEFT JOIN jobs j ON j.id = i.job_id AND j.company_id = i.company_id
         LEFT JOIN leads l ON l.id = i.lead_id AND l.company_id = i.company_id
         WHERE i.public_token = $1
         LIMIT 1`,
        [publicToken]
    );
    return rows[0] || null;
}

/** Persist a public_token on the invoice (idempotent — caller checks if one already exists first). */
async function setPublicToken(invoiceId, companyId, token) {
    const { rows } = await db.query(
        `UPDATE invoices SET public_token = $3, updated_at = NOW()
         WHERE id = $1 AND company_id = $2
         RETURNING *`,
        [invoiceId, companyId, token]
    );
    return rows[0] || null;
}

module.exports = {
    listInvoices,
    getInvoiceById,
    getInvoiceByPublicToken,
    setPublicToken,
    createInvoice,
    nextInvoiceSequence,
    buildInvoiceNumber,
    updateInvoice,
    deleteInvoice,
    updateInvoiceStatus,
    getInvoiceItems,
    addInvoiceItem,
    replaceInvoiceItems,
    updateInvoiceItem,
    deleteInvoiceItem,
    recalculateInvoiceTotals,
    createRevision,
    listRevisions,
    createEvent,
    listEvents,
    recordPayment,
};
