/**
 * CRM User Service
 * 
 * Manages the crm_users + company_memberships tables.
 * Called by auth middleware on every authenticated request to ensure
 * the user exists locally with correct company context.
 * 
 * Roles: super_admin, company_admin, company_member
 */

const db = require('../db/connection');

// New role hierarchy (§4)
const ROLE_HIERARCHY = ['super_admin', 'company_admin', 'company_member'];

/**
 * Find or create a CRM user from a Keycloak JWT payload.
 * Upserts by keycloak_sub, resolves company_id from membership.
 * 
 * @param {{ sub: string, email?: string, name?: string, preferred_username?: string, realm_roles?: string[] }} keycloakUser
 * @returns {Promise<Object>} The crm_users row with company_id
 */
async function findOrCreateUser(keycloakUser) {
    const { sub, email, name, preferred_username, realm_roles = [] } = keycloakUser;

    // Determine primary role from token
    const primaryRole = ROLE_HIERARCHY.find(r => realm_roles.includes(r)) || 'company_member';
    const fullName = name || preferred_username || email || 'Unknown';

    // Upsert into crm_users
    const { rows } = await db.query(
        `INSERT INTO crm_users (keycloak_sub, email, full_name, role, last_login_at, updated_at)
         VALUES ($1, $2, $3, $4, NOW(), NOW())
         ON CONFLICT (keycloak_sub) DO UPDATE SET
             email = COALESCE(EXCLUDED.email, crm_users.email),
             full_name = COALESCE(EXCLUDED.full_name, crm_users.full_name),
             role = EXCLUDED.role,
             last_login_at = NOW(),
             updated_at = NOW()
         RETURNING *`,
        [sub, email, fullName, primaryRole]
    );

    const crmUser = rows[0];

    // Resolve company_id from membership (authoritative source)
    const membership = await db.query(
        `SELECT company_id, role FROM company_memberships
         WHERE user_id = $1 AND status = 'active'
         ORDER BY CASE role
             WHEN 'super_admin' THEN 1
             WHEN 'company_admin' THEN 2
             WHEN 'company_member' THEN 3
             ELSE 4
         END
         LIMIT 1`,
        [crmUser.id]
    );

    if (membership.rows.length > 0) {
        crmUser.company_id = membership.rows[0].company_id;
        crmUser.membership_role = membership.rows[0].role;
    }

    return crmUser;
}

/**
 * Get a CRM user by keycloak_sub.
 */
async function getUserBySub(sub) {
    const { rows } = await db.query(
        'SELECT * FROM crm_users WHERE keycloak_sub = $1',
        [sub]
    );
    return rows[0] || null;
}

/**
 * List users for a company with search, filter, and pagination.
 * @param {string|null} companyId - if null, returns all (super_admin)
 * @param {{ search?: string, role?: string, status?: string, page?: number, limit?: number }} opts
 * @returns {Promise<{ users: Object[], total: number, page: number, limit: number }>}
 */
async function listUsers(companyId, opts = {}) {
    const { search, role, status, page = 1, limit = 25 } = opts;
    const conditions = [];
    const params = [];
    let i = 1;

    if (companyId) {
        conditions.push(`m.company_id = $${i++}`);
        params.push(companyId);
    }
    if (search) {
        conditions.push(`(u.full_name ILIKE $${i} OR u.email ILIKE $${i})`);
        params.push(`%${search}%`);
        i++;
    }
    if (role) {
        conditions.push(`m.role = $${i++}`);
        params.push(role);
    }
    if (status) {
        conditions.push(`m.status = $${i++}`);
        params.push(status);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const offset = (page - 1) * limit;

    const join = companyId
        ? 'JOIN company_memberships m ON m.user_id = u.id'
        : 'LEFT JOIN company_memberships m ON m.user_id = u.id';

    // Count
    const countRes = await db.query(
        `SELECT COUNT(*) as total FROM crm_users u ${join} ${where}`,
        params
    );
    const total = parseInt(countRes.rows[0].total, 10);

    // Data
    const { rows } = await db.query(
        `SELECT u.id, u.email, u.full_name, u.last_login_at, u.created_at,
                m.role as membership_role, m.status as membership_status,
                m.company_id
         FROM crm_users u ${join} ${where}
         ORDER BY u.created_at DESC
         LIMIT $${i++} OFFSET $${i++}`,
        [...params, limit, offset]
    );

    return { users: rows, total, page, limit };
}

/**
 * Enable (re-activate) a user in a company.
 */
async function enableUser(userId, companyId) {
    const { rows } = await db.query(
        `UPDATE company_memberships
         SET status = 'active', updated_at = NOW()
         WHERE user_id = $1 AND company_id = $2
         RETURNING *`,
        [userId, companyId]
    );
    if (rows.length === 0) throw new Error('Membership not found');

    await db.query(
        `UPDATE crm_users SET status = 'active', updated_at = NOW() WHERE id = $1`,
        [userId]
    );

    return rows[0];
}

/**
 * Create a user with company membership.
 * @param {{ email: string, fullName: string, keycloakSub: string, companyId: string, role: string }} data
 */
async function createUserWithMembership(data) {
    const client = await db.connect();
    try {
        await client.query('BEGIN');

        const { rows: userRows } = await client.query(
            `INSERT INTO crm_users (keycloak_sub, email, full_name, role, company_id, status)
             VALUES ($1, $2, $3, $4, $5, 'active')
             RETURNING *`,
            [data.keycloakSub, data.email, data.fullName, data.role, data.companyId]
        );
        const user = userRows[0];

        await client.query(
            `INSERT INTO company_memberships (user_id, company_id, role)
             VALUES ($1, $2, $3)`,
            [user.id, data.companyId, data.role]
        );

        await client.query('COMMIT');
        return user;
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    } finally {
        client.release();
    }
}

/**
 * Change a user's role within a company.
 * Enforces last-admin invariant (delegated to DB trigger).
 */
async function changeUserRole(userId, companyId, newRole) {
    const { rows } = await db.query(
        `UPDATE company_memberships 
         SET role = $1, updated_at = NOW()
         WHERE user_id = $2 AND company_id = $3
         RETURNING *`,
        [newRole, userId, companyId]
    );
    if (rows.length === 0) throw new Error('Membership not found');

    // Sync to crm_users.role for convenience
    await db.query(
        'UPDATE crm_users SET role = $1, updated_at = NOW() WHERE id = $2',
        [newRole, userId]
    );

    return rows[0];
}

/**
 * Disable a user in a company.
 */
async function disableUser(userId, companyId) {
    const { rows } = await db.query(
        `UPDATE company_memberships
         SET status = 'inactive', updated_at = NOW()
         WHERE user_id = $1 AND company_id = $2
         RETURNING *`,
        [userId, companyId]
    );
    if (rows.length === 0) throw new Error('Membership not found');

    await db.query(
        `UPDATE crm_users SET status = 'inactive', updated_at = NOW() WHERE id = $1`,
        [userId]
    );

    return rows[0];
}

/**
 * Count active company_admins for invariant check.
 */
async function countCompanyAdmins(companyId) {
    const { rows } = await db.query(
        `SELECT COUNT(*) as count FROM company_memberships
         WHERE company_id = $1 AND role = 'company_admin' AND status = 'active'`,
        [companyId]
    );
    return parseInt(rows[0].count, 10);
}

module.exports = {
    findOrCreateUser,
    getUserBySub,
    listUsers,
    createUserWithMembership,
    changeUserRole,
    disableUser,
    enableUser,
    countCompanyAdmins,
    ROLE_HIERARCHY,
};
