/**
 * rolesPermissions.js — RBAC-ROLES-EDITOR-001 (RBAC-AUDIT-001 R4)
 *
 * In-app "Roles & Access" editor API. Lets a tenant admin edit the per-company
 * role permission matrix (company_role_permissions) and per-member overrides
 * (company_membership_permission_overrides). No cache to invalidate — the
 * authorization resolver reads these tables per request, so edits take effect
 * on the affected user's next /api/auth/me.
 *
 * Mounted: app.use('/api/settings/roles', authenticate, requireCompanyAccess,
 *   requirePermission('tenant.roles.manage'), router)
 *
 * Company scope is strictly req.companyFilter.company_id. Audit/created_by use
 * req.user.crmUser.id (FK → crm_users.id; NOT req.user.sub).
 */

const express = require('express');
const router = express.Router();

const roleQueries = require('../db/roleQueries');
const membershipQueries = require('../db/membershipQueries');
const userService = require('../services/userService');
const auditService = require('../services/auditService');
const authorizationService = require('../services/authorizationService');
const { PERMISSION_CATALOG, ALL_PERMISSION_KEYS } = require('../services/permissionCatalog');

const ALL_KEYS = new Set(ALL_PERMISSION_KEYS);

// Display names for role_key, matching authorizationService.formatMembership.
const ROLE_NAMES = {
    tenant_admin: 'Tenant Admin',
    manager: 'Manager',
    dispatcher: 'Dispatcher',
    provider: 'Provider',
};

function companyId(req) {
    return req.companyFilter?.company_id;
}

function actorId(req) {
    return req.user?.crmUser?.id || null;
}

// ── GET / — full role matrix for the company ────────────────────────────────
router.get('/', async (req, res) => {
    try {
        const company = companyId(req);
        // Lazy-seed defaults for companies created outside bootstrap.
        const configs = await roleQueries.ensureRoleConfigs(company, actorId(req));

        const roles = [];
        for (const cfg of configs) {
            const perms = await roleQueries.getRolePermissions(cfg.id);
            const permissions = {};
            for (const p of perms) {
                permissions[p.permission_key] = p.is_allowed;
            }
            roles.push({
                role_key: cfg.role_key,
                display_name: cfg.display_name,
                is_locked: cfg.is_locked,
                permissions,
            });
        }

        res.json({
            ok: true,
            data: {
                catalog: PERMISSION_CATALOG,
                mandatoryAdminPermissions: authorizationService.MANDATORY_ADMIN_PERMISSIONS,
                roles,
            },
        });
    } catch (err) {
        console.error('[RolesPermissions] GET / failed:', err.message);
        res.status(500).json({ ok: false, error: { code: 'INTERNAL', message: 'Failed to load role matrix' } });
    }
});

// ── PUT /:roleKey/permissions — toggle one permission on a role ─────────────
router.put('/:roleKey/permissions', async (req, res) => {
    try {
        const company = companyId(req);
        const { roleKey } = req.params;
        const { permission_key, is_allowed } = req.body || {};

        // Admin is full-access and not editable.
        if (roleKey === 'tenant_admin') {
            return res.status(400).json({
                ok: false,
                error: { code: 'ROLE_LOCKED', message: 'The Admin role is full-access and cannot be edited' },
            });
        }

        if (!ALL_KEYS.has(permission_key)) {
            return res.status(400).json({
                ok: false,
                error: { code: 'INVALID_PERMISSION', message: 'Unknown permission key' },
            });
        }

        if (typeof is_allowed !== 'boolean') {
            return res.status(400).json({
                ok: false,
                error: { code: 'INVALID_VALUE', message: 'is_allowed must be a boolean' },
            });
        }

        const roleConfig = await roleQueries.getRoleConfig(company, roleKey);
        if (!roleConfig) {
            return res.status(404).json({
                ok: false,
                error: { code: 'NOT_FOUND', message: 'Role not found' },
            });
        }

        // A locked config is not editable regardless of role_key.
        if (roleConfig.is_locked) {
            return res.status(400).json({
                ok: false,
                error: { code: 'ROLE_LOCKED', message: 'This role is locked and cannot be edited' },
            });
        }

        await roleQueries.setRolePermission(roleConfig.id, permission_key, is_allowed);

        await auditService.log({
            actor_id: actorId(req),
            actor_email: req.user?.email,
            actor_ip: req.ip,
            action: 'role_permission_changed',
            target_type: 'role_config',
            target_id: roleConfig.id,
            company_id: company,
            details: { role_key: roleKey, permission_key, is_allowed },
            trace_id: req.traceId,
        });

        // Return the role's full, updated permission map.
        const perms = await roleQueries.getRolePermissions(roleConfig.id);
        const permissions = {};
        for (const p of perms) {
            permissions[p.permission_key] = p.is_allowed;
        }

        res.json({ ok: true, data: { permissions } });
    } catch (err) {
        console.error('[RolesPermissions] PUT /:roleKey/permissions failed:', err.message);
        res.status(500).json({ ok: false, error: { code: 'INTERNAL', message: 'Failed to update role permission' } });
    }
});

// ── GET /members — company members + their overrides ────────────────────────
router.get('/members', async (req, res) => {
    try {
        const company = companyId(req);
        // Pull all members (no pagination cap for the overrides picker).
        const { users } = await userService.listUsers(company, { limit: 1000 });

        const members = [];
        for (const u of users) {
            const overrideRows = u.membership_id
                ? await membershipQueries.getPermissionOverrides(u.membership_id)
                : [];
            const overrides = {};
            for (const o of overrideRows) {
                overrides[o.permission_key] = o.override_mode;
            }
            const roleKey = u.role_key
                || (u.legacy_role === 'company_admin' ? 'tenant_admin' : 'dispatcher');
            members.push({
                membership_id: u.membership_id,
                user_id: u.id,
                name: u.full_name,
                email: u.email,
                role_key: roleKey,
                role_name: ROLE_NAMES[roleKey] || roleKey,
                status: u.membership_status,
                overrides,
            });
        }

        res.json({ ok: true, data: members });
    } catch (err) {
        console.error('[RolesPermissions] GET /members failed:', err.message);
        res.status(500).json({ ok: false, error: { code: 'INTERNAL', message: 'Failed to load members' } });
    }
});

// ── PUT /members/:membershipId/overrides — set/clear one override ────────────
router.put('/members/:membershipId/overrides', async (req, res) => {
    try {
        const company = companyId(req);
        const { membershipId } = req.params;
        const { permission_key, override_mode } = req.body || {};

        // Membership must belong to this tenant — else 404 (no cross-tenant).
        const membership = await membershipQueries.getMembershipById(membershipId);
        if (!membership || membership.company_id !== company) {
            return res.status(404).json({
                ok: false,
                error: { code: 'NOT_FOUND', message: 'Member not found' },
            });
        }

        if (!ALL_KEYS.has(permission_key)) {
            return res.status(400).json({
                ok: false,
                error: { code: 'INVALID_PERMISSION', message: 'Unknown permission key' },
            });
        }

        if (![null, 'allow', 'deny'].includes(override_mode)) {
            return res.status(400).json({
                ok: false,
                error: { code: 'INVALID_VALUE', message: "override_mode must be 'allow', 'deny', or null" },
            });
        }

        await membershipQueries.setPermissionOverride(membershipId, permission_key, override_mode);

        await auditService.log({
            actor_id: actorId(req),
            actor_email: req.user?.email,
            actor_ip: req.ip,
            action: 'member_permission_override_changed',
            target_type: 'membership',
            target_id: membershipId,
            company_id: company,
            details: { permission_key, override_mode },
            trace_id: req.traceId,
        });

        const overrideRows = await membershipQueries.getPermissionOverrides(membershipId);
        const overrides = {};
        for (const o of overrideRows) {
            overrides[o.permission_key] = o.override_mode;
        }

        res.json({ ok: true, data: { overrides } });
    } catch (err) {
        console.error('[RolesPermissions] PUT /members/:membershipId/overrides failed:', err.message);
        res.status(500).json({ ok: false, error: { code: 'INTERNAL', message: 'Failed to update override' } });
    }
});

module.exports = router;
