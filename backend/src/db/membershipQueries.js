/**
 * Membership Queries — PF007
 * 
 * Data access for company_memberships + override tables.
 */

const db = require('./connection');

function queryFor(client) {
    return client?.query ? client.query.bind(client) : db.query;
}

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
                c.status as company_status, c.timezone as company_timezone,
                COALESCE(c.app_studio_enabled, false) AS company_app_studio_enabled
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
async function getPermissionOverrides(membershipId, client = null) {
    const { rows } = await queryFor(client)(
        `SELECT permission_key, override_mode
         FROM company_membership_permission_overrides
         WHERE membership_id = $1`,
        [membershipId]
    );
    return rows;
}

/**
 * Set (or clear) a single per-member permission override (RBAC-ROLES-EDITOR-001).
 *
 * overrideMode:
 *   'allow' | 'deny' → upsert the override row for (membership_id, permission_key)
 *   null             → DELETE the override row (revert to the role default)
 *
 * Returns the upserted row for allow/deny, or null when clearing.
 */
async function setPermissionOverride(membershipId, permissionKey, overrideMode) {
    if (overrideMode === null || overrideMode === undefined) {
        await db.query(
            `DELETE FROM company_membership_permission_overrides
             WHERE membership_id = $1 AND permission_key = $2`,
            [membershipId, permissionKey]
        );
        return null;
    }
    const { rows } = await db.query(
        `INSERT INTO company_membership_permission_overrides (membership_id, permission_key, override_mode)
         VALUES ($1, $2, $3)
         ON CONFLICT (membership_id, permission_key)
         DO UPDATE SET override_mode = EXCLUDED.override_mode
         RETURNING permission_key, override_mode`,
        [membershipId, permissionKey, overrideMode]
    );
    return rows[0];
}

/**
 * Get scope overrides for a membership.
 */
async function getScopeOverrides(membershipId, client = null) {
    const { rows } = await queryFor(client)(
        `SELECT scope_key, scope_json
         FROM company_membership_scope_overrides
         WHERE membership_id = $1`,
        [membershipId]
    );
    return rows;
}

/**
 * Resolve one active human membership inside an explicitly selected company.
 * Unlike getActiveMembership(), this never falls back to another/primary
 * company and may participate in the caller's transaction.
 */
async function getActiveMembershipInCompany(userId, companyId, client = null) {
    if (!userId || !companyId) return null;
    const { rows } = await queryFor(client)(
        `SELECT m.id, m.user_id, m.company_id, m.role, m.role_key, m.status,
                m.is_primary, m.created_at, m.updated_at,
                c.name AS company_name, c.slug AS company_slug,
                c.status AS company_status,
                COALESCE(c.timezone, 'America/New_York') AS company_timezone,
                COALESCE(c.app_studio_enabled, false) AS company_app_studio_enabled,
                u.keycloak_sub, u.email, u.full_name,
                u.status AS user_status, u.onboarding_status, u.kind
         FROM company_memberships m
         JOIN companies c
           ON c.id = m.company_id
          AND c.id = $2
          AND c.status = 'active'
         JOIN crm_users u
           ON u.id = m.user_id
          AND u.id = $1
          AND u.status = 'active'
          AND u.onboarding_status = 'active'
          AND COALESCE(u.kind, 'user') = 'user'
         WHERE m.user_id = $1
           AND m.company_id = $2
           AND m.status = 'active'`,
        [userId, companyId]
    );
    return rows.length === 1 ? rows[0] : null;
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

/**
 * Get a user's membership + profile inside ONE company (tenant-safe).
 * Returns null when the user has no membership in that company — callers
 * must translate that into 404, never fall back to a cross-company lookup.
 */
async function getMembershipWithProfile(userId, companyId) {
    if (!userId || !companyId) return null;
    const { rows } = await db.query(
        `SELECT m.id as membership_id, m.user_id, m.company_id,
                COALESCE(m.role_key, m.role) as role_key, m.role as legacy_role,
                m.status as membership_status, m.is_primary,
                m.invited_at, m.activated_at, m.disabled_at, m.disabled_reason,
                u.email, u.full_name, u.last_login_at, u.created_at as user_created_at,
                p.phone, p.schedule_color,
                COALESCE(p.is_provider, false) as is_provider,
                COALESCE(p.location_tracking_enabled, false) as location_tracking_enabled,
                COALESCE(p.phone_calls_allowed, false) as phone_calls_allowed,
                p.job_close_mode
         FROM company_memberships m
         JOIN crm_users u ON u.id = m.user_id
         LEFT JOIN company_user_profiles p ON p.membership_id = m.id
         WHERE m.user_id = $1 AND m.company_id = $2`,
        [userId, companyId]
    );
    return rows[0] || null;
}

/**
 * Resolve assignment-compatible technician ids to internal crm_users.id,
 * strictly inside one company. Native technician UUIDs and mapped external ids
 * use the native directory's crm_user_id link. The returned authorization plane
 * remains crm_users.id only.
 *
 * @param {string} companyId - tenant company id (required)
 * @param {string[]} externalIds - native UUIDs or inbound compatibility ids
 * @returns {Promise<string[]>} sorted unique crm_users.id values
 */
async function resolveProviderUserIds(companyId, externalIds) {
    if (!companyId || !Array.isArray(externalIds) || externalIds.length === 0) return [];
    const ids = externalIds.map(v => String(v)).filter(Boolean);
    if (ids.length === 0) return [];
    const { rows } = await db.query(
        `SELECT DISTINCT m.user_id
         FROM company_memberships m
         LEFT JOIN company_user_profiles p ON p.membership_id = m.id
         LEFT JOIN technicians t
           ON t.company_id = m.company_id
          AND t.crm_user_id = m.user_id
          AND t.active = TRUE
         LEFT JOIN technician_external_identities e
           ON e.company_id = t.company_id
          AND e.source = 'zenbooker'
          AND e.technician_id = t.id
         WHERE m.company_id = $1
           AND m.status = 'active'
           AND (
                t.id::text = ANY($2::text[])
                OR e.external_id = ANY($2::text[])
           )`,
        [companyId, ids]
    );
    return rows.map(r => String(r.user_id)).sort();
}

/**
 * ZB-DECOUPLE C3b/E — the technician projection's source set: every ACTIVE
 * field worker in the company. A field worker is a user whose role is
 * `provider` OR who has the "Also works in the field" flag
 * (company_user_profiles.is_provider) set — owner 2026-08-09: office roles that
 * also run jobs become native technicians too.
 */
async function listActiveFieldWorkerMemberships(companyId) {
    const { rows } = await db.query(
        `SELECT m.user_id, u.full_name, u.email
         FROM company_memberships m
         JOIN crm_users u
           ON u.id = m.user_id
          AND u.status = 'active'
          AND u.onboarding_status = 'active'
          AND COALESCE(u.kind, 'user') = 'user'
         LEFT JOIN company_user_profiles p ON p.membership_id = m.id
         WHERE m.company_id = $1
           AND m.status = 'active'
           AND (m.role_key = 'provider' OR COALESCE(p.is_provider, false) = true)`,
        [companyId]
    );
    return rows;
}

module.exports = {
    getActiveMembership,
    getMembershipById,
    getActiveMembershipInCompany,
    getPermissionOverrides,
    setPermissionOverride,
    getScopeOverrides,
    countActiveAdmins,
    getUserProfile,
    getMembershipWithProfile,
    resolveProviderUserIds,
    listActiveFieldWorkerMemberships,
};
