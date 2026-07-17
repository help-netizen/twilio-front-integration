/**
 * Notification Settings Routes
 *
 * /api/settings/notifications — company-level browser push notification config
 *
 * Stored in company_settings with setting_key = 'browser_push_config'
 * GET — any authenticated user (to see company policy)
 * PUT — admin only (to change company policy)
 */

const express = require('express');
const db = require('../db/connection');

const router = express.Router();

const SETTING_KEY = 'browser_push_config';

const DEFAULT_CONFIG = {
    browser_push_new_text_message_enabled: false,
    browser_push_new_lead_enabled: false,
    updated_by_user_id: null,
    updated_at: null,
};

// Resolve company_id
async function resolveCompanyId(req) {
    const cid = req.companyFilter?.company_id;
    if (cid) return cid;
    const { rows } = await db.query('SELECT id FROM companies ORDER BY id LIMIT 1');
    return rows[0]?.id || null;
}

// ─── GET /api/settings/notifications ────────────────────────────────────
router.get('/', async (req, res) => {
    try {
        const companyId = await resolveCompanyId(req);
        if (!companyId) return res.json({ ok: true, config: DEFAULT_CONFIG });

        const { rows } = await db.query(
            'SELECT setting_value FROM company_settings WHERE company_id = $1 AND setting_key = $2',
            [companyId, SETTING_KEY]
        );

        const saved = rows.length > 0 ? rows[0].setting_value : {};
        const config = { ...DEFAULT_CONFIG, ...saved };

        res.json({ ok: true, config });
    } catch (err) {
        console.error('[NotificationSettings] GET error:', err.message);
        res.status(500).json({ ok: false, error: err.message });
    }
});

// ─── PUT /api/settings/notifications ────────────────────────────────────
router.put('/', async (req, res) => {
    try {
        // Admin-only check
        const roles = req.user?.roles || [];
        const isAdmin = roles.includes('company_admin') || roles.includes('super_admin');
        if (!isAdmin) {
            return res.status(403).json({ ok: false, error: 'Admin access required' });
        }

        const { config } = req.body;
        if (!config || typeof config !== 'object') {
            return res.status(400).json({ ok: false, error: 'config must be an object' });
        }

        const companyId = await resolveCompanyId(req);
        if (!companyId) {
            return res.status(400).json({ ok: false, error: 'No company context' });
        }

        const userId = req.user?.crmUser?.id || null;
        const toSave = {
            browser_push_new_text_message_enabled: !!config.browser_push_new_text_message_enabled,
            browser_push_new_lead_enabled: !!config.browser_push_new_lead_enabled,
            updated_by_user_id: userId,
            updated_at: new Date().toISOString(),
        };

        await db.query(
            `INSERT INTO company_settings (company_id, setting_key, setting_value, updated_at)
             VALUES ($1, $2, $3, NOW())
             ON CONFLICT (company_id, setting_key)
             DO UPDATE SET setting_value = $3, updated_at = NOW()`,
            [companyId, SETTING_KEY, JSON.stringify(toSave)]
        );

        res.json({ ok: true, config: toSave });
    } catch (err) {
        console.error('[NotificationSettings] PUT error:', err.message);
        res.status(500).json({ ok: false, error: err.message });
    }
});

module.exports = router;
