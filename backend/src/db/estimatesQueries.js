/**
 * Estimates Queries Module
 * PF002 Estimates MVP — Sprint 3
 *
 * Database queries for estimates, estimate items, revisions, and events.
 */
const db = require('./connection');

// =============================================================================
// Estimate CRUD
// =============================================================================

/**
 * List estimates with dynamic filters and pagination.
 *
 * @param {string}   companyId
 * @param {Object}   filters
 * @param {string}  [filters.status]
 * @param {string}  [filters.contactId]
 * @param {string}  [filters.leadId]
 * @param {string}  [filters.jobId]
 * @param {string}  [filters.search]
 * @param {string}  [filters.startDate]
 * @param {string}  [filters.endDate]
 * @param {number}  [filters.limit=50]
 * @param {number}  [filters.offset=0]
 * @returns {Promise<{rows: object[], total: number}>}
 */
async function listEstimates(companyId, filters = {}) {
    const {
        status,
        contactId,
        leadId,
        jobId,
        search,
        startDate,
        endDate,
        limit = 50,
        offset = 0,
    } = filters;

    const conditions = ['e.company_id = $1'];
    const params = [companyId];
    let idx = 1;

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
        conditions.push(`(e.estimate_number ILIKE $${idx} OR e.title ILIKE $${idx} OR e.notes ILIKE $${idx})`);
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

    const where = conditions.join(' AND ');

    idx++;
    const limitIdx = idx;
    params.push(limit);

    idx++;
    const offsetIdx = idx;
    params.push(offset);

    const sql = `
        SELECT e.*, COUNT(*) OVER() AS _total
        FROM estimates e
        WHERE ${where}
        ORDER BY e.created_at DESC
        LIMIT $${limitIdx} OFFSET $${offsetIdx}
    `;

    const { rows } = await db.query(sql, params);

    const total = rows.length > 0 ? parseInt(rows[0]._total, 10) : 0;
    // Strip the _total column from each row
    const cleaned = rows.map(({ _total, ...rest }) => rest);

    return { rows: cleaned, total };
}

/**
 * Get a single estimate by ID (scoped to company).
 */
async function getEstimateById(companyId, id) {
    const { rows } = await db.query(
        `SELECT * FROM estimates WHERE id = $1 AND company_id = $2`,
        [id, companyId]
    );
    return rows[0] || null;
}

/**
 * Create a new estimate with auto-generated estimate_number.
 * Format: EST-YYYYMMDD-NNN
 */
async function createEstimate(companyId, data) {
    const {
        contact_id,
        lead_id,
        job_id,
        title,
        notes,
        valid_until,
        tax_rate,
        discount_type,
        discount_value,
        created_by,
    } = data;

    const { rows } = await db.query(
        `INSERT INTO estimates (
            company_id, contact_id, lead_id, job_id,
            estimate_number, title, notes, status,
            valid_until, tax_rate, discount_type, discount_value,
            subtotal, tax_amount, total,
            created_by
        )
        VALUES (
            $1, $2, $3, $4,
            'EST-' || TO_CHAR(NOW(), 'YYYYMMDD') || '-' || LPAD(
                (COALESCE(
                    (SELECT COUNT(*)::int + 1 FROM estimates
                     WHERE company_id = $1 AND estimate_number LIKE 'EST-' || TO_CHAR(NOW(), 'YYYYMMDD') || '-%'),
                    1
                ))::text, 3, '0'),
            $5, $6, 'draft',
            $7, COALESCE($8, 0), $9, COALESCE($10, 0),
            0, 0, 0,
            $11
        )
        RETURNING *`,
        [
            companyId,
            contact_id,
            lead_id || null,
            job_id || null,
            title || null,
            notes || null,
            valid_until || null,
            tax_rate != null ? tax_rate : 0,
            discount_type || null,
            discount_value != null ? discount_value : 0,
            created_by || null,
        ]
    );
    return rows[0];
}

/**
 * Update allowed fields on an estimate.
 */
async function updateEstimate(id, companyId, data) {
    const allowedFields = [
        'contact_id', 'lead_id', 'job_id', 'title', 'notes',
        'valid_until', 'tax_rate', 'discount_type', 'discount_value',
        'status',
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
        return getEstimateById(companyId, id);
    }

    sets.push('updated_at = NOW()');

    const { rows } = await db.query(
        `UPDATE estimates SET ${sets.join(', ')}
         WHERE id = $1 AND company_id = $2
         RETURNING *`,
        params
    );
    return rows[0] || null;
}

/**
 * Delete an estimate (hard delete).
 */
async function deleteEstimate(id, companyId) {
    const { rowCount } = await db.query(
        `DELETE FROM estimates WHERE id = $1 AND company_id = $2`,
        [id, companyId]
    );
    return rowCount > 0;
}

/**
 * Update estimate status and optionally set a timestamp field.
 */
async function updateEstimateStatus(id, companyId, status, timestampField) {
    let sql;
    if (timestampField) {
        sql = `UPDATE estimates SET status = $3, ${timestampField} = NOW(), updated_at = NOW()
               WHERE id = $1 AND company_id = $2 RETURNING *`;
    } else {
        sql = `UPDATE estimates SET status = $3, updated_at = NOW()
               WHERE id = $1 AND company_id = $2 RETURNING *`;
    }
    const { rows } = await db.query(sql, [id, companyId, status]);
    return rows[0] || null;
}

// =============================================================================
// Estimate items
// =============================================================================

/**
 * Get all items for an estimate, ordered by sort_order.
 */
async function getEstimateItems(estimateId) {
    const { rows } = await db.query(
        `SELECT * FROM estimate_items WHERE estimate_id = $1 ORDER BY sort_order ASC, id ASC`,
        [estimateId]
    );
    return rows;
}

/**
 * Add a line item to an estimate.
 */
async function addEstimateItem(estimateId, item) {
    const {
        description,
        quantity,
        unit_price,
        unit,
        tax_rate,
        sort_order,
    } = item;

    const amount = (quantity || 1) * (unit_price || 0);

    const { rows } = await db.query(
        `INSERT INTO estimate_items (
            estimate_id, description, quantity, unit_price, unit,
            amount, tax_rate, sort_order
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7,
            COALESCE($8, (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM estimate_items WHERE estimate_id = $1))
        )
        RETURNING *`,
        [
            estimateId,
            description || '',
            quantity || 1,
            unit_price || 0,
            unit || null,
            amount,
            tax_rate != null ? tax_rate : null,
            sort_order != null ? sort_order : null,
        ]
    );
    return rows[0];
}

/**
 * Update a line item.
 */
async function updateEstimateItem(itemId, data) {
    const allowedFields = ['description', 'quantity', 'unit_price', 'unit', 'tax_rate', 'sort_order'];
    const sets = [];
    const params = [itemId];
    let idx = 1;

    for (const field of allowedFields) {
        if (data[field] !== undefined) {
            idx++;
            sets.push(`${field} = $${idx}`);
            params.push(data[field]);
        }
    }

    if (sets.length === 0) {
        const { rows } = await db.query(`SELECT * FROM estimate_items WHERE id = $1`, [itemId]);
        return rows[0] || null;
    }

    // Always recalculate amount from the final quantity * unit_price
    // Use COALESCE to fall back to existing column value if not being updated
    sets.push(`amount = COALESCE(${data.quantity !== undefined ? `$${params.indexOf(data.quantity) + 1}` : 'quantity'}, 1) * COALESCE(${data.unit_price !== undefined ? `$${params.indexOf(data.unit_price) + 1}` : 'unit_price'}, 0)`);
    sets.push('updated_at = NOW()');

    const { rows } = await db.query(
        `UPDATE estimate_items SET ${sets.join(', ')} WHERE id = $1 RETURNING *`,
        params
    );
    return rows[0] || null;
}

/**
 * Delete a line item.
 */
async function deleteEstimateItem(itemId) {
    const { rowCount } = await db.query(
        `DELETE FROM estimate_items WHERE id = $1`,
        [itemId]
    );
    return rowCount > 0;
}

/**
 * Recalculate estimate totals from its items.
 */
async function recalculateEstimateTotals(estimateId) {
    const { rows } = await db.query(
        `UPDATE estimates e SET
            subtotal = COALESCE(sub.item_total, 0),
            tax_amount = ROUND(
                COALESCE(sub.item_total, 0) * COALESCE(e.tax_rate, 0) / 100
                - CASE
                    WHEN e.discount_type = 'percentage' THEN COALESCE(sub.item_total, 0) * COALESCE(e.discount_value, 0) / 100 * COALESCE(e.tax_rate, 0) / 100
                    ELSE 0
                  END
            , 2),
            total = ROUND(
                COALESCE(sub.item_total, 0)
                - CASE
                    WHEN e.discount_type = 'percentage' THEN COALESCE(sub.item_total, 0) * COALESCE(e.discount_value, 0) / 100
                    WHEN e.discount_type = 'fixed' THEN COALESCE(e.discount_value, 0)
                    ELSE 0
                  END
                + COALESCE(sub.item_total, 0) * COALESCE(e.tax_rate, 0) / 100
                - CASE
                    WHEN e.discount_type = 'percentage' THEN COALESCE(sub.item_total, 0) * COALESCE(e.discount_value, 0) / 100 * COALESCE(e.tax_rate, 0) / 100
                    ELSE 0
                  END
            , 2),
            updated_at = NOW()
        FROM (
            SELECT estimate_id, SUM(amount) AS item_total
            FROM estimate_items
            WHERE estimate_id = $1
            GROUP BY estimate_id
        ) sub
        WHERE e.id = $1 AND e.id = sub.estimate_id
        RETURNING e.*`,
        [estimateId]
    );

    // If no items exist, the subquery returns nothing — handle that
    if (rows.length === 0) {
        const { rows: fallback } = await db.query(
            `UPDATE estimates SET subtotal = 0, tax_amount = 0, total = 0, updated_at = NOW()
             WHERE id = $1 RETURNING *`,
            [estimateId]
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
async function createRevision(estimateId, snapshot, createdBy) {
    const { rows } = await db.query(
        `INSERT INTO estimate_revisions (
            estimate_id, revision_number, snapshot, created_by
        )
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

/**
 * List revisions for an estimate, newest first.
 */
async function listRevisions(estimateId) {
    const { rows } = await db.query(
        `SELECT * FROM estimate_revisions WHERE estimate_id = $1 ORDER BY revision_number DESC`,
        [estimateId]
    );
    return rows;
}

// =============================================================================
// Events (audit trail)
// =============================================================================

/**
 * Create an audit event.
 */
async function createEvent(estimateId, eventType, actorType, actorId, metadata) {
    const { rows } = await db.query(
        `INSERT INTO estimate_events (estimate_id, event_type, actor_type, actor_id, metadata)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING *`,
        [estimateId, eventType, actorType || 'user', actorId || null, metadata ? JSON.stringify(metadata) : null]
    );
    return rows[0];
}

/**
 * List events for an estimate, newest first.
 */
async function listEvents(estimateId) {
    const { rows } = await db.query(
        `SELECT * FROM estimate_events WHERE estimate_id = $1 ORDER BY created_at DESC`,
        [estimateId]
    );
    return rows;
}

// =============================================================================
// Exports
// =============================================================================

module.exports = {
    listEstimates,
    getEstimateById,
    createEstimate,
    updateEstimate,
    deleteEstimate,
    updateEstimateStatus,
    getEstimateItems,
    addEstimateItem,
    updateEstimateItem,
    deleteEstimateItem,
    recalculateEstimateTotals,
    createRevision,
    listRevisions,
    createEvent,
    listEvents,
};
