/**
 * Membership Queries — PF007
 * 
 * Data access for company_memberships + override tables.
 */

const db = require('./connection');

/**
 * Get the primary active membership for a user.
 * Prefers is_primary = true, then falls back to most recent active.
 */
async function getActiveMembership(userId) {
    const { rows } = await db.query(
        `SELECT m.id, m.user_id, m.company_id, m.role, m.role_key, m.status,
                m.is_primary, m.invited_by, m.invited_at, m.activated_at,
                m.disabled_at, m.disabled_reason,
                m.created_at, m.updated_at,
                c.name as company_name, c.slug as company_slug,
                c.status as company_status, c.timezone as company_timezone
         FROM company_memberships m
         JOIN companies c ON c.id = m.company_id
         WHERE m.user_id = $1 AND m.status = 'active'
         ORDER BY m.is_primary DESC, m.created_at ASC
         LIMIT 1`,
        [userId]
    );
    return rows[0] || null;
}

/**
 * Get membership by ID.
 */
async function getMembershipById(membershipId) {
    const { rows } = await db.query(
        `SELECT m.*, c.name as company_name, c.slug as company_slug,
                c.status as company_status, c.timezone as company_timezone
         FROM company_memberships m
         JOIN companies c ON c.id = m.company_id
         WHERE m.id = $1`,
        [membershipId]
    );
    return rows[0] || null;
}

/**
 * Get permission overrides for a membership.
 */
async function getPermissionOverrides(membershipId) {
    const { rows } = await db.query(
        `SELECT permission_key, override_mode
         FROM company_membership_permission_overrides
         WHERE membership_id = $1`,
        [membershipId]
    );
    return rows;
}

/**
 * Get scope overrides for a membership.
 */
async function getScopeOverrides(membershipId) {
    const { rows } = await db.query(
        `SELECT scope_key, scope_json
         FROM company_membership_scope_overrides
         WHERE membership_id = $1`,
        [membershipId]
    );
    return rows;
}

/**
 * Count active tenant admins in a company.
 * Checks both legacy role and new role_key columns.
 */
async function countActiveAdmins(companyId) {
    const { rows } = await db.query(
        `SELECT COUNT(*) as count FROM company_memberships
         WHERE company_id = $1
           AND (role = 'company_admin' OR role_key = 'tenant_admin')
           AND status = 'active'`,
        [companyId]
    );
    return parseInt(rows[0].count, 10);
}

/**
 * Get user profile for a membership.
 */
async function getUserProfile(membershipId) {
    const { rows } = await db.query(
        `SELECT * FROM company_user_profiles WHERE membership_id = $1`,
        [membershipId]
    );
    return rows[0] || null;
}

module.exports = {
    getActiveMembership,
    getMembershipById,
    getPermissionOverrides,
    getScopeOverrides,
    countActiveAdmins,
    getUserProfile,
};
