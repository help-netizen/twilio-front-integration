/**
 * Session Management API (§9)
 *
 * super_admin-only endpoints for managing Keycloak sessions and auth policy.
 * Proxies Keycloak Admin REST API.
 *
 *   GET    /api/admin/sessions                — List active sessions
 *   DELETE /api/admin/sessions/:sessionId     — Revoke a session
 *   DELETE /api/admin/sessions/user/:userId   — Revoke all sessions for a user
 *   GET    /api/admin/auth-policy             — Read current auth policy
 *   PUT    /api/admin/auth-policy             — Update auth policy
 */

const express = require('express');
const router = express.Router();
const auditService = require('../services/auditService');

// ─── Keycloak Admin config ─────────────────────────────────────────────────
const KC_BASE = process.env.KEYCLOAK_URL || 'http://localhost:8080';
const KC_REALM = process.env.KEYCLOAK_REALM || 'crm-prod';
const KC_ADMIN_USER = process.env.KEYCLOAK_ADMIN_USER || 'admin';
const KC_ADMIN_PASS = process.env.KEYCLOAK_ADMIN_PASSWORD || 'admin';

/** Get a short-lived admin access token from Keycloak */
async function getAdminToken() {
    const res = await fetch(
        `${KC_BASE}/realms/master/protocol/openid-connect/token`,
        {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                grant_type: 'password',
                client_id: 'admin-cli',
                username: KC_ADMIN_USER,
                password: KC_ADMIN_PASS,
            }),
        }
    );
    if (!res.ok) throw new Error(`KC admin auth failed: ${res.status}`);
    const data = await res.json();
    return data.access_token;
}

/** Keycloak Admin API call helper */
async function kcAdmin(path, options = {}) {
    const token = await getAdminToken();
    const url = `${KC_BASE}/admin/realms/${KC_REALM}${path}`;
    const res = await fetch(url, {
        ...options,
        headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
            ...options.headers,
        },
    });
    if (options.method === 'DELETE' && res.status === 204) return null;
    if (!res.ok) {
        const body = await res.text();
        const err = new Error(`KC Admin API error: ${res.status} ${body}`);
        err.status = res.status;
        throw err;
    }
    const text = await res.text();
    return text ? JSON.parse(text) : null;
}

// =============================================================================
// GET /api/admin/sessions — List active sessions
// =============================================================================
router.get('/', async (req, res) => {
    try {
        // Get all users, then their sessions
        const users = await kcAdmin('/users?max=500');
        const sessions = [];

        for (const user of users) {
            const userSessions = await kcAdmin(`/users/${user.id}/sessions`);
            for (const s of userSessions) {
                sessions.push({
                    id: s.id,
                    userId: s.userId,
                    username: user.username,
                    email: user.email,
                    ipAddress: s.ipAddress,
                    start: s.start,
                    lastAccess: s.lastAccess,
                    clients: s.clients || {},
                });
            }
        }

        res.json({ success: true, sessions, count: sessions.length });
    } catch (err) {
        console.error('[Sessions] List error:', err.message);
        res.status(500).json({
            code: 'INTERNAL_ERROR',
            message: 'Failed to list sessions',
            trace_id: req.traceId,
        });
    }
});

// =============================================================================
// DELETE /api/admin/sessions/:sessionId — Revoke a single session
// =============================================================================
router.delete('/:sessionId', async (req, res) => {
    try {
        await kcAdmin(`/sessions/${req.params.sessionId}`, { method: 'DELETE' });

        await auditService.log({
            actor_id: req.user?.crmUser?.id,
            actor_email: req.user?.email,
            actor_ip: req.ip,
            action: 'session_revoked',
            target_type: 'session',
            target_id: req.params.sessionId,
            company_id: req.user?.company_id,
            trace_id: req.traceId,
        }).catch(() => { });

        res.json({ success: true, message: 'Session revoked' });
    } catch (err) {
        console.error('[Sessions] Revoke error:', err.message);
        const status = err.status === 404 ? 404 : 500;
        res.status(status).json({
            code: status === 404 ? 'NOT_FOUND' : 'INTERNAL_ERROR',
            message: status === 404 ? 'Session not found' : 'Failed to revoke session',
            trace_id: req.traceId,
        });
    }
});

// =============================================================================
// DELETE /api/admin/sessions/user/:userId — Revoke all sessions for a user
// =============================================================================
router.delete('/user/:userId', async (req, res) => {
    try {
        await kcAdmin(`/users/${req.params.userId}/logout`, { method: 'POST' });

        await auditService.log({
            actor_id: req.user?.crmUser?.id,
            actor_email: req.user?.email,
            actor_ip: req.ip,
            action: 'session_revoked',
            target_type: 'user_sessions',
            target_id: req.params.userId,
            company_id: req.user?.company_id,
            details: { scope: 'all_sessions' },
            trace_id: req.traceId,
        }).catch(() => { });

        res.json({ success: true, message: 'All sessions revoked for user' });
    } catch (err) {
        console.error('[Sessions] Revoke user sessions error:', err.message);
        res.status(500).json({
            code: 'INTERNAL_ERROR',
            message: 'Failed to revoke user sessions',
            trace_id: req.traceId,
        });
    }
});

// =============================================================================
// GET /api/admin/auth-policy — Read current auth policy from Keycloak realm
// =============================================================================
router.get('/auth-policy', async (req, res) => {
    try {
        const realm = await kcAdmin('');

        res.json({
            success: true,
            policy: {
                password: {
                    minLength: realm.passwordPolicy?.match(/length\((\d+)\)/)?.[1] || 8,
                    raw: realm.passwordPolicy || '',
                },
                session: {
                    accessTokenLifespan: realm.accessTokenLifespan,
                    ssoSessionIdleTimeout: realm.ssoSessionIdleTimeout,
                    ssoSessionMaxLifespan: realm.ssoSessionMaxLifespan,
                    offlineSessionIdleTimeout: realm.offlineSessionIdleTimeout,
                },
                mfa: {
                    otpPolicyType: realm.otpPolicyType,
                    otpPolicyDigits: realm.otpPolicyDigits,
                    otpPolicyPeriod: realm.otpPolicyPeriod,
                },
                bruteForce: {
                    enabled: realm.bruteForceProtected,
                    maxFailureWaitSeconds: realm.maxFailureWaitSeconds,
                    failureFactor: realm.failureFactor,
                },
            },
        });
    } catch (err) {
        console.error('[Sessions] Get auth-policy error:', err.message);
        res.status(500).json({
            code: 'INTERNAL_ERROR',
            message: 'Failed to read auth policy',
            trace_id: req.traceId,
        });
    }
});

// =============================================================================
// PUT /api/admin/auth-policy — Update auth policy
// =============================================================================
router.put('/auth-policy', async (req, res) => {
    try {
        const { accessTokenLifespan, ssoSessionIdleTimeout, ssoSessionMaxLifespan, passwordPolicy } = req.body;

        const update = {};
        if (accessTokenLifespan !== undefined) update.accessTokenLifespan = accessTokenLifespan;
        if (ssoSessionIdleTimeout !== undefined) update.ssoSessionIdleTimeout = ssoSessionIdleTimeout;
        if (ssoSessionMaxLifespan !== undefined) update.ssoSessionMaxLifespan = ssoSessionMaxLifespan;
        if (passwordPolicy !== undefined) update.passwordPolicy = passwordPolicy;

        if (Object.keys(update).length === 0) {
            return res.status(400).json({
                code: 'VALIDATION_ERROR',
                message: 'At least one policy field must be provided',
                trace_id: req.traceId,
            });
        }

        await kcAdmin('', { method: 'PUT', body: JSON.stringify(update) });

        await auditService.log({
            actor_id: req.user?.crmUser?.id,
            actor_email: req.user?.email,
            actor_ip: req.ip,
            action: 'auth_policy_changed',
            target_type: 'realm',
            target_id: KC_REALM,
            company_id: req.user?.company_id,
            details: update,
            trace_id: req.traceId,
        }).catch(() => { });

        res.json({ success: true, message: 'Auth policy updated', applied: update });
    } catch (err) {
        console.error('[Sessions] Update auth-policy error:', err.message);
        res.status(500).json({
            code: 'INTERNAL_ERROR',
            message: 'Failed to update auth policy',
            trace_id: req.traceId,
        });
    }
});

module.exports = router;
