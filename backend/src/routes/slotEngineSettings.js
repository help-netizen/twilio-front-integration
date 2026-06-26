/**
 * slotEngineSettings.js — settings API for per-company recommendation settings
 * consumed by the slot engine (REC-SETTINGS-001). Sibling of
 * technicianBaseLocations.js (mirrors its companyId helper, per-route permission,
 * error→httpStatus mapping, and { ok, data } envelope).
 *
 * Mounted: app.use('/api/settings/slot-engine-settings', authenticate,
 *   requireCompanyAccess, router)
 */
const express = require('express');
const router = express.Router();
const { requirePermission } = require('../middleware/authorization');
const svc = require('../services/slotEngineSettingsService');

function companyId(req) { return req.companyFilter?.company_id; }

// GET / — stored recommendation settings (row-or-defaults; always the full 5 keys).
// Uses get() (not resolve): a normal no-row first-run still returns DEFAULTS, but a hard
// DB error surfaces as 500 so the UI shows an honest "couldn't load" toast (and its local
// DEFAULTS mirror) instead of silently presenting defaults as if they were the saved values.
router.get('/', requirePermission('tenant.company.manage'), async (req, res) => {
    try {
        const data = await svc.get(companyId(req));
        res.json({ ok: true, data });
    } catch (err) {
        console.error('[SlotEngineSettings] get error:', err.message);
        res.status(500).json({ ok: false, error: { code: 'INTERNAL', message: err.message } });
    }
});

// PUT / — replace all 5 settings (validate → upsert → saved). Body: the 5 keys only.
router.put('/', requirePermission('tenant.company.manage'), async (req, res) => {
    try {
        const data = await svc.save(companyId(req), req.body || {});
        res.json({ ok: true, data });
    } catch (err) {
        if (err.httpStatus) {
            return res.status(err.httpStatus).json({ ok: false, error: { code: err.code || 'INVALID', message: err.message } });
        }
        console.error('[SlotEngineSettings] save error:', err.message);
        res.status(500).json({ ok: false, error: { code: 'INTERNAL', message: err.message } });
    }
});

module.exports = router;
