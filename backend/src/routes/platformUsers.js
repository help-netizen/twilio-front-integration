/**
 * Platform Users API — platform super admin only.
 * The parent mount enforces requirePlatformRole('super_admin').
 */

const express = require('express');
const router = express.Router();
const platformUserService = require('../services/platformUserService');
const keycloakService = require('../services/keycloakService');
const auditService = require('../services/auditService');

function positiveInteger(value, fallback) {
    const parsed = parseInt(value, 10);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

router.get('/', async (req, res) => {
    try {
        const page = positiveInteger(req.query.page, 1);
        const limit = Math.min(positiveInteger(req.query.limit, 25), 100);
        const search = typeof req.query.search === 'string' ? req.query.search.trim() : '';
        const result = await platformUserService.listUsers({
            search: search || undefined,
            page,
            limit,
        });
        res.json({ ok: true, ...result });
    } catch (err) {
        console.error('[PlatformUsers] List failed:', err.message);
        res.status(500).json({ code: 'INTERNAL_ERROR', message: 'Failed to list users', trace_id: req.traceId });
    }
});

router.post('/:userId/reset-password', async (req, res) => {
    try {
        const { mode } = req.body || {};
        if (!['temp', 'email'].includes(mode)) {
            return res.status(422).json({
                code: 'VALIDATION_ERROR',
                message: "mode must be 'temp' or 'email'",
            });
        }

        // Deliberately platform-scoped: this lookup must not use a company filter.
        const user = await platformUserService.getUserForPasswordReset(req.params.userId);
        if (!user) {
            return res.status(404).json({ code: 'USER_NOT_FOUND', message: 'User not found' });
        }

        let response;
        if (mode === 'temp') {
            const temporaryPassword = keycloakService.generateTempPassword();
            await keycloakService.resetUserPassword(user.keycloak_sub, temporaryPassword, true);
            response = { ok: true, mode: 'temp', temporary_password: temporaryPassword };
        } else {
            await keycloakService.sendUpdatePasswordEmail(user.keycloak_sub);
            response = { ok: true, mode: 'email', sent: true };
        }

        await auditService.log({
            actor_id: req.user.crmUser.id,
            actor_email: req.user.email,
            actor_ip: req.ip,
            action: 'user.password_reset',
            target_type: 'user',
            target_id: user.id,
            company_id: user.company_id,
            details: { mode },
            trace_id: req.traceId,
        });

        res.json(response);
    } catch (err) {
        if (err.code === '22P02') {
            return res.status(404).json({ code: 'USER_NOT_FOUND', message: 'User not found' });
        }
        console.error('[PlatformUsers] Password reset failed:', err.message);
        res.status(500).json({ code: 'INTERNAL_ERROR', message: 'Failed to reset password', trace_id: req.traceId });
    }
});

module.exports = router;
