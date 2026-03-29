/**
 * Super Admin — Company User Management Routes
 *
 * Mounted at /api/admin/companies/:companyId/users
 * All routes require super_admin role (enforced by parent mount).
 *
 * GET    /                  — List users for a company
 * POST   /                  — Create user in a company
 * PATCH  /:userId           — Update user role/profile
 * PATCH  /:userId/status    — Enable/disable user
 * PUT    /:userId/reset-password — Reset user password
 */

const express = require('express');
const router = express.Router({ mergeParams: true });
const db = require('../db/connection');
const userService = require('../services/userService');
const auditService = require('../services/auditService');
const keycloakService = require('../services/keycloakService');

// Import createKeycloakUser from the users route helper (same pattern)
// We inline a lightweight version that delegates to the same Keycloak Admin API
async function createKeycloakUser(email, fullName, tempPassword, role) {
    const KC_URL = process.env.KEYCLOAK_REALM_URL?.replace(/\/realms\/.*$/, '');
    const REALM = process.env.KEYCLOAK_REALM || 'crm-prod';

    if (!KC_URL) {
        const crypto = require('crypto');
        return crypto.randomUUID();
    }

    const adminUser = process.env.KEYCLOAK_ADMIN_USER || 'admin';
    const adminPass = process.env.KEYCLOAK_ADMIN_PASSWORD || 'admin';
    const tokenRes = await fetch(`${KC_URL}/realms/master/protocol/openid-connect/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'password', client_id: 'admin-cli', username: adminUser, password: adminPass }),
    });
    if (!tokenRes.ok) throw new Error(`KC admin auth failed: ${tokenRes.status}`);
    const token = (await tokenRes.json()).access_token;
    const auth = { Authorization: `Bearer ${token}` };

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

    const usersRes = await fetch(
        `${KC_URL}/admin/realms/${REALM}/users?username=${encodeURIComponent(email)}&exact=true`,
        { headers: auth }
    );
    const users = await usersRes.json();
    if (!users.length) throw new Error('User created but not found in Keycloak');

    const kcUserId = users[0].id;

    // Assign realm role
    const roleRes = await fetch(`${KC_URL}/admin/realms/${REALM}/roles/${role}`, { headers: auth });
    if (roleRes.ok) {
        const roleObj = await roleRes.json();
        await fetch(`${KC_URL}/admin/realms/${REALM}/users/${kcUserId}/role-mappings/realm`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...auth },
            body: JSON.stringify([{ id: roleObj.id, name: role }]),
        });
    }

    return kcUserId;
}

/**
 * Validate that the target company exists, return company row.
 */
async function validateCompany(companyId) {
    const { rows } = await db.query('SELECT id, name, status FROM companies WHERE id = $1', [companyId]);
    return rows[0] || null;
}

// ── GET / — List users for a company ────────────────────────────────────────

router.get('/', async (req, res) => {
    try {
        const { companyId } = req.params;
        const company = await validateCompany(companyId);
        if (!company) return res.status(404).json({ code: 'COMPANY_NOT_FOUND', message: 'Company not found' });

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
        console.error('[AdminCompanyUsers] List failed:', err.message);
        res.status(500).json({ code: 'INTERNAL_ERROR', message: 'Failed to list users', trace_id: req.traceId });
    }
});

// ── POST / — Create user in a company ───────────────────────────────────────

router.post('/', async (req, res) => {
    try {
        const { companyId } = req.params;
        const company = await validateCompany(companyId);
        if (!company) return res.status(404).json({ code: 'COMPANY_NOT_FOUND', message: 'Company not found' });

        const { email, full_name, role = 'company_member', role_key, profile } = req.body;
        if (!email || !full_name) {
            return res.status(422).json({ code: 'VALIDATION_ERROR', message: 'email and full_name are required' });
        }
        if (!['company_admin', 'company_member'].includes(role)) {
            return res.status(422).json({ code: 'VALIDATION_ERROR', message: 'role must be company_admin or company_member' });
        }

        const tempPassword = keycloakService.generateTempPassword();
        const keycloakSub = await createKeycloakUser(email, full_name, tempPassword, role);

        const user = await userService.createUserWithMembership({
            keycloakSub, email, fullName: full_name, companyId, role, role_key, profile
        });

        await auditService.log({
            actor_id: req.user.crmUser?.id,
            actor_email: req.user.email,
            actor_ip: req.ip,
            action: 'admin_user_created',
            target_type: 'user',
            target_id: user.id,
            company_id: companyId,
            details: { email, role, created_by: 'super_admin' },
            trace_id: req.traceId,
        });

        res.status(201).json({ ok: true, user: { id: user.id, email, full_name, role }, temporary_password: tempPassword });
    } catch (err) {
        console.error('[AdminCompanyUsers] Create failed:', err.message);
        if (err.message.includes('duplicate key') || err.code === '23505' || err.message.includes('User exists with same')) {
            return res.status(409).json({ code: 'USER_EXISTS', message: 'User with this email already exists' });
        }
        res.status(500).json({ code: 'INTERNAL_ERROR', message: 'Failed to create user', trace_id: req.traceId });
    }
});

// ── PATCH /:userId — Update user role and profile ───────────────────────────

router.patch('/:userId', async (req, res) => {
    try {
        const { companyId, userId } = req.params;
        const company = await validateCompany(companyId);
        if (!company) return res.status(404).json({ code: 'COMPANY_NOT_FOUND', message: 'Company not found' });

        const { role_key, profile } = req.body;
        if (role_key && !['tenant_admin', 'manager', 'dispatcher', 'provider'].includes(role_key)) {
            return res.status(422).json({ code: 'VALIDATION_ERROR', message: 'Invalid role_key' });
        }

        await userService.updateMembershipAndProfile(userId, companyId, { role_key, profile });

        await auditService.log({
            actor_id: req.user.crmUser?.id,
            actor_email: req.user.email,
            actor_ip: req.ip,
            action: 'admin_user_updated',
            target_type: 'user',
            target_id: userId,
            company_id: companyId,
            details: { role_key, profile_updated: !!profile, updated_by: 'super_admin' },
            trace_id: req.traceId,
        });

        res.json({ ok: true, message: 'User updated successfully' });
    } catch (err) {
        console.error('[AdminCompanyUsers] Update failed:', err.message);
        if (err.message.includes('LAST_ADMIN_REQUIRED')) {
            return res.status(409).json({ code: 'LAST_ADMIN_REQUIRED', message: 'Cannot remove the last company admin' });
        }
        res.status(500).json({ code: 'INTERNAL_ERROR', message: 'Failed to update user', trace_id: req.traceId });
    }
});

// ── PATCH /:userId/status — Enable/disable user ────────────────────────────

router.patch('/:userId/status', async (req, res) => {
    try {
        const { companyId, userId } = req.params;
        const company = await validateCompany(companyId);
        if (!company) return res.status(404).json({ code: 'COMPANY_NOT_FOUND', message: 'Company not found' });

        const { status, reason } = req.body;
        if (!['active', 'inactive'].includes(status)) {
            return res.status(422).json({ code: 'VALIDATION_ERROR', message: 'status must be active or inactive' });
        }

        if (status === 'inactive') {
            const adminCount = await userService.countCompanyAdmins(companyId);
            if (adminCount <= 1) {
                const targetUsers = await userService.listUsers(companyId, { role: 'company_admin', status: 'active' });
                const isTargetAdmin = targetUsers.users.some(u => u.id === userId);
                if (isTargetAdmin) {
                    return res.status(409).json({ code: 'LAST_ADMIN_REQUIRED', message: 'Cannot disable the last company admin' });
                }
            }
        }

        await userService.updateMembershipStatus(userId, companyId, status, reason);

        await auditService.log({
            actor_id: req.user.crmUser?.id,
            actor_email: req.user.email,
            actor_ip: req.ip,
            action: status === 'active' ? 'admin_user_enabled' : 'admin_user_disabled',
            target_type: 'user',
            target_id: userId,
            company_id: companyId,
            details: { reason, changed_by: 'super_admin' },
            trace_id: req.traceId,
        });

        res.json({ ok: true, message: `User ${status}` });
    } catch (err) {
        console.error('[AdminCompanyUsers] Status change failed:', err.message);
        res.status(500).json({ code: 'INTERNAL_ERROR', message: 'Failed to change user status', trace_id: req.traceId });
    }
});

// ── PUT /:userId/reset-password — Reset user password ───────────────────────

router.put('/:userId/reset-password', async (req, res) => {
    try {
        const { companyId, userId } = req.params;
        const company = await validateCompany(companyId);
        if (!company) return res.status(404).json({ code: 'COMPANY_NOT_FOUND', message: 'Company not found' });

        // Look up the user's keycloak_sub and verify they belong to this company
        const { rows: userRows } = await db.query(
            `SELECT u.id, u.keycloak_sub, u.email, u.full_name
             FROM crm_users u
             JOIN company_memberships m ON m.user_id = u.id
             WHERE u.id = $1 AND m.company_id = $2`,
            [userId, companyId]
        );

        if (userRows.length === 0) {
            return res.status(404).json({ code: 'USER_NOT_FOUND', message: 'User not found in this company' });
        }

        const user = userRows[0];
        const tempPassword = keycloakService.generateTempPassword();

        let keycloakSub = user.keycloak_sub;

        // Try resetting password; if user doesn't exist in Keycloak, create them first
        try {
            if (!keycloakSub) throw new Error('No keycloak_sub');
            await keycloakService.resetUserPassword(keycloakSub, tempPassword, true);
        } catch (resetErr) {
            // User not found in Keycloak — provision them
            console.log(`[AdminCompanyUsers] KC user not found for ${user.email}, creating...`);
            const membership = await db.query(
                'SELECT role FROM company_memberships WHERE user_id = $1 AND company_id = $2',
                [userId, companyId]
            );
            const role = membership.rows[0]?.role || 'company_member';
            const newKcSub = await createKeycloakUser(user.email, user.full_name, tempPassword, role);

            // Update crm_users with the new keycloak_sub
            await db.query(
                'UPDATE crm_users SET keycloak_sub = $1, updated_at = NOW() WHERE id = $2',
                [newKcSub, userId]
            );
            keycloakSub = newKcSub;
            console.log(`[AdminCompanyUsers] KC user created for ${user.email}: ${newKcSub}`);
        }

        await auditService.log({
            actor_id: req.user.crmUser?.id,
            actor_email: req.user.email,
            actor_ip: req.ip,
            action: 'admin_password_reset',
            target_type: 'user',
            target_id: userId,
            company_id: companyId,
            details: { target_email: user.email, reset_by: 'super_admin' },
            trace_id: req.traceId,
        });

        res.json({ ok: true, temporary_password: tempPassword });
    } catch (err) {
        console.error('[AdminCompanyUsers] Password reset failed:', err.message);
        res.status(500).json({ code: 'INTERNAL_ERROR', message: 'Failed to reset password', trace_id: req.traceId });
    }
});

module.exports = router;
