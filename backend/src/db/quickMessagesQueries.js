const db = require('./connection');

// =============================================================================
// Quick Messages CRUD
// =============================================================================

/**
 * Get all quick messages for a company, ordered by sort_order.
 */
async function getQuickMessages(companyId) {
    const result = await db.query(
        `SELECT * FROM quick_messages
         WHERE company_id = $1
         ORDER BY sort_order ASC, created_at ASC`,
        [companyId]
    );
    return result.rows;
}

/**
 * Create a new quick message. Appends at the end (max sort_order + 1).
 */
async function createQuickMessage(companyId, title, content) {
    const result = await db.query(
        `INSERT INTO quick_messages (company_id, title, content, sort_order)
         VALUES ($1, $2, $3, COALESCE(
             (SELECT MAX(sort_order) + 1 FROM quick_messages WHERE company_id = $1), 0
         ))
         RETURNING *`,
        [companyId, title, content]
    );
    return result.rows[0];
}

/**
 * Update title and/or content of a quick message.
 */
async function updateQuickMessage(id, companyId, { title, content }) {
    const result = await db.query(
        `UPDATE quick_messages
         SET title = COALESCE($3, title),
             content = COALESCE($4, content),
             updated_at = now()
         WHERE id = $1 AND company_id = $2
         RETURNING *`,
        [id, companyId, title, content]
    );
    return result.rows[0] || null;
}

/**
 * Delete a quick message.
 */
async function deleteQuickMessage(id, companyId) {
    const result = await db.query(
        `DELETE FROM quick_messages WHERE id = $1 AND company_id = $2 RETURNING id`,
        [id, companyId]
    );
    return result.rows[0] || null;
}

/**
 * Reorder quick messages. Accepts an array of IDs in desired order.
 * Uses a single UPDATE with array_position for efficiency.
 */
async function reorderQuickMessages(companyId, orderedIds) {
    // Update sort_order for each ID based on its position in the array
    await db.query(
        `UPDATE quick_messages
         SET sort_order = array_position($2::uuid[], id) - 1,
             updated_at = now()
         WHERE company_id = $1 AND id = ANY($2::uuid[])`,
        [companyId, orderedIds]
    );
    return getQuickMessages(companyId);
}

module.exports = {
    getQuickMessages,
    createQuickMessage,
    updateQuickMessage,
    deleteQuickMessage,
    reorderQuickMessages,
};
