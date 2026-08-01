'use strict';

const express = require('express');
const { requirePermission } = require('../middleware/authorization');
const notificationPolicyService = require('../services/notificationPolicyService');

const router = express.Router();

function requestContext(req) {
    return {
        companyId: req.companyFilter?.company_id || null,
        userId: req.user?.crmUser?.id || null,
        roleKey: req.authz?.membership?.role_key || null,
        permissions: req.authz?.permissions || [],
    };
}

function sendError(res, error) {
    const status = error.status || 500;
    if (status >= 500) console.error('[NotificationPolicies] error:', error.message);
    return res.status(status).json({
        ok: false,
        code: error.code || 'NOTIFICATION_POLICY_ERROR',
        error: status >= 500 ? 'Unable to process notification policy request.' : error.message,
    });
}

router.get('/notification-policies', async (req, res) => {
    try {
        const { companyId, userId, roleKey, permissions } = requestContext(req);
        const data = await notificationPolicyService.getPolicySnapshot(companyId, {
            userId,
            roleKey,
            permissions,
            includeAllRoles: permissions.includes('tenant.company.manage'),
        });
        return res.json({ ok: true, data });
    } catch (error) {
        return sendError(res, error);
    }
});

router.patch(
    '/notification-policies/:eventType',
    requirePermission('tenant.company.manage'),
    async (req, res) => {
        try {
            const { companyId, userId } = requestContext(req);
            const data = await notificationPolicyService.updateCompanyPolicy(
                companyId,
                req.params.eventType,
                req.body,
                userId
            );
            return res.json({ ok: true, data });
        } catch (error) {
            return sendError(res, error);
        }
    }
);

router.patch('/notification-preferences/:eventType', async (req, res) => {
    try {
        const { companyId, userId, roleKey, permissions } = requestContext(req);
        const data = await notificationPolicyService.updateCurrentUserPreference(
            companyId,
            userId,
            roleKey,
            permissions,
            req.params.eventType,
            req.body
        );
        return res.json({ ok: true, data });
    } catch (error) {
        return sendError(res, error);
    }
});

module.exports = router;

