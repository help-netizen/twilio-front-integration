/**
 * MAIL-AGENT-001 — settings + decision-log queries.
 * All access is company-scoped; settings row is created lazily with defaults.
 */

const db = require('./connection');

const DEFAULT_SETTINGS = {
    enabled: true,
    confidence_threshold: 0.6,
    create_contact_for_unknown: true,
    assign_owner_user_id: null,
    exclusion_rules: '',
};

async function getSettings(companyId) {
    const { rows } = await db.query(
        `SELECT company_id, enabled, confidence_threshold, create_contact_for_unknown,
                assign_owner_user_id, exclusion_rules, updated_at
         FROM mail_agent_settings WHERE company_id = $1`,
        [companyId]
    );
    if (rows[0]) return rows[0];
    return { company_id: companyId, ...DEFAULT_SETTINGS, updated_at: null };
}

async function saveSettings(companyId, patch, updatedBy) {
    const current = await getSettings(companyId);
    const next = {
        enabled: patch.enabled !== undefined ? !!patch.enabled : current.enabled,
        confidence_threshold: patch.confidence_threshold !== undefined
            ? Math.max(0, Math.min(1, Number(patch.confidence_threshold))) : Number(current.confidence_threshold),
        create_contact_for_unknown: patch.create_contact_for_unknown !== undefined
            ? !!patch.create_contact_for_unknown : current.create_contact_for_unknown,
        assign_owner_user_id: patch.assign_owner_user_id !== undefined
            ? (patch.assign_owner_user_id || null) : current.assign_owner_user_id,
        exclusion_rules: patch.exclusion_rules !== undefined
            ? String(patch.exclusion_rules) : current.exclusion_rules,
    };
    const { rows } = await db.query(
        `INSERT INTO mail_agent_settings
            (company_id, enabled, confidence_threshold, create_contact_for_unknown,
             assign_owner_user_id, exclusion_rules, updated_by, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
         ON CONFLICT (company_id) DO UPDATE SET
            enabled = EXCLUDED.enabled,
            confidence_threshold = EXCLUDED.confidence_threshold,
            create_contact_for_unknown = EXCLUDED.create_contact_for_unknown,
            assign_owner_user_id = EXCLUDED.assign_owner_user_id,
            exclusion_rules = EXCLUDED.exclusion_rules,
            updated_by = EXCLUDED.updated_by,
            updated_at = NOW()
         RETURNING company_id, enabled, confidence_threshold, create_contact_for_unknown,
                   assign_owner_user_id, exclusion_rules, updated_at`,
        [companyId, next.enabled, next.confidence_threshold, next.create_contact_for_unknown,
            next.assign_owner_user_id, next.exclusion_rules, updatedBy || null]
    );
    return rows[0];
}

/** Resolve the local email_messages row for a provider message (id + review-input fields). */
async function getEmailMessage(companyId, providerMessageId) {
    const { rows } = await db.query(
        `SELECT id, from_name, from_email, subject, body_text, contact_id, timeline_id
         FROM email_messages
         WHERE company_id = $1 AND provider_message_id = $2`,
        [companyId, providerMessageId]
    );
    return rows[0] || null;
}

async function hasReview(companyId, emailMessageId) {
    const { rows } = await db.query(
        `SELECT 1 FROM mail_agent_reviews WHERE company_id = $1 AND email_message_id = $2`,
        [companyId, emailMessageId]
    );
    return !!rows[0];
}

async function insertReview({ companyId, emailMessageId, verdict, category, confidence, reason, ruleLine, taskId, model, latencyMs }) {
    const { rows } = await db.query(
        `INSERT INTO mail_agent_reviews
            (company_id, email_message_id, verdict, category, confidence, reason,
             rule_line, task_id, model, latency_ms)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (company_id, email_message_id) DO NOTHING
         RETURNING id`,
        [companyId, emailMessageId, verdict, category || null, confidence ?? null,
            reason || null, ruleLine || null, taskId || null, model || null, latencyMs || null]
    );
    return rows[0] || null;
}

async function listReviews(companyId, limit = 50) {
    const { rows } = await db.query(
        `SELECT r.id, r.verdict, r.category, r.confidence, r.reason, r.rule_line,
                r.task_id, r.model, r.latency_ms, r.created_at,
                m.from_name, m.from_email, m.subject, m.timeline_id
         FROM mail_agent_reviews r
         JOIN email_messages m ON m.id = r.email_message_id
         WHERE r.company_id = $1
         ORDER BY r.created_at DESC
         LIMIT $2`,
        [companyId, Math.max(1, Math.min(200, limit))]
    );
    return rows;
}

async function getStats(companyId) {
    const { rows } = await db.query(
        `SELECT
            COUNT(*)::int AS reviewed_30d,
            COUNT(*) FILTER (WHERE verdict = 'task_created')::int AS tasks_30d,
            COUNT(*) FILTER (WHERE verdict = 'skipped_excluded')::int AS excluded_30d,
            COUNT(*) FILTER (WHERE verdict = 'error')::int AS errors_30d,
            MAX(created_at) AS last_review_at
         FROM mail_agent_reviews
         WHERE company_id = $1 AND created_at > NOW() - INTERVAL '30 days'`,
        [companyId]
    );
    return rows[0];
}

/** Recent inbound emails for dry-run (newest first). */
async function listRecentInbound(companyId, limit = 10) {
    const { rows } = await db.query(
        `SELECT id, from_name, from_email, subject, body_text, contact_id
         FROM email_messages
         WHERE company_id = $1 AND direction = 'inbound'
         ORDER BY COALESCE(gmail_internal_at, created_at) DESC
         LIMIT $2`,
        [companyId, Math.max(1, Math.min(20, limit))]
    );
    return rows;
}

/** Minimal email-only contact for unknown senders the agent decides to keep. */
async function createEmailContact(companyId, { fromName, fromEmail }) {
    const email = String(fromEmail || '').trim().toLowerCase();
    const fullName = String(fromName || '').trim() || email;
    const parts = fullName.split(/\s+/);
    const firstName = parts[0] || null;
    const lastName = parts.length > 1 ? parts.slice(1).join(' ') : null;
    const { rows } = await db.query(
        `INSERT INTO contacts (company_id, full_name, first_name, last_name, email)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, full_name, email`,
        [companyId, fullName, firstName, lastName, email]
    );
    return rows[0];
}

module.exports = {
    getSettings,
    saveSettings,
    getEmailMessage,
    hasReview,
    insertReview,
    listReviews,
    getStats,
    listRecentInbound,
    createEmailContact,
};
