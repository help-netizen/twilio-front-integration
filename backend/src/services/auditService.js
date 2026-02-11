/**
 * Audit Service
 * 
 * Logs auth, RBAC, and user management events to audit_log table (§12).
 * Fire-and-forget pattern — never blocks the request.
 * 
 * Actions:
 *   login_success, login_failed, logout,
 *   refresh_token_used, access_denied_403,
 *   user_created, user_disabled, user_enabled,
 *   role_changed, session_revoked, auth_policy_changed
 */

const db = require('../db/connection');

/**
 * Log an audit event.
 * 
 * @param {{ actor_id?, actor_email?, actor_ip?, action: string, target_type?, target_id?, company_id?, details?, trace_id? }} event
 */
async function log(event) {
    try {
        await db.query(
            `INSERT INTO audit_log (actor_id, actor_email, actor_ip, action, target_type, target_id, company_id, details, trace_id)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
            [
                event.actor_id || null,
                event.actor_email || null,
                event.actor_ip || null,
                event.action,
                event.target_type || null,
                event.target_id || null,
                event.company_id || null,
                JSON.stringify(event.details || {}),
                event.trace_id || null,
            ]
        );
    } catch (err) {
        // Never throw — audit failures must not break the request
        console.error('[Audit] Failed to log event:', event.action, err.message);
    }
}

/**
 * Query audit log (for super_admin API).
 * 
 * @param {{ company_id?, action?, actor_id?, limit?, offset? }} filters
 */
async function query(filters = {}) {
    const conditions = [];
    const params = [];
    let i = 1;

    if (filters.company_id) {
        conditions.push(`company_id = $${i++}`);
        params.push(filters.company_id);
    }
    if (filters.action) {
        conditions.push(`action = $${i++}`);
        params.push(filters.action);
    }
    if (filters.actor_id) {
        conditions.push(`actor_id = $${i++}`);
        params.push(filters.actor_id);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = filters.limit || 100;
    const offset = filters.offset || 0;

    const { rows } = await db.query(
        `SELECT * FROM audit_log ${where} ORDER BY created_at DESC LIMIT $${i++} OFFSET $${i++}`,
        [...params, limit, offset]
    );
    return rows;
}

module.exports = { log, query };
