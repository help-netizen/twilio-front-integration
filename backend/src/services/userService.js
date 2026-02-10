/**
 * CRM User Service
 * 
 * Manages the crm_users shadow table — local profile synced from Keycloak.
 * Called by auth middleware on every authenticated request to ensure
 * the user exists locally and last_login_at is updated.
 */

const db = require('../db/connection');

/**
 * Find or create a CRM user from a Keycloak JWT payload.
 * Upserts by keycloak_sub, updating email/name/role and last_login_at.
 * 
 * @param {{ sub: string, email?: string, name?: string, preferred_username?: string, realm_roles?: string[] }} keycloakUser
 * @returns {Promise<Object>} The crm_users row
 */
async function findOrCreateUser(keycloakUser) {
    const { sub, email, name, preferred_username, realm_roles = [] } = keycloakUser;

    // Determine primary role (highest privilege)
    const roleHierarchy = ['owner_admin', 'dispatcher', 'accountant', 'technician', 'viewer'];
    const primaryRole = roleHierarchy.find(r => realm_roles.includes(r)) || 'viewer';

    const fullName = name || preferred_username || email || 'Unknown';

    const sql = `
        INSERT INTO crm_users (keycloak_sub, email, full_name, role, last_login_at, updated_at)
        VALUES ($1, $2, $3, $4, NOW(), NOW())
        ON CONFLICT (keycloak_sub) DO UPDATE SET
            email = COALESCE(EXCLUDED.email, crm_users.email),
            full_name = COALESCE(EXCLUDED.full_name, crm_users.full_name),
            role = EXCLUDED.role,
            last_login_at = NOW(),
            updated_at = NOW()
        RETURNING *
    `;

    const { rows } = await db.query(sql, [sub, email, fullName, primaryRole]);
    return rows[0];
}

/**
 * Get a CRM user by keycloak_sub.
 * @param {string} sub
 * @returns {Promise<Object|null>}
 */
async function getUserBySub(sub) {
    const { rows } = await db.query(
        'SELECT * FROM crm_users WHERE keycloak_sub = $1',
        [sub]
    );
    return rows[0] || null;
}

/**
 * List all CRM users.
 * @returns {Promise<Object[]>}
 */
async function listUsers() {
    const { rows } = await db.query(
        'SELECT * FROM crm_users ORDER BY created_at DESC'
    );
    return rows;
}

module.exports = {
    findOrCreateUser,
    getUserBySub,
    listUsers,
};
