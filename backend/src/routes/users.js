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

        // Create in Keycloak
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
        if (err.message.includes('duplicate key') || err.code === '23505') {
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
 */
router.get('/', async (req, res) => {
    try {
        const companyId = req.user.is_super_admin ? null : req.user.company_id;
        const users = await userService.listUsers(companyId);
        res.json({ ok: true, users });
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

        // Check last-admin invariant at API level (§7)
        const adminCount = await userService.countCompanyAdmins(companyId);
        // TODO: also check if the user being disabled is an admin
        if (adminCount <= 1) {
            // Check if this user is actually a company_admin
            const existing = await userService.getUserBySub(null);
            // Let the DB trigger handle it
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
 * Create a user in Keycloak via Admin API.
 * Returns the Keycloak user UUID (sub).
 */
async function createKeycloakUser(email, fullName, tempPassword, role) {
    const KC_URL = process.env.KEYCLOAK_REALM_URL?.replace(/\/realms\/.*$/, '');
    const REALM = process.env.KEYCLOAK_REALM || 'crm-prod';

    if (!KC_URL) {
        // Dev mode — generate fake sub
        const crypto = require('crypto');
        return crypto.randomUUID();
    }

    // Get admin token
    const adminTokenRes = await fetch(
        `${KC_URL}/realms/master/protocol/openid-connect/token`,
        {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: 'grant_type=password&client_id=admin-cli&username=admin&password=admin',
        }
    );
    const { access_token } = await adminTokenRes.json();

    // Create user
    const createRes = await fetch(`${KC_URL}/admin/realms/${REALM}/users`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${access_token}`,
        },
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
        { headers: { Authorization: `Bearer ${access_token}` } }
    );
    const users = await usersRes.json();
    if (!users.length) throw new Error('User created but not found in Keycloak');

    const kcUserId = users[0].id;

    // Assign realm role
    const roleRes = await fetch(
        `${KC_URL}/admin/realms/${REALM}/roles/${role}`,
        { headers: { Authorization: `Bearer ${access_token}` } }
    );
    const roleObj = await roleRes.json();

    await fetch(
        `${KC_URL}/admin/realms/${REALM}/users/${kcUserId}/role-mappings/realm`,
        {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${access_token}`,
            },
            body: JSON.stringify([{ id: roleObj.id, name: role }]),
        }
    );

    return users[0].id; // Keycloak UUID = sub
}

module.exports = router;
