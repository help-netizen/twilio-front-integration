/**
 * Notification Settings Routes
 *
 * /api/settings/notifications — company-level browser push notification config
 *
 * Compatibility adapter over the notification company-policy table.
 * GET — any authenticated user (to see company policy)
 * PUT — admin only (to change company policy)
 */

const express = require('express');
const { requirePermission } = require('../middleware/authorization');
const notificationPolicyService = require('../services/notificationPolicyService');

const router = express.Router();

const DEFAULT_CONFIG = {
    browser_push_new_text_message_enabled: false,
    browser_push_new_lead_enabled: false,
    updated_by_user_id: null,
    updated_at: null,
};

function companyIdFromRequest(req, res) {
    const companyId = req.companyFilter?.company_id;
    if (companyId) return companyId;
    res.status(403).json({
        ok: false,
        code: 'TENANT_CONTEXT_REQUIRED',
        error: 'Company context is required.',
    });
    return null;
}

// ─── GET /api/settings/notifications ────────────────────────────────────
router.get('/', async (req, res) => {
    try {
        const companyId = companyIdFromRequest(req, res);
        if (!companyId) return;
        const saved = await notificationPolicyService.getLegacyNotificationConfig(companyId);
        const config = { ...DEFAULT_CONFIG, ...saved };

        res.json({ ok: true, config });
    } catch (err) {
        console.error('[NotificationSettings] GET error:', err.message);
        res.status(500).json({ ok: false, error: err.message });
    }
});

// ─── PUT /api/settings/notifications ────────────────────────────────────
// Changing company-wide policy requires tenant.company.manage (RBAC-AUDIT-001 R3).
router.put('/', requirePermission('tenant.company.manage'), async (req, res) => {
    try {
        const { config } = req.body;
        if (!config || typeof config !== 'object') {
            return res.status(400).json({ ok: false, error: 'config must be an object' });
        }

        const companyId = companyIdFromRequest(req, res);
        if (!companyId) return;
        const userId = req.user?.crmUser?.id;
        if (!userId) {
            return res.status(409).json({ ok: false, code: 'NO_CRM_USER', error: 'CRM user context is required.' });
        }
        const toSave = await notificationPolicyService.updateLegacyNotificationConfig(
            companyId,
            config,
            userId
        );

        res.json({ ok: true, config: toSave });
    } catch (err) {
        console.error('[NotificationSettings] PUT error:', err.message);
        res.status(500).json({ ok: false, error: err.message });
    }
});

module.exports = router;
