/**
 * Feedback persistence — CLIENT-FEEDBACK-WIDGET-001.
 * Every operation is parameterized and scoped by company_id.
 */

const db = require('./connection');

async function insertFeedback({ companyId, userId, userEmail, message, meta }) {
    const { rows } = await db.query(
        `INSERT INTO feedback_submissions
            (company_id, user_id, user_email, message, meta)
         VALUES ($1, $2, $3, $4, $5::jsonb)
         RETURNING id, created_at`,
        [companyId, userId ?? null, userEmail, message, JSON.stringify(meta || {})]
    );
    return rows[0];
}

async function updateFeedbackEmailStatus({ companyId, id, emailStatus }) {
    const { rows } = await db.query(
        `UPDATE feedback_submissions
         SET meta = jsonb_set(meta, '{email_status}', to_jsonb($3::text), true)
         WHERE id = $1 AND company_id = $2
         RETURNING id, created_at`,
        [id, companyId, emailStatus]
    );
    return rows[0] || null;
}

async function listFeedback(companyId) {
    const { rows } = await db.query(
        `SELECT id, company_id, user_id, user_email, message, meta, created_at
         FROM feedback_submissions
         WHERE company_id = $1
         ORDER BY created_at DESC, id DESC`,
        [companyId]
    );
    return rows;
}

module.exports = {
    insertFeedback,
    updateFeedbackEmailStatus,
    listFeedback,
};
