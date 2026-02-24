/**
 * User Management API Routes (§5, §6, §7)
 * 
 * All routes require authentication + company_admin or super_admin role.
 * 
 * POST   /            - Create user (in Keycloak + CRM DB)
 * GET    /            - List company users
 * PUT    /:id/role    - Change user role
 * PUT    /:id/disable - Disable user
 */

const express = require('express');
const router = express.Router();
const userService = require('../services/userService');
const auditService = require('../services/auditService');

/**
 * POST / — Create a new user
 * 
 * Body: { email, full_name, role }
 * Returns: { ok, user, temporary_password }
 * 
 * Creates user in Keycloak (via Admin API) and CRM DB with membership.
 * Temp password returned once (§6).
 */
router.post('/', async (req, res) => {
    try {
        const { email, full_name, role = 'company_member' } = req.body;
        const companyId = req.user.company_id;

        if (!email || !full_name) {
            return res.status(422).json({
                code: 'VALIDATION_ERROR',
                message: 'email and full_name are required',
                trace_id: req.traceId,
            });
        }

        // Validate role
        if (!['company_admin', 'company_member'].includes(role)) {
            return res.status(422).json({
                code: 'VALIDATION_ERROR',
                message: 'role must be company_admin or company_member',
                trace_id: req.traceId,
            });
        }

        // Generate temporary password
        const tempPassword = generateTempPassword();

        // Create in Keycloak (server-side admin token)
        const keycloakSub = await createKeycloakUser(email, full_name, tempPassword, role);

        // Create in CRM DB with membership
        const user = await userService.createUserWithMembership({
            keycloakSub,
            email,
            fullName: full_name,
            companyId,
            role,
        });

        // Audit
        await auditService.log({
            actor_id: req.user.crmUser?.id,
            actor_email: req.user.email,
            actor_ip: req.ip,
            action: 'user_created',
            target_type: 'user',
            target_id: user.id,
            company_id: companyId,
            details: { email, role },
            trace_id: req.traceId,
        });

        res.status(201).json({
            ok: true,
            user: { id: user.id, email, full_name, role },
            temporary_password: tempPassword, // returned once (§6)
        });
    } catch (err) {
        console.error('[Users] Create failed:', err.message);
        if (err.message.includes('duplicate key') || err.code === '23505' ||
            err.message.includes('User exists with same')) {
            return res.status(409).json({
                code: 'USER_EXISTS',
                message: 'User with this email already exists',
                trace_id: req.traceId,
            });
        }
        res.status(500).json({
            code: 'INTERNAL_ERROR',
            message: 'Failed to create user',
            trace_id: req.traceId,
        });
    }
});

/**
 * GET / — List users for the company
 * Query: ?search=&role=&status=&page=&limit=
 */
router.get('/', async (req, res) => {
    try {
        const companyId = req.user.is_super_admin ? null : req.user.company_id;
        const { search, role, status, page, limit } = req.query;
        const result = await userService.listUsers(companyId, {
            search,
            role,
            status,
            page: page ? parseInt(page, 10) : 1,
            limit: limit ? parseInt(limit, 10) : 25,
        });
        res.json({ ok: true, ...result });
    } catch (err) {
        console.error('[Users] List failed:', err.message);
        res.status(500).json({
            code: 'INTERNAL_ERROR',
            message: 'Failed to list users',
            trace_id: req.traceId,
        });
    }
});

/**
 * PUT /:id/role — Change user role
 * 
 * Body: { role }
 * Enforces last-admin invariant (§7) — DB trigger returns LAST_ADMIN_REQUIRED.
 */
router.put('/:id/role', async (req, res) => {
    try {
        const { role } = req.body;
        const userId = req.params.id;
        const companyId = req.user.company_id;

        if (!['company_admin', 'company_member'].includes(role)) {
            return res.status(422).json({
                code: 'VALIDATION_ERROR',
                message: 'role must be company_admin or company_member',
                trace_id: req.traceId,
            });
        }

        const membership = await userService.changeUserRole(userId, companyId, role);

        await auditService.log({
            actor_id: req.user.crmUser?.id,
            actor_email: req.user.email,
            actor_ip: req.ip,
            action: 'role_changed',
            target_type: 'user',
            target_id: userId,
            company_id: companyId,
            details: { new_role: role },
            trace_id: req.traceId,
        });

        res.json({ ok: true, membership });
    } catch (err) {
        console.error('[Users] Role change failed:', err.message);
        if (err.message.includes('LAST_ADMIN_REQUIRED')) {
            return res.status(409).json({
                code: 'LAST_ADMIN_REQUIRED',
                message: 'Cannot remove the last company admin',
                trace_id: req.traceId,
            });
        }
        res.status(500).json({
            code: 'INTERNAL_ERROR',
            message: 'Failed to change role',
            trace_id: req.traceId,
        });
    }
});

/**
 * PUT /:id/disable — Disable a user
 * Enforces last-admin invariant (§7).
 */
router.put('/:id/disable', async (req, res) => {
    try {
        const userId = req.params.id;
        const companyId = req.user.company_id;

        // Check last-admin invariant: if user is company_admin and they're the only one
        const adminCount = await userService.countCompanyAdmins(companyId);
        if (adminCount <= 1) {
            // Check if the target user is actually one of the admins
            const targetUsers = await userService.listUsers(companyId, { role: 'company_admin', status: 'active' });
            const isTargetAdmin = targetUsers.users.some(u => u.id === userId);
            if (isTargetAdmin) {
                return res.status(409).json({
                    code: 'LAST_ADMIN_REQUIRED',
                    message: 'Cannot disable the last company admin',
                    trace_id: req.traceId,
                });
            }
        }

        const membership = await userService.disableUser(userId, companyId);

        await auditService.log({
            actor_id: req.user.crmUser?.id,
            actor_email: req.user.email,
            actor_ip: req.ip,
            action: 'user_disabled',
            target_type: 'user',
            target_id: userId,
            company_id: companyId,
            trace_id: req.traceId,
        });

        res.json({ ok: true, message: 'User disabled' });
    } catch (err) {
        console.error('[Users] Disable failed:', err.message);
        if (err.message.includes('LAST_ADMIN_REQUIRED')) {
            return res.status(409).json({
                code: 'LAST_ADMIN_REQUIRED',
                message: 'Cannot disable the last company admin',
                trace_id: req.traceId,
            });
        }
        res.status(500).json({
            code: 'INTERNAL_ERROR',
            message: 'Failed to disable user',
            trace_id: req.traceId,
        });
    }
});

/**
 * PUT /:id/enable — Enable (re-activate) a user
 */
router.put('/:id/enable', async (req, res) => {
    try {
        const userId = req.params.id;
        const companyId = req.user.company_id;

        await userService.enableUser(userId, companyId);

        await auditService.log({
            actor_id: req.user.crmUser?.id,
            actor_email: req.user.email,
            actor_ip: req.ip,
            action: 'user_enabled',
            target_type: 'user',
            target_id: userId,
            company_id: companyId,
            trace_id: req.traceId,
        });

        res.json({ ok: true, message: 'User enabled' });
    } catch (err) {
        console.error('[Users] Enable failed:', err.message);
        res.status(500).json({
            code: 'INTERNAL_ERROR',
            message: 'Failed to enable user',
            trace_id: req.traceId,
        });
    }
});

/**
 * PUT /:id/phone-calls — Toggle phone calls access for a user
 * Body: { allowed: boolean }
 */
router.put('/:id/phone-calls', async (req, res) => {
    try {
        const userId = req.params.id;
        const companyId = req.user.company_id;
        const { allowed } = req.body;

        if (typeof allowed !== 'boolean') {
            return res.status(422).json({
                code: 'VALIDATION_ERROR',
                message: 'allowed must be a boolean',
                trace_id: req.traceId,
            });
        }

        // Auto-add column if not exists
        const db = require('../db/connection');
        await db.query(`
            DO $$ BEGIN
                ALTER TABLE company_memberships ADD COLUMN phone_calls_allowed BOOLEAN NOT NULL DEFAULT false;
            EXCEPTION WHEN duplicate_column THEN NULL;
            END $$;
        `);

        await db.query(
            `UPDATE company_memberships SET phone_calls_allowed = $1 WHERE user_id = $2 AND company_id = $3`,
            [allowed, userId, companyId]
        );

        await auditService.log({
            actor_id: req.user.crmUser?.id,
            actor_email: req.user.email,
            actor_ip: req.ip,
            action: 'phone_calls_toggled',
            target_type: 'user',
            target_id: userId,
            company_id: companyId,
            details: { phone_calls_allowed: allowed },
            trace_id: req.traceId,
        });

        res.json({ ok: true, phone_calls_allowed: allowed });
    } catch (err) {
        console.error('[Users] Phone calls toggle failed:', err.message);
        res.status(500).json({
            code: 'INTERNAL_ERROR',
            message: 'Failed to update phone calls access',
            trace_id: req.traceId,
        });
    }
});

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Generate a random temporary password.
 */
function generateTempPassword() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
    let password = '';
    for (let i = 0; i < 12; i++) {
        password += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return password;
}

/**
 * Get an admin-level access token from Keycloak.
 * Uses KEYCLOAK_ADMIN_USER / KEYCLOAK_ADMIN_PASSWORD env vars.
 */
async function getKeycloakAdminToken(kcUrl) {
    const adminUser = process.env.KEYCLOAK_ADMIN_USER || 'admin';
    const adminPass = process.env.KEYCLOAK_ADMIN_PASSWORD || 'admin';
    const res = await fetch(`${kcUrl}/realms/master/protocol/openid-connect/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            grant_type: 'password',
            client_id: 'admin-cli',
            username: adminUser,
            password: adminPass,
        }),
    });
    if (!res.ok) {
        const body = await res.text();
        throw new Error(`KC admin auth failed: ${res.status} ${body}`);
    }
    return (await res.json()).access_token;
}

/**
 * Create a user in Keycloak via Admin API.
 * Uses a server-side admin token for full permissions
 * (user creation + role assignment).
 */
async function createKeycloakUser(email, fullName, tempPassword, role) {
    const KC_URL = process.env.KEYCLOAK_REALM_URL?.replace(/\/realms\/.*$/, '');
    const REALM = process.env.KEYCLOAK_REALM || 'crm-prod';

    if (!KC_URL) {
        const crypto = require('crypto');
        return crypto.randomUUID();
    }

    const token = await getKeycloakAdminToken(KC_URL);
    const auth = { Authorization: `Bearer ${token}` };

    // Create user
    const createRes = await fetch(`${KC_URL}/admin/realms/${REALM}/users`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...auth },
        body: JSON.stringify({
            username: email,
            email,
            firstName: fullName.split(' ')[0] || fullName,
            lastName: fullName.split(' ').slice(1).join(' ') || '',
            enabled: true,
            emailVerified: true,
            credentials: [{ type: 'password', value: tempPassword, temporary: true }],
            requiredActions: ['UPDATE_PASSWORD'],
        }),
    });

    if (!createRes.ok) {
        const body = await createRes.text();
        throw new Error(`Keycloak user creation failed: ${createRes.status} ${body}`);
    }

    // Get user ID
    const usersRes = await fetch(
        `${KC_URL}/admin/realms/${REALM}/users?username=${encodeURIComponent(email)}&exact=true`,
        { headers: auth }
    );
    const users = await usersRes.json();
    if (!users.length) throw new Error('User created but not found in Keycloak');

    const kcUserId = users[0].id;

    // Assign realm role
    const roleRes = await fetch(
        `${KC_URL}/admin/realms/${REALM}/roles/${role}`,
        { headers: auth }
    );
    if (roleRes.ok) {
        const roleObj = await roleRes.json();
        const assignRes = await fetch(
            `${KC_URL}/admin/realms/${REALM}/users/${kcUserId}/role-mappings/realm`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...auth },
                body: JSON.stringify([{ id: roleObj.id, name: role }]),
            }
        );
        if (!assignRes.ok) {
            console.error(`[Users] Role assignment failed: ${assignRes.status} ${await assignRes.text()}`);
        }
    } else {
        console.warn(`[Users] Keycloak role '${role}' not found, skipping`);
    }

    return users[0].id;
}

module.exports = router;
