/**
 * Platform user queries for the super-admin dashboard.
 *
 * These reads intentionally cross tenant boundaries. They are safe only when
 * mounted behind requirePlatformRole('super_admin'); do not add company scope.
 */

const db = require('../db/connection');

async function listUsers({ search, page = 1, limit = 25 } = {}) {
    const conditions = [];
    const params = [];

    if (search) {
        params.push(`%${search}%`);
        conditions.push(`(u.full_name ILIKE $${params.length}
            OR u.email ILIKE $${params.length}
            OR c.name ILIKE $${params.length})`);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const offset = (page - 1) * limit;
    const { rows: countRows } = await db.query(
        `SELECT COUNT(*) AS total
         FROM crm_users u
         JOIN company_memberships m ON m.user_id = u.id
         JOIN companies c ON c.id = m.company_id
         ${where}`,
        params
    );

    const { rows } = await db.query(
        `SELECT u.id, u.keycloak_sub, u.email, u.full_name, u.last_login_at,
                m.role, m.role_key, m.status,
                c.id AS company_id, c.name AS company_name
         FROM crm_users u
         JOIN company_memberships m ON m.user_id = u.id
         JOIN companies c ON c.id = m.company_id
         ${where}
         ORDER BY (u.last_login_at > now() - interval '5 minutes') DESC NULLS LAST,
                  u.last_login_at DESC NULLS LAST,
                  u.id, c.id
         LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, limit, offset]
    );

    return {
        users: rows,
        total: parseInt(countRows[0].total, 10),
        page,
        limit,
    };
}

async function getUserForPasswordReset(userId) {
    const { rows } = await db.query(
        `SELECT u.id, u.keycloak_sub, u.email,
                COALESCE(
                    primary_membership.company_id,
                    fallback_membership.company_id
                ) AS company_id
         FROM crm_users u
         LEFT JOIN company_memberships primary_membership
           ON primary_membership.id = u.primary_membership_id
          AND primary_membership.user_id = u.id
         LEFT JOIN LATERAL (
             SELECT m.company_id
             FROM company_memberships m
             WHERE m.user_id = u.id
             ORDER BY m.is_primary DESC, m.created_at, m.id
             LIMIT 1
         ) fallback_membership ON true
         WHERE u.id = $1`,
        [userId]
    );
    return rows[0] || null;
}

module.exports = { listUsers, getUserForPasswordReset };
