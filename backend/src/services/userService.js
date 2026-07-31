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
 * @param {{ sub: string, email?: string, name?: string, preferred_username?: string, realm_roles?: string[], issued_at?: number }} keycloakUser
 * @returns {Promise<Object>} The crm_users row with company_id
 */
async function findOrCreateUser(keycloakUser) {
    const { sub, email, name, preferred_username, realm_roles = [], issued_at } = keycloakUser;

    // Determine primary role from token
    const primaryRole = ROLE_HIERARCHY.find(r => realm_roles.includes(r)) || 'company_member';
    const fullName = name || preferred_username || email || 'Unknown';

    // Upsert into crm_users
    const { rows } = await db.query(
        `INSERT INTO crm_users (keycloak_sub, email, full_name, role, last_login_at, updated_at)
         VALUES ($1, $2, $3, $4, NOW(), NOW())
         ON CONFLICT (keycloak_sub) DO UPDATE SET
             email = CASE
                 WHEN $5::BIGINT IS NULL OR crm_users.updated_at <= TO_TIMESTAMP($5)
                 THEN COALESCE(EXCLUDED.email, crm_users.email)
                 ELSE crm_users.email
             END,
             full_name = CASE
                 WHEN $5::BIGINT IS NULL OR crm_users.updated_at <= TO_TIMESTAMP($5)
                 THEN COALESCE(EXCLUDED.full_name, crm_users.full_name)
                 ELSE crm_users.full_name
             END,
             role = EXCLUDED.role,
             last_login_at = NOW(),
             updated_at = NOW()
         RETURNING *`,
        [sub, email, fullName, primaryRole, Number.isInteger(issued_at) ? issued_at : null]
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
        // Filter by the modern role_key vocabulary (tenant_admin / manager /
        // dispatcher / provider). Legacy rows (role_key IS NULL) are normalized
        // from the old role column the same way the API/UI derive membership_role,
        // so the filter matches exactly what the table renders.
        conditions.push(`COALESCE(m.role_key, CASE WHEN m.role = 'company_admin' THEN 'tenant_admin' ELSE 'dispatcher' END) = $${i++}`);
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
                m.id as membership_id, m.company_id,
                p.phone,
                COALESCE(p.phone_calls_allowed, false) as phone_calls_allowed,
                COALESCE(p.is_provider, false) as is_provider,
                p.schedule_color,
                COALESCE(p.location_tracking_enabled, false) as location_tracking_enabled,
                p.zenbooker_team_member_id
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
 * Active members whose profile has no phone number, optionally restricted to a
 * set of role_keys. Returns the SAME row shape as listUsers so the caller can
 * feed a row straight into the edit dialog. Used by the Call Masking settings
 * page (#83) to surface techs who can't place masked calls until a number is on
 * file. Not paginated — the set is small (people missing a phone).
 */
async function listActiveUsersMissingPhone(companyId, roleKeys = []) {
    if (!companyId) return [];
    const params = [companyId];
    let i = 2;
    let roleFilter = '';
    if (Array.isArray(roleKeys) && roleKeys.length > 0) {
        roleFilter = `AND COALESCE(m.role_key, CASE WHEN m.role = 'company_admin' THEN 'tenant_admin' ELSE 'dispatcher' END) = ANY($${i++}::text[])`;
        params.push(roleKeys);
    }
    const { rows } = await db.query(
        `SELECT u.id, u.email, u.full_name, u.last_login_at, u.created_at,
                COALESCE(m.role_key, m.role) as membership_role, m.role_key, m.role as legacy_role, m.status as membership_status,
                m.id as membership_id, m.company_id,
                p.phone,
                COALESCE(p.phone_calls_allowed, false) as phone_calls_allowed,
                COALESCE(p.is_provider, false) as is_provider,
                p.schedule_color,
                COALESCE(p.location_tracking_enabled, false) as location_tracking_enabled,
                p.zenbooker_team_member_id
         FROM crm_users u
         JOIN company_memberships m ON m.user_id = u.id
         LEFT JOIN company_user_profiles p ON p.membership_id = m.id
         WHERE m.company_id = $1
           AND m.status = 'active'
           AND (p.phone IS NULL OR btrim(p.phone) = '')
           ${roleFilter}
         ORDER BY COALESCE(m.role_key, 'dispatcher'), u.full_name`,
        params
    );
    return rows;
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
                membership_id, phone, phone_calls_allowed, is_provider, schedule_color, location_tracking_enabled
             ) VALUES ($1, $2, $3, $4, $5, $6)
             ON CONFLICT (membership_id) DO UPDATE SET
                phone = EXCLUDED.phone,
                phone_calls_allowed = EXCLUDED.phone_calls_allowed,
                is_provider = EXCLUDED.is_provider,
                schedule_color = EXCLUDED.schedule_color,
                location_tracking_enabled = EXCLUDED.location_tracking_enabled,
                updated_at = NOW()`,
             [
                 membershipId,
                 p.phone === null || p.phone === undefined || String(p.phone).trim() === ''
                     ? null
                     : String(p.phone).trim(),
                 p.phone_calls_allowed || false,
                 p.is_provider || false,
                 p.schedule_color || '#3B82F6',
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

        const { rows: targetRows } = await client.query(
            `SELECT m.id AS membership_id, u.email, u.full_name,
                    (SELECT COUNT(*)::INTEGER
                     FROM company_memberships all_m
                     WHERE all_m.user_id = u.id) AS membership_count
             FROM company_memberships m
             JOIN crm_users u ON u.id = m.user_id
             WHERE m.user_id = $1 AND m.company_id = $2
             FOR UPDATE OF m, u`,
            [userId, companyId]
        );
        if (targetRows.length === 0) throw serviceError('MEMBERSHIP_NOT_FOUND', 'Membership not found');
        const target = targetRows[0];
        const identityChanging = (
            (updates.full_name !== undefined && updates.full_name !== target.full_name)
            || (updates.email !== undefined
                && String(updates.email).toLowerCase() !== String(target.email || '').toLowerCase())
        );
        if (identityChanging && target.membership_count > 1) {
            throw serviceError(
                'SHARED_IDENTITY_REQUIRES_PLATFORM_ADMIN',
                'This identity belongs to more than one company'
            );
        }
        if (updates.expected_email !== undefined
            && String(target.email || '').toLowerCase() !== String(updates.expected_email || '').toLowerCase()) {
            throw serviceError('USER_IDENTITY_CHANGED', 'User identity changed during update');
        }

        if (updates.email !== undefined) {
            const { rows: conflictRows } = await client.query(
                `SELECT 1
                 FROM company_memberships conflict_m
                 JOIN crm_users conflict_u ON conflict_u.id = conflict_m.user_id
                 WHERE conflict_m.company_id = $1
                   AND conflict_u.id <> $2
                   AND LOWER(TRIM(conflict_u.email)) = LOWER(TRIM($3))
                 LIMIT 1`,
                [companyId, userId, updates.email]
            );
            if (conflictRows.length > 0) {
                throw serviceError('EMAIL_IN_USE', 'Email is already used by another company member');
            }
        }

        const userFields = [];
        const userValues = [];
        if (updates.full_name !== undefined) {
            userValues.push(updates.full_name);
            userFields.push(`full_name = $${userValues.length}`);
        }
        if (updates.email !== undefined) {
            userValues.push(updates.email);
            userFields.push(`email = $${userValues.length}`);
        }
        if (userFields.length > 0) {
            userValues.push(userId, companyId);
            await client.query(
                `UPDATE crm_users
                 SET ${userFields.join(', ')}, updated_at = NOW()
                 WHERE id = $${userValues.length - 1}
                   AND EXISTS (
                       SELECT 1
                       FROM company_memberships scoped_m
                       WHERE scoped_m.user_id = crm_users.id
                         AND scoped_m.company_id = $${userValues.length}
                   )`,
                userValues
            );
        }

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

            // crm_users.role is only a legacy single-company fallback. For a
            // multi-company identity, changing it would bleed company A's role
            // into company B even though memberships are authoritative.
            if (target.membership_count === 1) {
                await client.query(
                    `UPDATE crm_users
                     SET role = $1, updated_at = NOW()
                     WHERE id = $2
                       AND EXISTS (
                           SELECT 1
                           FROM company_memberships scoped_m
                           WHERE scoped_m.user_id = crm_users.id
                             AND scoped_m.company_id = $3
                       )`,
                    [legacyRole, userId, companyId]
                );
            }
        }

        const membershipId = target.membership_id;

        // Update profile
        const changes = { membershipId, providerBridgeChanged: false, previousTeamMemberId: undefined, newTeamMemberId: undefined };
        if (updates.profile) {
            const p = updates.profile;
            const fields = [];
            const values = [membershipId];
            let i = 2;

            if ('phone' in p) {
                fields.push(`phone = $${i++}`);
                values.push(p.phone === null || p.phone === undefined || String(p.phone).trim() === ''
                    ? null
                    : String(p.phone).trim());
            }
            if (typeof p.phone_calls_allowed === 'boolean') { fields.push(`phone_calls_allowed = $${i++}`); values.push(p.phone_calls_allowed); }
            if (typeof p.is_provider === 'boolean') { fields.push(`is_provider = $${i++}`); values.push(p.is_provider); }
            if (p.schedule_color) { fields.push(`schedule_color = $${i++}`); values.push(p.schedule_color); }
            if (typeof p.location_tracking_enabled === 'boolean') { fields.push(`location_tracking_enabled = $${i++}`); values.push(p.location_tracking_enabled); }

            // Provider bridge (PF007-HARDENING-001): external Zenbooker team member id.
            // Integration mapping only — ownership stays on crm_users.id.
            if ('zenbooker_team_member_id' in p) {
                const raw = p.zenbooker_team_member_id;
                const normalized = (raw === null || raw === undefined || String(raw).trim() === '')
                    ? null
                    : String(raw).trim();

                const { rows: prevRows } = await client.query(
                    `SELECT zenbooker_team_member_id FROM company_user_profiles WHERE membership_id = $1`,
                    [membershipId]
                );
                const previous = prevRows[0]?.zenbooker_team_member_id ?? null;

                if (previous !== normalized) {
                    changes.providerBridgeChanged = true;
                    changes.previousTeamMemberId = previous;
                    changes.newTeamMemberId = normalized;
                }
                fields.push(`zenbooker_team_member_id = $${i++}`);
                values.push(normalized);
            }

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

        const { rows: updatedRows } = await client.query(
            `SELECT u.email, u.full_name, p.phone
             FROM crm_users u
             JOIN company_memberships m ON m.user_id = u.id AND m.company_id = $2
             LEFT JOIN company_user_profiles p ON p.membership_id = m.id
             WHERE u.id = $1`,
            [userId, companyId]
        );

        await client.query('COMMIT');
        changes.user = updatedRows[0];
        return changes;
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    } finally {
        client.release();
    }
}

function serviceError(code, message) {
    const err = new Error(message);
    err.code = code;
    return err;
}

/**
 * Resolve one member's editable identity inside one company.
 * The membership count is intentionally returned only as a boolean-relevant
 * count; no foreign-company attributes leave this tenant-scoped query.
 */
async function getManagedUser(userId, companyId) {
    if (!userId || !companyId) return null;
    const { rows } = await db.query(
        `SELECT u.id, u.keycloak_sub, u.email, u.full_name, u.updated_at,
                m.id AS membership_id, p.phone,
                (SELECT COUNT(*)::INTEGER
                 FROM company_memberships all_m
                 WHERE all_m.user_id = u.id) AS membership_count
         FROM company_memberships m
         JOIN crm_users u ON u.id = m.user_id
         LEFT JOIN company_user_profiles p ON p.membership_id = m.id
         WHERE m.user_id = $1 AND m.company_id = $2`,
        [userId, companyId]
    );
    return rows[0] || null;
}

async function companyEmailIsInUse(companyId, userId, email) {
    const { rows } = await db.query(
        `SELECT EXISTS (
             SELECT 1
             FROM company_memberships m
             JOIN crm_users u ON u.id = m.user_id
             WHERE m.company_id = $1
               AND u.id <> $2
               AND LOWER(TRIM(u.email)) = LOWER(TRIM($3))
         ) AS in_use`,
        [companyId, userId, email]
    );
    return rows[0]?.in_use === true;
}

/**
 * Get one user's membership + profile inside the current company (tenant-safe).
 * Returns null when the user does not belong to the company — the route maps
 * that to 404 so foreign-company user ids are indistinguishable from missing.
 */
async function getUserDetail(userId, companyId) {
    const membershipQueries = require('../db/membershipQueries');
    const row = await membershipQueries.getMembershipWithProfile(userId, companyId);
    if (!row) return null;
    return {
        id: userId,
        email: row.email,
        full_name: row.full_name,
        last_login_at: row.last_login_at,
        created_at: row.user_created_at,
        membership: {
            id: row.membership_id,
            role_key: row.role_key,
            legacy_role: row.legacy_role,
            status: row.membership_status,
            is_primary: row.is_primary,
            invited_at: row.invited_at,
            activated_at: row.activated_at,
            disabled_at: row.disabled_at,
            disabled_reason: row.disabled_reason,
        },
        profile: {
            phone: row.phone,
            schedule_color: row.schedule_color,
            is_provider: row.is_provider,
            location_tracking_enabled: row.location_tracking_enabled,
            phone_calls_allowed: row.phone_calls_allowed,
            job_close_mode: row.job_close_mode,
            zenbooker_team_member_id: row.zenbooker_team_member_id,
        },
    };
}

/**
 * Update membership status (active/inactive) with reason.
 */
async function updateMembershipStatus(userId, companyId, status, reason = null) {
    // $1 (status) must NOT also be compared against text literals in the CASE arms —
    // `status = $1` fixes $1 to the membership status enum while `$1 = 'inactive'` wants
    // text, so Postgres throws "inconsistent types deduced for parameter $1" and every
    // enable/disable fails (DISABLE-BUG). Pass the inactive flag as its own boolean param.
    const isInactive = status === 'inactive';
    const { rows } = await db.query(
        `UPDATE company_memberships
         SET status = $1,
             disabled_at = CASE WHEN $5 THEN NOW() ELSE NULL END,
             activated_at = CASE WHEN $5 THEN activated_at ELSE NOW() END,
             disabled_reason = $3,
             updated_at = NOW()
         WHERE user_id = $2 AND company_id = $4
         RETURNING *`,
        [status, userId, reason, companyId, isInactive]
    );
    if (rows.length === 0) throw new Error('Membership not found');

    // Sync the fallback crm_users status — but the two tables use DIFFERENT
    // vocabularies: company_memberships.status is 'active'/'inactive', while
    // crm_users has CHECK (status IN ('active','disabled')). Writing 'inactive'
    // straight through violates crm_users_status_check and makes the whole
    // disable throw "Failed to change user status" (DISABLE-BUG, layer 2 — the
    // param-type fix only unmasked this). Map the membership status to the
    // crm_users domain.
    const crmUserStatus = status === 'active' ? 'active' : 'disabled';
    await db.query(
        `UPDATE crm_users SET status = $1, updated_at = NOW() WHERE id = $2`,
        [crmUserStatus, userId]
    );

    return rows[0];
}

/**
 * Remove (fully unlink) a member from a company (#86 DELETE-DISABLED-USER).
 * Only permitted on an already-inactive membership; callers enforce the last-admin
 * invariant beforehand. The Keycloak identity + crm_users row are preserved (the
 * person may belong to other companies); we sever only this company's links.
 *
 * Deletion order respects the FK web:
 *   1. NULL crm_users.primary_membership_id pointing at this membership (045 FK is RESTRICT).
 *   2. Delete chatgpt_mcp_bindings for (user, company) (200 FK is ON DELETE RESTRICT).
 *   3. DELETE the membership → company_user_profiles / _service_areas / _skills /
 *      permission_overrides cascade (047/048 ON DELETE CASCADE).
 *   4. Re-point crm_users.company_id / primary_membership_id at a remaining membership,
 *      or NULL when none is left — so a single-company user is fully detached and a
 *      multi-company user keeps a valid primary.
 *
 * @throws Error with .code 'MEMBERSHIP_NOT_FOUND' | 'USER_STILL_ACTIVE'
 */
async function removeMembership(userId, companyId) {
    const client = await db.pool.connect();
    try {
        await client.query('BEGIN');

        const { rows } = await client.query(
            `SELECT id, status FROM company_memberships
             WHERE user_id = $1 AND company_id = $2 FOR UPDATE`,
            [userId, companyId]
        );
        if (rows.length === 0) {
            const e = new Error('Membership not found');
            e.code = 'MEMBERSHIP_NOT_FOUND';
            throw e;
        }
        if (rows[0].status === 'active') {
            const e = new Error('User is still active — disable before removing');
            e.code = 'USER_STILL_ACTIVE';
            throw e;
        }
        const membershipId = rows[0].id;

        await client.query(
            `UPDATE crm_users SET primary_membership_id = NULL, updated_at = NOW()
             WHERE primary_membership_id = $1`,
            [membershipId]
        );

        await client.query(
            `DELETE FROM chatgpt_mcp_bindings WHERE owner_user_id = $1 AND company_id = $2`,
            [userId, companyId]
        );

        await client.query(`DELETE FROM company_memberships WHERE id = $1`, [membershipId]);

        // Re-point the identity's legacy fallbacks at a surviving membership (or NULL).
        await client.query(
            `UPDATE crm_users u SET
                company_id = rem.company_id,
                primary_membership_id = rem.membership_id,
                updated_at = NOW()
             FROM (
                SELECT m.company_id, m.id AS membership_id
                FROM company_memberships m
                WHERE m.user_id = $1
                ORDER BY m.is_primary DESC, m.created_at ASC
                LIMIT 1
             ) rem
             WHERE u.id = $1`,
            [userId]
        );
        // If no membership survived, the correlated UPDATE above is a no-op; clear the
        // stale pointer at this company explicitly.
        await client.query(
            `UPDATE crm_users SET company_id = NULL, updated_at = NOW()
             WHERE id = $1 AND company_id = $2
               AND NOT EXISTS (SELECT 1 FROM company_memberships m WHERE m.user_id = $1)`,
            [userId, companyId]
        );

        await client.query('COMMIT');
        return { removed: true };
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    } finally {
        client.release();
    }
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
    listActiveUsersMissingPhone,
    createUserWithMembership,
    updateMembershipAndProfile,
    updateMembershipStatus,
    removeMembership,
    countCompanyAdmins,
    getUserDetail,
    getManagedUser,
    companyEmailIsInUse,
    ROLE_HIERARCHY,
};
