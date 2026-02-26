/**
 * Action Required Settings Routes
 *
 * /api/settings/action-required — per-company trigger configuration
 *
 * Stored in company_settings with setting_key = 'action_required_config'
 */

const express = require('express');
const db = require('../db/connection');

const router = express.Router();

const SETTING_KEY = 'action_required_config';

// Default configuration
const DEFAULT_CONFIG = {
    enabled: true,
    triggers: {
        inbound_sms: { enabled: true, create_task: true, task_priority: 'p1', task_sla_minutes: 10 },
        missed_call: { enabled: false, create_task: true, task_priority: 'p2', task_sla_minutes: 30 },
        voicemail: { enabled: false, create_task: true, task_priority: 'p2', task_sla_minutes: 60 },
    },
    snooze_presets: [
        { label: '30 min', minutes: 30 },
        { label: '2 hours', minutes: 120 },
        { label: 'Tomorrow 9 AM', minutes: null },
    ],
};

// Resolve company_id (super_admin fallback to first company)
async function resolveCompanyId(req) {
    const cid = req.companyFilter?.company_id;
    if (cid) return cid;
    const { rows } = await db.query('SELECT id FROM companies ORDER BY id LIMIT 1');
    return rows[0]?.id || null;
}

// ─── GET /api/settings/action-required ──────────────────────────────────
router.get('/', async (req, res) => {
    try {
        const companyId = await resolveCompanyId(req);
        if (!companyId) return res.json({ ok: true, config: DEFAULT_CONFIG });

        const { rows } = await db.query(
            'SELECT setting_value FROM company_settings WHERE company_id = $1 AND setting_key = $2',
            [companyId, SETTING_KEY]
        );

        const saved = rows.length > 0 ? rows[0].setting_value : {};
        // Merge with defaults so new keys always appear
        const config = {
            ...DEFAULT_CONFIG,
            ...saved,
            triggers: {
                ...DEFAULT_CONFIG.triggers,
                ...(saved.triggers || {}),
            },
        };

        res.json({ ok: true, config });
    } catch (err) {
        console.error('[ActionRequiredSettings] GET error:', err.message);
        res.status(500).json({ ok: false, error: err.message });
    }
});

// ─── PUT /api/settings/action-required ──────────────────────────────────
router.put('/', async (req, res) => {
    try {
        const { config } = req.body;
        if (!config || typeof config !== 'object') {
            return res.status(400).json({ ok: false, error: 'config must be an object' });
        }

        const companyId = await resolveCompanyId(req);
        if (!companyId) {
            return res.status(400).json({ ok: false, error: 'No company context' });
        }

        await db.query(
            `INSERT INTO company_settings (company_id, setting_key, setting_value, updated_at)
             VALUES ($1, $2, $3, NOW())
             ON CONFLICT (company_id, setting_key)
             DO UPDATE SET setting_value = $3, updated_at = NOW()`,
            [companyId, SETTING_KEY, JSON.stringify(config)]
        );

        res.json({ ok: true, config });
    } catch (err) {
        console.error('[ActionRequiredSettings] PUT error:', err.message);
        res.status(500).json({ ok: false, error: err.message });
    }
});

module.exports = router;
