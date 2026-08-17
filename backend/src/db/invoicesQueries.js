/**
 * Invoices Queries Module
 * PF003 Invoices MVP — Sprint 4
 *
 * Database queries for invoices, invoice items, revisions, and events.
 */
const db = require('./connection');
const { applyInvoiceAllocations } = require('./documentPaymentQueries');

function queryFor(client) {
    return client?.query ? client.query.bind(client) : db.query;
}

function calculateBalanceDue(total, amountPaid) {
    const totalNumber = Number(total || 0);
    const paidNumber = Number(amountPaid || 0);
    const totalCents = Number.isFinite(totalNumber) ? Math.round(totalNumber * 100) : 0;
    const paidCents = Number.isFinite(paidNumber) ? Math.round(paidNumber * 100) : 0;
    return (totalCents - paidCents) / 100;
}

/**
 * balance_due is materialized for writes, but older/imported rows can carry a
 * stale value. All invoice read surfaces use the invariant total - amount_paid.
 */
function withCalculatedBalance(invoice) {
    if (!invoice) return null;
    const balance = calculateBalanceDue(invoice.total, invoice.amount_paid);
    const preservePgNumericShape = [invoice.total, invoice.amount_paid, invoice.balance_due]
        .some(value => typeof value === 'string');
    return {
        ...invoice,
        balance_due: preservePgNumericShape ? balance.toFixed(2) : balance,
    };
}

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

    if (status === 'unpaid') {
        // Mobile quick-filter: issued invoices that still belong to the unpaid
        // workflow. Fully settled records transition to `paid`; drafts/terminal
        // records are intentionally excluded.
        conditions.push("i.status IN ('sent', 'viewed', 'partial', 'overdue')");
    } else if (status) {
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
               COALESCE(NULLIF(c.full_name, ''), NULLIF(j.customer_name, '')) AS contact_name,
               COALESCE(NULLIF(c.email, ''), NULLIF(j.customer_email, '')) AS contact_email,
               COALESCE(NULLIF(c.phone_e164, ''), NULLIF(j.customer_phone, '')) AS contact_phone,
               j.job_seq AS job_seq,
               l.serial_id AS lead_serial_id,
               COUNT(*) OVER() AS _total
        FROM invoices i
        LEFT JOIN jobs j ON j.id = i.job_id AND j.company_id = i.company_id
        LEFT JOIN contacts c
          ON c.id = COALESCE(j.contact_id, i.contact_id)
         AND c.company_id = i.company_id
        LEFT JOIN leads l ON l.id = i.lead_id AND l.company_id = i.company_id
        WHERE ${where}
        ORDER BY i.created_at DESC
        LIMIT $${limitIdx} OFFSET $${offsetIdx}
    `;

    const { rows } = await db.query(sql, params);

    const total = rows.length > 0 ? parseInt(rows[0]._total, 10) : 0;
    // Strip the _total column from each row
    const cleaned = rows.map(({ _total, ...rest }) => withCalculatedBalance(rest));

    return {
        rows: await applyInvoiceAllocations(companyId, cleaned),
        total,
    };
}

/**
 * Get a single invoice by ID (scoped to company).
 * Joins contact (for display name / email / phone), job, and lead
 * (so callers can reference `lead_serial_id` etc.).
 */
async function getInvoiceById(companyId, id, client = null) {
    const query = queryFor(client);
    const { rows } = await query(
        `SELECT i.*,
                COALESCE(NULLIF(c.full_name, ''), NULLIF(j.customer_name, '')) AS contact_name,
                COALESCE(NULLIF(c.email, ''), NULLIF(j.customer_email, '')) AS contact_email,
                COALESCE(NULLIF(c.phone_e164, ''), NULLIF(j.customer_phone, '')) AS contact_phone,
                j.job_number AS job_number,
                j.job_seq AS job_seq,
                j.address AS service_address,
                j.start_date AS service_date,
                l.serial_id AS lead_serial_id
         FROM invoices i
         LEFT JOIN jobs j ON j.id = i.job_id AND j.company_id = i.company_id
         LEFT JOIN contacts c
           ON c.id = COALESCE(j.contact_id, i.contact_id)
          AND c.company_id = i.company_id
         LEFT JOIN leads l ON l.id = i.lead_id AND l.company_id = i.company_id
         WHERE i.id = $1 AND i.company_id = $2`,
        [id, companyId]
    );
    const invoice = withCalculatedBalance(rows[0] || null);
    if (!invoice) return null;
    const [allocated] = await applyInvoiceAllocations(companyId, [invoice], client);
    return allocated;
}

/**
 * Compute the next per-(job|lead) invoice sequence number.
 * Mirrors `nextEstimateSequence` from estimatesQueries.
 */
function invoiceNumberPrefix({ leadSerialId, jobId }) {
    if (leadSerialId) return `INVOICE L-${leadSerialId}-`;
    if (jobId) return `INVOICE J-${jobId}-`;
    return 'INVOICE ';
}

async function nextInvoiceSequence(companyId, { leadSerialId, jobId }, client = null) {
    const query = queryFor(client);
    // Unique within the exact invoice-number namespace (mirrors EST-DUP-001). The number is keyed
    // on a lead serial / lead id / job id — id spaces that can numerically overlap — so counting by
    // job_id/lead_id let two different entities mint the SAME number and violate the unique index.
    // Count by the number PREFIX itself, taking the max trailing sequence (robust to voided/deleted
    // rows, unlike a plain COUNT which reuses a number after a gap).
    const { rows } = await query(
        `SELECT COALESCE(MAX(CAST(substring(invoice_number FROM '[0-9]+$') AS INTEGER)), 0) + 1 AS next_sequence
         FROM invoices
         WHERE company_id = $1 AND invoice_number LIKE $2`,
        [companyId, `${invoiceNumberPrefix({ leadSerialId, jobId })}%`]
    );
    return parseInt(rows[0]?.next_sequence || '1', 10);
}

/**
 * Format an invoice number that mirrors the estimate scheme (`INVOICE L-{leadSerialId}-{seq}`).
 * Falls back to a job-id-based label when no lead serial is available. The prefix here MUST match
 * nextInvoiceSequence's LIKE prefix so the sequence stays unique within it.
 */
function buildInvoiceNumber({ leadSerialId, jobId, sequence }) {
    return `${invoiceNumberPrefix({ leadSerialId, jobId })}${sequence}`;
}

/**
 * Create a new invoice. If `invoice_number` is provided, it is used as-is;
 * otherwise we fall back to a per-day INV-YYYYMMDD-NNN sequence (legacy format).
 */
async function createInvoice(companyId, data, client = null) {
    const query = queryFor(client);
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
        order_list,
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
    const numberExpr = invoice_number ? '$16' : fallbackNumberExpr;

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
        JSON.stringify(order_list || []),
        created_by || null,
    ];
    if (invoice_number) params.push(invoice_number);

    const { rows } = await query(
        `INSERT INTO invoices (
            company_id, contact_id, lead_id, job_id, estimate_id,
            invoice_number, title, notes, internal_note, status,
            tax_rate, payment_terms, due_date, currency,
            subtotal, tax_amount, discount_amount, total, amount_paid, balance_due,
            order_list, created_by
        )
        VALUES (
            $1, $2, $3, $4, $5,
            ${numberExpr},
            $6, $7, $8, 'draft',
            COALESCE($9::numeric, 0), $10, $11, COALESCE($12, 'USD'),
            0, 0, COALESCE($13::numeric, 0), 0, 0, 0,
            COALESCE($14::jsonb, '[]'::jsonb), $15
        )
        RETURNING *`,
        params
    );
    return withCalculatedBalance(rows[0]);
}

/**
 * Update allowed fields on an invoice.
 */
async function updateInvoice(id, companyId, data, client = null) {
    const query = queryFor(client);
    const allowedFields = [
        'contact_id', 'lead_id', 'job_id', 'estimate_id',
        'title', 'notes', 'internal_note',
        'tax_rate', 'discount_amount', 'payment_terms', 'due_date',
        'order_list',
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

    if (sets.length === 0) {
        return getInvoiceById(companyId, id, client);
    }

    sets.push('updated_at = NOW()');

    const { rows } = await query(
        `UPDATE invoices SET ${sets.join(', ')}
         WHERE id = $1 AND company_id = $2
         RETURNING *`,
        params
    );
    const invoice = withCalculatedBalance(rows[0] || null);
    if (!invoice) return null;
    const [allocated] = await applyInvoiceAllocations(
        invoice.company_id,
        [invoice],
        client
    );
    return allocated;
}

/**
 * Delete an invoice (hard delete).
 */
async function deleteInvoice(id, companyId, client = null) {
    const query = queryFor(client);
    const { rowCount } = await query(
        `DELETE FROM invoices
         WHERE id = $1 AND company_id = $2 AND status = 'draft'`,
        [id, companyId]
    );
    return rowCount > 0;
}

/**
 * Lock one tenant-owned invoice row before a destructive/payment decision.
 * The caller must hold an explicit transaction so the lock survives through
 * the guarded mutation.
 */
async function lockInvoiceById(companyId, id, client = null) {
    if (!client?.query) {
        throw new Error('lockInvoiceById requires an active transaction');
    }
    const { rows } = await client.query(
        `SELECT id, company_id, status
         FROM invoices
         WHERE id = $1 AND company_id = $2
         FOR UPDATE`,
        [id, companyId]
    );
    return rows[0] || null;
}

/**
 * Refuse conversion Undo after any downstream invoice use. The dependent-row
 * checks intentionally key on the globally unique invoice id after the owning
 * invoice is company-scoped: deleting the invoice would otherwise cascade or
 * null even an anomalous cross-tenant FK row.
 */
async function getConversionUndoBlockers(companyId, invoiceId, estimateId, client = null) {
    const query = queryFor(client);
    const { rows } = await query(
        `SELECT
            (SELECT COUNT(*)::INTEGER
             FROM invoices linked
             WHERE linked.company_id = $1
               AND linked.estimate_id = $3) AS linked_invoice_count,
            EXISTS (
                SELECT 1 FROM payment_transactions pt
                WHERE pt.invoice_id = i.id
            ) AS has_payment_activity,
            EXISTS (
                SELECT 1 FROM stripe_payment_sessions s
                WHERE s.invoice_id = i.id
            ) AS has_payment_session,
            EXISTS (
                SELECT 1 FROM invoice_revisions ir
                WHERE ir.invoice_id = i.id
            ) AS has_revision,
            EXISTS (
                SELECT 1 FROM tasks t
                WHERE t.invoice_id = i.id
            ) AS has_task,
            EXISTS (
                SELECT 1 FROM ai_generation_log agl
                WHERE agl.company_id = $1
                  AND agl.invoice_id = i.id
            ) AS has_generation_link,
            (
                SELECT COUNT(*) <> 1
                    OR COUNT(*) FILTER (
                        WHERE ie.event_type = 'created_from_estimate'
                          AND ie.metadata->>'estimate_id' = $3::TEXT
                    ) <> 1
                FROM invoice_events ie
                WHERE ie.invoice_id = i.id
            ) AS has_unexpected_event
         FROM invoices i
         WHERE i.id = $2
           AND i.company_id = $1
           AND i.estimate_id = $3`,
        [companyId, invoiceId, estimateId]
    );
    return rows[0] || null;
}

/** Delete only the still-draft invoice created from this tenant-owned estimate. */
async function deleteConvertedInvoice(companyId, invoiceId, estimateId, client = null) {
    const query = queryFor(client);
    const { rows } = await query(
        `DELETE FROM invoices
         WHERE id = $2
           AND company_id = $1
           AND estimate_id = $3
           AND status = 'draft'
         RETURNING id`,
        [companyId, invoiceId, estimateId]
    );
    return rows[0] || null;
}

/** Void an issued tenant-owned invoice only; draft/terminal rows never mutate. */
async function voidIssuedInvoice(id, companyId, client = null) {
    const query = queryFor(client);
    const { rows } = await query(
        `UPDATE invoices
         SET status = 'void', voided_at = NOW(), updated_at = NOW()
         WHERE id = $1
           AND company_id = $2
           AND status IN ('sent', 'viewed', 'partial', 'overdue', 'paid')
         RETURNING *`,
        [id, companyId]
    );
    return withCalculatedBalance(rows[0] || null);
}

/**
 * Update invoice status and optionally set a timestamp field.
 */
async function updateInvoiceStatus(id, companyId, status, timestampField, client = null) {
    const query = queryFor(client);
    let sql;
    if (timestampField) {
        sql = `UPDATE invoices SET status = $3, ${timestampField} = NOW(), updated_at = NOW()
               WHERE id = $1 AND company_id = $2 RETURNING *`;
    } else {
        sql = `UPDATE invoices SET status = $3, updated_at = NOW()
               WHERE id = $1 AND company_id = $2 RETURNING *`;
    }
    const { rows } = await query(sql, [id, companyId, status]);
    return withCalculatedBalance(rows[0] || null);
}

// =============================================================================
// Invoice items
// =============================================================================

/**
 * Get all items for an invoice, ordered by sort_order.
 */
async function getInvoiceItems(companyId, invoiceId, client = null) {
    const query = queryFor(client);
    const { rows } = await query(
        `SELECT ii.*
         FROM invoice_items ii
         JOIN invoices i
           ON i.id = ii.invoice_id
          AND i.company_id = $1
         WHERE ii.invoice_id = $2
         ORDER BY ii.sort_order ASC, ii.id ASC`,
        [companyId, invoiceId]
    );
    return rows;
}

/**
 * Add a line item to an invoice.
 */
async function addInvoiceItem(companyId, invoiceId, item, client = null) {
    const query = queryFor(client);
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

    const { rows } = await query(
        `INSERT INTO invoice_items (
            invoice_id, name, description, quantity, unit_price, unit,
            amount, taxable, metadata, sort_order
        )
        SELECT i.id, $3, $4, $5, $6, $7, $8, $9, $10,
            COALESCE($11, (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM invoice_items WHERE invoice_id = i.id))
        FROM invoices i
        WHERE i.id = $2 AND i.company_id = $1
        RETURNING *`,
        [
            companyId,
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
 * recalculateInvoiceTotals(companyId, invoiceId) AFTER this commits.
 *
 * @param {number|string} invoiceId
 * @param {Array<object>} items
 * @returns {Promise<object[]>} inserted rows, ordered by sort_order
 */
async function replaceInvoiceItems(companyId, invoiceId, items, existingClient = null) {
    const list = Array.isArray(items) ? items : [];
    const client = existingClient || await db.getClient();
    const ownsTransaction = !existingClient;
    try {
        if (ownsTransaction) await client.query('BEGIN');
        await client.query(
            `DELETE FROM invoice_items
             WHERE invoice_id = $2
               AND EXISTS (
                    SELECT 1
                    FROM invoices i
                    WHERE i.id = invoice_items.invoice_id
                      AND i.company_id = $1
               )`,
            [companyId, invoiceId]
        );

        for (let idx = 0; idx < list.length; idx++) {
            await addInvoiceItem(
                companyId,
                invoiceId,
                { ...(list[idx] || {}), sort_order: list[idx]?.sort_order ?? idx },
                client
            );
        }

        if (ownsTransaction) await client.query('COMMIT');
    } catch (err) {
        if (ownsTransaction) await client.query('ROLLBACK');
        throw err;
    } finally {
        if (ownsTransaction) client.release();
    }

    return getInvoiceItems(companyId, invoiceId, existingClient);
}

/**
 * Update a line item.
 */
async function updateInvoiceItem(companyId, invoiceId, itemId, data, client = null) {
    const query = queryFor(client);
    const allowedFields = ['name', 'description', 'quantity', 'unit_price', 'unit', 'taxable', 'metadata', 'sort_order'];
    const sets = [];
    const params = [companyId, invoiceId, itemId];
    const placeholders = {};
    let idx = 3;

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
            placeholders[field] = `$${idx}`;
        }
    }

    if (sets.length === 0) {
        const { rows } = await query(
            `SELECT ii.*
             FROM invoice_items ii
             JOIN invoices i
               ON i.id = ii.invoice_id
              AND i.company_id = $1
             WHERE ii.invoice_id = $2 AND ii.id = $3`,
            [companyId, invoiceId, itemId]
        );
        return rows[0] || null;
    }

    // Always recalculate amount from the final quantity * unit_price
    // Use COALESCE to fall back to existing column value if not being updated
    const quantityValue = placeholders.quantity
        ? `${placeholders.quantity}::numeric`
        : 'quantity';
    const unitPriceValue = placeholders.unit_price
        ? `${placeholders.unit_price}::numeric`
        : 'unit_price';
    sets.push(`amount = COALESCE(${quantityValue}, 1::numeric) * COALESCE(${unitPriceValue}, 0::numeric)`);
    sets.push('updated_at = NOW()');

    const { rows } = await query(
        `UPDATE invoice_items
         SET ${sets.join(', ')}
         WHERE invoice_id = $2
           AND id = $3
           AND EXISTS (
                SELECT 1
                FROM invoices i
                WHERE i.id = invoice_items.invoice_id
                  AND i.company_id = $1
           )
         RETURNING *`,
        params
    );
    return rows[0] || null;
}

/**
 * Delete a line item.
 */
async function deleteInvoiceItem(companyId, invoiceId, itemId, client = null) {
    const query = queryFor(client);
    const { rowCount } = await query(
        `DELETE FROM invoice_items
         WHERE invoice_id = $2
           AND id = $3
           AND EXISTS (
                SELECT 1
                FROM invoices i
                WHERE i.id = invoice_items.invoice_id
                  AND i.company_id = $1
           )`,
        [companyId, invoiceId, itemId]
    );
    return rowCount > 0;
}

/**
 * Recalculate invoice totals from its items.
 * Also updates balance_due = total - amount_paid.
 */
async function recalculateInvoiceTotals(companyId, invoiceId, client = null) {
    const query = queryFor(client);
    const { rows } = await query(
        `UPDATE invoices inv SET
            subtotal = COALESCE(sub.item_total, 0),
            tax_amount = ROUND(
                GREATEST(
                    COALESCE(sub.taxable_subtotal, 0) - COALESCE(inv.discount_amount, 0),
                    0
                ) * COALESCE(inv.tax_rate, 0) / 100
            , 2),
            total = ROUND(
                COALESCE(sub.item_total, 0)
                - COALESCE(inv.discount_amount, 0)
                + ROUND(
                    GREATEST(
                        COALESCE(sub.taxable_subtotal, 0) - COALESCE(inv.discount_amount, 0),
                        0
                    ) * COALESCE(inv.tax_rate, 0) / 100
                , 2)
            , 2),
            balance_due = ROUND(
                COALESCE(sub.item_total, 0)
                - COALESCE(inv.discount_amount, 0)
                + ROUND(
                    GREATEST(
                        COALESCE(sub.taxable_subtotal, 0) - COALESCE(inv.discount_amount, 0),
                        0
                    ) * COALESCE(inv.tax_rate, 0) / 100
                , 2)
            , 2) - COALESCE(inv.amount_paid, 0),
            updated_at = NOW()
        FROM (
            SELECT
                invoice_id,
                SUM(amount) AS item_total,
                SUM(CASE WHEN taxable THEN amount ELSE 0 END) AS taxable_subtotal
            FROM invoice_items
            JOIN invoices item_owner
              ON item_owner.id = invoice_items.invoice_id
             AND item_owner.company_id = $1
            WHERE invoice_id = $2
            GROUP BY invoice_id
        ) sub
        WHERE inv.id = $2
          AND inv.company_id = $1
          AND inv.id = sub.invoice_id
         RETURNING inv.*`,
        [companyId, invoiceId]
    );

    // If no items exist, the subquery returns nothing — handle that
    if (rows.length === 0) {
        const { rows: fallback } = await query(
            `UPDATE invoices SET subtotal = 0, tax_amount = 0, total = 0,
                    balance_due = 0 - COALESCE(amount_paid, 0), updated_at = NOW()
             WHERE id = $2 AND company_id = $1 RETURNING *`,
            [companyId, invoiceId]
        );
        return withCalculatedBalance(fallback[0] || null);
    }

    return withCalculatedBalance(rows[0]);
}

// =============================================================================
// Revisions
// =============================================================================

/**
 * Create a revision snapshot.
 */
async function createRevision(companyId, invoiceId, snapshot, createdBy, client = null) {
    const query = queryFor(client);
    const { rows } = await query(
        `INSERT INTO invoice_revisions (
            invoice_id, revision_number, snapshot, created_by
        )
        SELECT
            i.id,
            COALESCE((SELECT MAX(revision_number) + 1 FROM invoice_revisions WHERE invoice_id = i.id), 1),
            $3,
            $4
        FROM invoices i
        WHERE i.id = $2 AND i.company_id = $1
        RETURNING *`,
        [companyId, invoiceId, JSON.stringify(snapshot), createdBy || null]
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
async function createEvent(companyId, invoiceId, eventType, actorType, actorId, metadata, client = null) {
    const query = queryFor(client);
    const { rows } = await query(
        `INSERT INTO invoice_events (invoice_id, event_type, actor_type, actor_id, metadata)
         SELECT i.id, $3, $4, $5, $6
         FROM invoices i
         WHERE i.id = $2 AND i.company_id = $1
         RETURNING *`,
        // metadata column is NOT NULL; default to empty JSON object when none provided.
        [
            companyId,
            invoiceId,
            eventType,
            actorType || 'user',
            actorId || null,
            JSON.stringify(metadata ?? {}),
        ]
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
// Exports
// =============================================================================

/** Look up an invoice strictly by its public_token (no company scoping — the token IS the auth). */
async function getInvoiceByPublicToken(publicToken, client = null) {
    if (!publicToken) return null;
    const query = queryFor(client);
    const { rows } = await query(
        `SELECT i.*,
                COALESCE(NULLIF(c.full_name, ''), NULLIF(j.customer_name, '')) AS contact_name,
                COALESCE(NULLIF(c.email, ''), NULLIF(j.customer_email, '')) AS contact_email,
                COALESCE(NULLIF(c.phone_e164, ''), NULLIF(j.customer_phone, '')) AS contact_phone,
                j.job_number AS job_number,
                l.serial_id AS lead_serial_id
         FROM invoices i
         LEFT JOIN jobs j ON j.id = i.job_id AND j.company_id = i.company_id
         LEFT JOIN contacts c
           ON c.id = COALESCE(j.contact_id, i.contact_id)
          AND c.company_id = i.company_id
         LEFT JOIN leads l ON l.id = i.lead_id AND l.company_id = i.company_id
         WHERE i.public_token = $1
         LIMIT 1`,
        [publicToken]
    );
    const invoice = withCalculatedBalance(rows[0] || null);
    if (!invoice) return null;
    const [allocated] = await applyInvoiceAllocations(
        invoice.company_id,
        [invoice],
        client
    );
    return allocated;
}

/** Persist a public_token on the invoice (idempotent — caller checks if one already exists first). */
async function setPublicToken(invoiceId, companyId, token, client = null) {
    const query = queryFor(client);
    const { rows } = await query(
        `UPDATE invoices SET public_token = $3, updated_at = NOW()
         WHERE id = $1 AND company_id = $2
         RETURNING *`,
        [invoiceId, companyId, token]
    );
    return rows[0] || null;
}

module.exports = {
    calculateBalanceDue,
    withCalculatedBalance,
    listInvoices,
    getInvoiceById,
    getInvoiceByPublicToken,
    setPublicToken,
    createInvoice,
    nextInvoiceSequence,
    buildInvoiceNumber,
    updateInvoice,
    deleteInvoice,
    lockInvoiceById,
    getConversionUndoBlockers,
    deleteConvertedInvoice,
    voidIssuedInvoice,
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
};
