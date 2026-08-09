/**
 * User Management API Routes (§5, §6, §7)
 * 
 * The parent mount requires authentication, tenant.users.manage, and company
 * context. Identity/profile mutations below additionally require tenant_admin.
 * 
 * POST   /            - Create user (in Keycloak + CRM DB)
 * GET    /            - List company users
 * PATCH  /:id         - Manage a company member
 * PATCH  /:id/status  - Enable/disable a company member
 * POST   /:id/reset-password - Email a set-password link
 */

const express = require('express');
const router = express.Router();
const userService = require('../services/userService');
const auditService = require('../services/auditService');
const keycloakService = require('../services/keycloakService');
const { generateTempPassword: sharedGenerateTempPassword } = keycloakService;

/**
 * POST / — Create a new user
 * 
 * Body: { email, full_name, role }
 * Returns: { ok, user, temporary_password }
 * 
 * Creates user in Keycloak (via Admin API) and CRM DB with membership.
 * Temp password returned once (§6).
 */
// Tenant context comes ONLY from requireCompanyAccess (PF007-HARDENING-001).
// No fallback to req.user.company_id — missing tenant context is an error.
function getTenantCompanyId(req, res) {
    const companyId = req.companyFilter?.company_id;
    if (!companyId) {
        res.status(403).json({
            code: 'TENANT_CONTEXT_REQUIRED',
            message: 'No company association found',
            trace_id: req.traceId,
        });
        return null;
    }
    return companyId;
}

function requireTenantAdmin(req, res, next) {
    if (req.user?._devMode) return next();
    if (req.authz?.membership?.role_key === 'tenant_admin') return next();
    return res.status(403).json({
        code: 'TENANT_ADMIN_ONLY',
        message: 'Tenant admin role required',
        trace_id: req.traceId,
    });
}

function isValidEmail(email) {
    return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email);
}

/**
 * ZB-DECOUPLE C3b — USERS-FIRST technician directory: after any membership
 * mutation (create / role change / status change / removal) the native
 * directory re-projects so «роль provider ⇔ активный техник» holds without any
 * manual linking. No-op in legacy mode; never fails the admin's request.
 */
async function projectTechnicians(companyId, context) {
    try {
        const directoryService = require('../services/technicianDirectoryService');
        const out = await directoryService.projectFromMemberships(companyId);
        if (out && !out.skipped && (out.created || out.reactivated || out.adopted || out.deactivated)) {
            console.log('[Users] Technician projection:', { company_id: companyId, context, ...out });
        }
    } catch (err) {
        console.error('[Users] Technician projection failed:', err.message);
    }
}

router.post('/', async (req, res) => {
    try {
        const { email, full_name, role = 'company_member', role_key, profile } = req.body;
        const companyId = getTenantCompanyId(req, res);
        if (!companyId) return;

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

        // Create in CRM DB with membership and profile
        const user = await userService.createUserWithMembership({
            keycloakSub,
            email,
            fullName: full_name,
            companyId,
            role,
            role_key,
            profile
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

        await projectTechnicians(companyId, 'user-created'); // C3b: provider role ⇒ technician

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
        // Always tenant-scoped: super_admin has no implicit all-companies view here
        // (platform scope is rejected earlier by requireCompanyAccess).
        const companyId = getTenantCompanyId(req, res);
        if (!companyId) return;
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
 * GET /:id — Get one user's membership + profile (tenant-scoped).
 * Foreign-company user ids return 404 (PF007-HARDENING-001).
 */
router.get('/:id', async (req, res) => {
    try {
        const companyId = getTenantCompanyId(req, res);
        if (!companyId) return;

        const user = await userService.getUserDetail(req.params.id, companyId);
        if (!user) {
            return res.status(404).json({
                code: 'NOT_FOUND',
                message: 'User not found',
                trace_id: req.traceId,
            });
        }
        res.json({ ok: true, user });
    } catch (err) {
        console.error('[Users] Get failed:', err.message);
        // Invalid uuid in :id must look like a missing user, not a server error
        if (err.code === '22P02') {
            return res.status(404).json({
                code: 'NOT_FOUND',
                message: 'User not found',
                trace_id: req.traceId,
            });
        }
        res.status(500).json({
            code: 'INTERNAL_ERROR',
            message: 'Failed to get user',
            trace_id: req.traceId,
        });
    }
});

/**
 * PATCH /:id — Update user identity, role, and membership profile.
 * The parent mount requires tenant.users.manage; this route additionally
 * requires the actual tenant_admin role.
 */
router.patch('/:id', requireTenantAdmin, async (req, res) => {
    try {
        const {
            role_key,
            profile,
            full_name,
            email,
            confirm_identity_change,
        } = req.body || {};
        const userId = req.params.id;
        const companyId = getTenantCompanyId(req, res);
        if (!companyId) return;

        if (role_key && !['tenant_admin', 'manager', 'dispatcher', 'provider'].includes(role_key)) {
            return res.status(422).json({
                code: 'VALIDATION_ERROR',
                message: 'Invalid role_key',
                trace_id: req.traceId,
            });
        }
        if (full_name !== undefined
            && (typeof full_name !== 'string' || !full_name.trim() || full_name.trim().length > 255)) {
            return res.status(422).json({
                code: 'VALIDATION_ERROR',
                message: 'full_name must be a non-empty string up to 255 characters',
                trace_id: req.traceId,
            });
        }
        if (email !== undefined
            && (typeof email !== 'string' || email.trim().length > 255 || !isValidEmail(email.trim()))) {
            return res.status(422).json({
                code: 'VALIDATION_ERROR',
                message: 'email must be a valid address up to 255 characters',
                trace_id: req.traceId,
            });
        }
        if (profile !== undefined && (profile === null || typeof profile !== 'object' || Array.isArray(profile))) {
            return res.status(422).json({
                code: 'VALIDATION_ERROR',
                message: 'profile must be an object',
                trace_id: req.traceId,
            });
        }
        if (profile && 'phone' in profile) {
            const phone = profile.phone;
            if (phone !== null && phone !== ''
                && (typeof phone !== 'string' || phone.trim().length > 50)) {
                return res.status(422).json({
                    code: 'VALIDATION_ERROR',
                    message: 'phone must be a string up to 50 characters or null',
                    trace_id: req.traceId,
                });
            }
        }
        if (profile && 'zenbooker_team_member_id' in profile) {
            const v = profile.zenbooker_team_member_id;
            const isValid = v === null || v === '' ||
                (['string', 'number'].includes(typeof v) && String(v).trim().length <= 64);
            if (!isValid) {
                return res.status(422).json({
                    code: 'VALIDATION_ERROR',
                    message: 'zenbooker_team_member_id must be a string up to 64 chars or null',
                    trace_id: req.traceId,
                });
            }
        }

        const target = await userService.getManagedUser(userId, companyId);
        if (!target) {
            return res.status(404).json({
                code: 'NOT_FOUND',
                message: 'User not found',
                trace_id: req.traceId,
            });
        }

        const normalizedFullName = full_name === undefined ? undefined : full_name.trim();
        const normalizedEmail = email === undefined ? undefined : email.trim().toLowerCase();
        const fullNameChanged = normalizedFullName !== undefined && normalizedFullName !== target.full_name;
        const emailChanged = normalizedEmail !== undefined
            && normalizedEmail !== String(target.email || '').toLowerCase();
        const identityChanged = fullNameChanged || emailChanged;

        if (identityChanged && Number(target.membership_count) > 1) {
            return res.status(409).json({
                code: 'SHARED_IDENTITY_REQUIRES_PLATFORM_ADMIN',
                message: 'This login identity belongs to more than one company and cannot be changed by a company admin',
                trace_id: req.traceId,
            });
        }

        let linkedIdentityProviders = [];
        let keycloakBefore = null;
        let keycloakWasUpdated = false;
        if (identityChanged) {
            if (!target.keycloak_sub) {
                return res.status(409).json({
                    code: 'KEYCLOAK_IDENTITY_MISSING',
                    message: 'This member is not linked to a login identity',
                    trace_id: req.traceId,
                });
            }
            if (emailChanged
                && await userService.companyEmailIsInUse(companyId, userId, normalizedEmail)) {
                return res.status(409).json({
                    code: 'EMAIL_IN_USE',
                    message: 'Another company member already uses this email',
                    trace_id: req.traceId,
                });
            }

            const identity = await keycloakService.inspectUserIdentity(target.keycloak_sub);
            if (!identity) {
                return res.status(409).json({
                    code: 'KEYCLOAK_IDENTITY_MISSING',
                    message: 'This member is not linked to a login identity',
                    trace_id: req.traceId,
                });
            }
            keycloakBefore = identity.user;
            linkedIdentityProviders = identity.federatedIdentities
                .map(link => link.identityProvider)
                .filter(Boolean);

            if (emailChanged
                && await keycloakService.realmLoginIsInUse(normalizedEmail, target.keycloak_sub)) {
                return res.status(409).json({
                    code: 'EMAIL_IN_USE',
                    message: 'This email is already used by another login identity',
                    trace_id: req.traceId,
                });
            }
            if (emailChanged && linkedIdentityProviders.length > 0 && confirm_identity_change !== true) {
                return res.status(409).json({
                    code: 'IDENTITY_CHANGE_CONFIRMATION_REQUIRED',
                    message: 'Changing this email may affect linked sign-in providers',
                    identity_change: {
                        linked_identity_providers: linkedIdentityProviders,
                        email_verification_will_reset: true,
                    },
                    trace_id: req.traceId,
                });
            }

            await keycloakService.updateUserIdentity(target.keycloak_sub, keycloakBefore, {
                ...(emailChanged ? { email: normalizedEmail } : {}),
                ...(fullNameChanged ? { full_name: normalizedFullName } : {}),
                reset_email_verification: emailChanged,
            });
            keycloakWasUpdated = true;
        }

        let changes;
        try {
            changes = await userService.updateMembershipAndProfile(userId, companyId, {
                role_key,
                profile,
                ...(fullNameChanged ? { full_name: normalizedFullName } : {}),
                ...(emailChanged ? { email: normalizedEmail } : {}),
                expected_email: target.email,
            });
        } catch (dbErr) {
            if (keycloakWasUpdated) {
                try {
                    await keycloakService.restoreUserIdentity(target.keycloak_sub, keycloakBefore);
                } catch (restoreErr) {
                    console.error('[Users] Keycloak identity compensation failed:', restoreErr.message);
                    const syncErr = new Error('Keycloak and CRM identity updates are inconsistent');
                    syncErr.code = 'IDENTITY_SYNC_INCONSISTENT';
                    throw syncErr;
                }
            }
            throw dbErr;
        }

        // Keep the internal job assignee mirror consistent with the new bridge
        if (changes.providerBridgeChanged) {
            try {
                const jobsService = require('../services/jobsService');
                await jobsService.refreshCompanyProviderMirror(companyId);
            } catch (mirrorErr) {
                console.error('[Users] Provider mirror refresh failed:', mirrorErr.message);
            }
            // ZB-DECOUPLE C3 (spec deferred #3): the native plane follows the
            // bridge edit — technicians.crm_user_id re-links (or clears) so the
            // native directory never drifts from the admin's ZB re-link.
            try {
                const directoryService = require('../services/technicianDirectoryService');
                const sync = await directoryService.syncBridgeLink(companyId, userId, changes.newTeamMemberId);
                if (!sync.linked && sync.reason === 'NO_NATIVE_TECHNICIAN') {
                    console.warn('[Users] Bridge re-link has no native technician yet (pre-backfill):', {
                        company_id: companyId, user_id: userId, external_id: changes.newTeamMemberId,
                    });
                }
            } catch (nativeErr) {
                console.error('[Users] Native directory bridge-sync failed:', nativeErr.message);
            }
        }

        // C3b: role changes re-project the directory (provider granted/revoked).
        await projectTechnicians(companyId, 'user-updated');

        await auditService.log({
            actor_id: req.user.crmUser.id,
            actor_email: req.user.email,
            actor_ip: req.ip,
            action: 'user_updated',
            target_type: 'user',
            target_id: userId,
            company_id: companyId,
            details: {
                role_key,
                profile_updated: !!profile,
                full_name_updated: fullNameChanged,
                email_updated: emailChanged,
                email_verification_reset: emailChanged,
                linked_identity_providers: linkedIdentityProviders,
                ...(changes.providerBridgeChanged ? {
                    zenbooker_team_member_id: {
                        from: changes.previousTeamMemberId,
                        to: changes.newTeamMemberId,
                    },
                } : {}),
            },
            trace_id: req.traceId,
        });

        res.json({
            ok: true,
            message: 'User updated successfully',
            user: {
                id: userId,
                email: changes.user?.email ?? target.email,
                full_name: changes.user?.full_name ?? target.full_name,
                phone: changes.user?.phone ?? target.phone ?? null,
            },
            identity_change: {
                email_changed: emailChanged,
                email_verification_reset: emailChanged,
                linked_identity_providers: linkedIdentityProviders,
            },
        });
    } catch (err) {
        console.error('[Users] Update failed:', err.message);
        if (err.message.includes('LAST_ADMIN_REQUIRED')) {
            return res.status(409).json({
                code: 'LAST_ADMIN_REQUIRED',
                message: 'Cannot remove the last company admin',
                trace_id: req.traceId,
            });
        }
        if (err.code === 'EMAIL_IN_USE') {
            return res.status(409).json({
                code: 'EMAIL_IN_USE',
                message: 'Another company member already uses this email',
                trace_id: req.traceId,
            });
        }
        if (err.code === 'KEYCLOAK_IDENTITY_CONFLICT') {
            return res.status(409).json({
                code: 'EMAIL_IN_USE',
                message: 'This email is already used by another login identity',
                trace_id: req.traceId,
            });
        }
        if (err.code === 'SHARED_IDENTITY_REQUIRES_PLATFORM_ADMIN'
            || err.code === 'USER_IDENTITY_CHANGED') {
            return res.status(409).json({
                code: err.code,
                message: err.message,
                trace_id: req.traceId,
            });
        }
        if (err.code === 'MEMBERSHIP_NOT_FOUND' || err.code === '22P02') {
            return res.status(404).json({
                code: 'NOT_FOUND',
                message: 'User not found',
                trace_id: req.traceId,
            });
        }
        if (err.code === 'KEYCLOAK_ADMIN_ERROR') {
            return res.status(502).json({
                code: 'IDENTITY_PROVIDER_ERROR',
                message: 'The login identity could not be updated',
                trace_id: req.traceId,
            });
        }
        if (err.code === 'IDENTITY_SYNC_INCONSISTENT') {
            return res.status(500).json({
                code: err.code,
                message: 'The login identity update needs administrator attention',
                trace_id: req.traceId,
            });
        }
        res.status(500).json({
            code: 'INTERNAL_ERROR',
            message: 'Failed to update user',
            trace_id: req.traceId,
        });
    }
});

/**
 * POST /:id/reset-password — ask Keycloak to email UPDATE_PASSWORD.
 * No password or reset token is generated, returned, or logged by Albusto.
 */
router.post('/:id/reset-password', requireTenantAdmin, async (req, res) => {
    try {
        const companyId = getTenantCompanyId(req, res);
        if (!companyId) return;
        const user = await userService.getManagedUser(req.params.id, companyId);
        if (!user) {
            return res.status(404).json({
                code: 'NOT_FOUND',
                message: 'User not found',
                trace_id: req.traceId,
            });
        }
        if (!user.keycloak_sub) {
            return res.status(409).json({
                code: 'KEYCLOAK_IDENTITY_MISSING',
                message: 'This member is not linked to a login identity',
                trace_id: req.traceId,
            });
        }

        await keycloakService.sendUpdatePasswordEmail(user.keycloak_sub);
        await auditService.log({
            actor_id: req.user.crmUser.id,
            actor_email: req.user.email,
            actor_ip: req.ip,
            action: 'user.password_reset',
            target_type: 'user',
            target_id: user.id,
            company_id: companyId,
            details: { mode: 'email' },
            trace_id: req.traceId,
        });

        res.json({ ok: true, sent: true });
    } catch (err) {
        if (err.code === '22P02') {
            return res.status(404).json({
                code: 'NOT_FOUND',
                message: 'User not found',
                trace_id: req.traceId,
            });
        }
        console.error('[Users] Password reset email failed:', err.message);
        res.status(502).json({
            code: 'IDENTITY_PROVIDER_ERROR',
            message: 'The password reset email could not be sent',
            trace_id: req.traceId,
        });
    }
});

/**
 * PATCH /:id/status — Enable or disable user
 */
router.patch('/:id/status', async (req, res) => {
    try {
        const userId = req.params.id;
        const companyId = getTenantCompanyId(req, res);
        if (!companyId) return;
        const { status, reason } = req.body;

        if (!['active', 'inactive'].includes(status)) {
            return res.status(422).json({
                code: 'VALIDATION_ERROR',
                message: 'status must be active or inactive',
                trace_id: req.traceId,
            });
        }

        if (status === 'inactive') {
            const adminCount = await userService.countCompanyAdmins(companyId);
            if (adminCount <= 1) {
                const targetUsers = await userService.listUsers(companyId, { role: 'tenant_admin', status: 'active' });
                const isTargetAdmin = targetUsers.users.some(u => u.id === userId);
                if (isTargetAdmin) {
                    return res.status(409).json({
                        code: 'LAST_ADMIN_REQUIRED',
                        message: 'Cannot disable the last company admin',
                        trace_id: req.traceId,
                    });
                }
            }
        }

        await userService.updateMembershipStatus(userId, companyId, status, reason);

        await auditService.log({
            actor_id: req.user.crmUser?.id,
            actor_email: req.user.email,
            actor_ip: req.ip,
            action: status === 'active' ? 'user_enabled' : 'user_disabled',
            target_type: 'user',
            target_id: userId,
            company_id: companyId,
            details: { reason },
            trace_id: req.traceId,
        });

        await projectTechnicians(companyId, `user-${status}`); // C3b: (de)activation follows

        res.json({ ok: true, message: `User ${status}` });
    } catch (err) {
        console.error('[Users] Status change failed:', err.message);
        if (err.message.includes('Membership not found') || err.code === '22P02') {
            return res.status(404).json({
                code: 'NOT_FOUND',
                message: 'User not found',
                trace_id: req.traceId,
            });
        }
        res.status(500).json({
            code: 'INTERNAL_ERROR',
            message: 'Failed to change user status',
            trace_id: req.traceId,
        });
    }
});

/**
 * DELETE /:id — Fully unlink a DISABLED user from the company (#86).
 * Admin-only + destructive. The user must already be inactive; the Keycloak
 * identity is preserved (they may belong to other companies) — only this
 * company's membership + profile are removed. Audit-logged.
 */
router.delete('/:id', requireTenantAdmin, async (req, res) => {
    try {
        const userId = req.params.id;
        const companyId = getTenantCompanyId(req, res);
        if (!companyId) return;

        if (userId === req.user.crmUser?.id) {
            return res.status(409).json({
                code: 'CANNOT_REMOVE_SELF',
                message: 'You cannot remove your own account',
                trace_id: req.traceId,
            });
        }

        // Defense-in-depth: never strand a company without an active admin.
        const targetAdmins = await userService.listUsers(companyId, { role: 'tenant_admin' });
        const target = targetAdmins.users.find(u => u.id === userId);
        if (target && target.membership_status === 'active') {
            const adminCount = await userService.countCompanyAdmins(companyId);
            if (adminCount <= 1) {
                return res.status(409).json({
                    code: 'LAST_ADMIN_REQUIRED',
                    message: 'Cannot remove the last company admin',
                    trace_id: req.traceId,
                });
            }
        }

        await userService.removeMembership(userId, companyId);

        await auditService.log({
            actor_id: req.user.crmUser?.id,
            actor_email: req.user.email,
            actor_ip: req.ip,
            action: 'user_removed_from_company',
            target_type: 'user',
            target_id: userId,
            company_id: companyId,
            details: {},
            trace_id: req.traceId,
        });

        await projectTechnicians(companyId, 'user-removed'); // C3b: removal deactivates the technician

        res.json({ ok: true, message: 'User removed from company' });
    } catch (err) {
        console.error('[Users] Remove failed:', err.message);
        if (err.code === 'MEMBERSHIP_NOT_FOUND' || err.code === '22P02') {
            return res.status(404).json({
                code: 'NOT_FOUND',
                message: 'User not found',
                trace_id: req.traceId,
            });
        }
        if (err.code === 'USER_STILL_ACTIVE') {
            return res.status(409).json({
                code: 'USER_STILL_ACTIVE',
                message: 'Disable the user before removing them',
                trace_id: req.traceId,
            });
        }
        res.status(500).json({
            code: 'INTERNAL_ERROR',
            message: 'Failed to remove user',
            trace_id: req.traceId,
        });
    }
});

// ── Helpers ──────────────────────────────────────────────────────────────────

// Delegate to shared keycloakService helper
function generateTempPassword() {
    return sharedGenerateTempPassword();
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
