'use strict';

/**
 * Per-user notification category settings.
 *
 * Mounted at /api/settings behind authenticate and requireCompanyAccess.
 * Tenant and user identity are request-derived only.
 */

const express = require('express');
const notificationPolicyService = require('../services/notificationPolicyService');

const router = express.Router();

function requestContext(req) {
    return {
        companyId: req.companyFilter?.company_id || null,
        userId: req.user?.crmUser?.id || null,
    };
}

function sendError(res, error) {
    const status = error.status || 500;
    if (status >= 500) console.error('[NotificationSettings] error:', error.message);
    return res.status(status).json({
        ok: false,
        code: error.code || 'NOTIFICATION_SETTINGS_ERROR',
        error: status >= 500 ? 'Unable to process notification settings request.' : error.message,
    });
}

router.get('/notifications', async (req, res) => {
    try {
        const { companyId, userId } = requestContext(req);
        const data = await notificationPolicyService.getNotificationSettings(companyId, userId);
        return res.json({ ok: true, data });
    } catch (error) {
        return sendError(res, error);
    }
});

router.patch('/notifications/:category', async (req, res) => {
    try {
        const { companyId, userId } = requestContext(req);
        const data = await notificationPolicyService.updateCurrentUserCategory(
            companyId,
            userId,
            req.params.category,
            req.body
        );
        return res.json({ ok: true, data });
    } catch (error) {
        return sendError(res, error);
    }
});

module.exports = router;
