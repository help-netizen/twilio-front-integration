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
                COALESCE(m.role_key, m.role) as membership_role, m.role_key, m.role as legacy_role, m.status as membership_status,
                m.company_id,
                COALESCE(p.phone_calls_allowed, false) as phone_calls_allowed,
                COALESCE(p.is_provider, false) as is_provider,
                p.schedule_color,
                COALESCE(p.call_masking_enabled, false) as call_masking_enabled,
                COALESCE(p.location_tracking_enabled, false) as location_tracking_enabled
         FROM crm_users u 
         ${join}
         LEFT JOIN company_user_profiles p ON p.membership_id = m.id
         ${where}
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
 * @param {{ email: string, fullName: string, keycloakSub: string, companyId: string, role: string, role_key?: string, profile?: any }} data
 */
async function createUserWithMembership(data) {
    const client = await db.pool.connect();
    try {
        await client.query('BEGIN');

        let userId;
        const { rows: existingRows } = await client.query(
            `SELECT id FROM crm_users WHERE keycloak_sub = $1 OR email = $2`,
            [data.keycloakSub, data.email]
        );
        
        if (existingRows.length > 0) {
            userId = existingRows[0].id;
        } else {
            const { rows: userRows } = await client.query(
                `INSERT INTO crm_users (keycloak_sub, email, full_name, role, company_id, status)
                 VALUES ($1, $2, $3, $4, $5, 'active')
                 RETURNING id`,
                [data.keycloakSub, data.email, data.fullName, data.role, data.companyId]
            );
            userId = userRows[0].id;
        }

        const roleKey = data.role_key || (data.role === 'company_admin' ? 'tenant_admin' : 'dispatcher');

        const { rows: memRows } = await client.query(
            `INSERT INTO company_memberships (user_id, company_id, role, role_key, is_primary)
             VALUES ($1, $2, $3, $4, true)
             ON CONFLICT (user_id, company_id) DO UPDATE SET 
                role = EXCLUDED.role,
                role_key = EXCLUDED.role_key,
                status = 'active'
             RETURNING id`,
            [userId, data.companyId, data.role, roleKey]
        );
        const membershipId = memRows[0].id;

        const p = data.profile || {};
        await client.query(
            `INSERT INTO company_user_profiles (
                membership_id, phone_calls_allowed, is_provider, schedule_color, call_masking_enabled, location_tracking_enabled
             ) VALUES ($1, $2, $3, $4, $5, $6)
             ON CONFLICT (membership_id) DO UPDATE SET
                phone_calls_allowed = EXCLUDED.phone_calls_allowed,
                is_provider = EXCLUDED.is_provider,
                schedule_color = EXCLUDED.schedule_color,
                call_masking_enabled = EXCLUDED.call_masking_enabled,
                location_tracking_enabled = EXCLUDED.location_tracking_enabled,
                updated_at = NOW()`,
             [
                 membershipId, 
                 p.phone_calls_allowed || false, 
                 p.is_provider || false, 
                 p.schedule_color || '#3B82F6', 
                 p.call_masking_enabled || false, 
                 p.location_tracking_enabled || false
             ]
        );

        await client.query('COMMIT');
        return { id: userId, email: data.email, full_name: data.fullName, role: data.role, role_key: roleKey };
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    } finally {
        client.release();
    }
}

/**
 * Update member's role and/or profile. replaces traditional changeUserRole
 */
async function updateMembershipAndProfile(userId, companyId, updates) {
    const client = await db.pool.connect();
    try {
        await client.query('BEGIN');

        // Update role if changed
        if (updates.role_key) {
            const legacyRole = updates.role_key === 'tenant_admin' ? 'company_admin' : 'company_member';
            
            const { rows } = await client.query(
                `UPDATE company_memberships 
                 SET role = $1, role_key = $2, updated_at = NOW()
                 WHERE user_id = $3 AND company_id = $4
                 RETURNING id`,
                [legacyRole, updates.role_key, userId, companyId]
            );
            if (rows.length === 0) throw new Error('Membership not found');

            await client.query(
                'UPDATE crm_users SET role = $1, updated_at = NOW() WHERE id = $2',
                [legacyRole, userId]
            );
        }

        const { rows: memRows } = await client.query(
            `SELECT id FROM company_memberships WHERE user_id = $1 AND company_id = $2`,
            [userId, companyId]
        );
        if (memRows.length === 0) throw new Error('Membership not found');
        const membershipId = memRows[0].id;

        // Update profile
        if (updates.profile) {
            const p = updates.profile;
            const fields = [];
            const values = [membershipId];
            let i = 2;

            if (typeof p.phone_calls_allowed === 'boolean') { fields.push(`phone_calls_allowed = $${i++}`); values.push(p.phone_calls_allowed); }
            if (typeof p.is_provider === 'boolean') { fields.push(`is_provider = $${i++}`); values.push(p.is_provider); }
            if (p.schedule_color) { fields.push(`schedule_color = $${i++}`); values.push(p.schedule_color); }
            if (typeof p.call_masking_enabled === 'boolean') { fields.push(`call_masking_enabled = $${i++}`); values.push(p.call_masking_enabled); }
            if (typeof p.location_tracking_enabled === 'boolean') { fields.push(`location_tracking_enabled = $${i++}`); values.push(p.location_tracking_enabled); }

            if (fields.length > 0) {
                // Upsert logic for profile
                await client.query(
                    `INSERT INTO company_user_profiles (membership_id) VALUES ($1) ON CONFLICT (membership_id) DO NOTHING`,
                    [membershipId]
                );
                await client.query(
                    `UPDATE company_user_profiles SET ${fields.join(', ')}, updated_at = NOW() WHERE membership_id = $1`,
                    values
                );
            }
        }

        await client.query('COMMIT');
        return true;
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    } finally {
        client.release();
    }
}

/**
 * Update membership status (active/inactive) with reason.
 */
async function updateMembershipStatus(userId, companyId, status, reason = null) {
    const { rows } = await db.query(
        `UPDATE company_memberships
         SET status = $1, 
             disabled_at = CASE WHEN $1 = 'inactive' THEN NOW() ELSE NULL END,
             activated_at = CASE WHEN $1 = 'active' THEN NOW() ELSE activated_at END,
             disabled_reason = $3,
             updated_at = NOW()
         WHERE user_id = $2 AND company_id = $4
         RETURNING *`,
        [status, userId, reason, companyId]
    );
    if (rows.length === 0) throw new Error('Membership not found');

    // Also sync the fallback crm_users status
    await db.query(
        `UPDATE crm_users SET status = $1, updated_at = NOW() WHERE id = $2`,
        [status, userId]
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
    updateMembershipAndProfile,
    updateMembershipStatus,
    countCompanyAdmins,
    ROLE_HIERARCHY,
};
