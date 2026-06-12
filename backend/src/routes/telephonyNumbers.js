/**
 * Tenant Telephony Numbers API — ALB-107.
 * Mounted at /api/telephony/numbers with tenant.telephony.manage.
 */

const express = require('express');
const router = express.Router();
const svc = require('../services/telephonyTenantService');

function companyId(req) {
    return req.companyFilter?.company_id;
}

function fail(res, err, fallback) {
    if (err.httpStatus) {
        return res.status(err.httpStatus).json({ ok: false, code: err.code || 'ERROR', error: err.message });
    }
    console.error(`[TelephonyNumbers] ${fallback}:`, err.message);
    res.status(500).json({ ok: false, code: 'INTERNAL_ERROR', error: fallback });
}

// GET /api/telephony/numbers/status — connection state
router.get('/status', async (req, res) => {
    try {
        res.json({ ok: true, state: await svc.getTelephonyState(companyId(req)) });
    } catch (err) { fail(res, err, 'Failed to load telephony status'); }
});

// POST /api/telephony/numbers/connect — create the tenant subaccount
router.post('/connect', async (req, res) => {
    try {
        const state = await svc.connectTelephony(companyId(req), {
            actorId: req.user?.crmUser?.id,
            companyName: req.authz?.company?.name,
        });
        res.json({ ok: true, state });
    } catch (err) { fail(res, err, 'Failed to connect telephony'); }
});

// GET /api/telephony/numbers/search?area_code=&contains=&locality=&toll_free=
router.get('/search', async (req, res) => {
    try {
        const results = await svc.searchNumbers(companyId(req), {
            areaCode: req.query.area_code || undefined,
            contains: req.query.contains || undefined,
            locality: req.query.locality || undefined,
            tollFree: req.query.toll_free === 'true',
        });
        res.json({ ok: true, results });
    } catch (err) { fail(res, err, 'Number search failed'); }
});

// GET /api/telephony/numbers — list company numbers
router.get('/', async (req, res) => {
    try {
        const numbers = await svc.listNumbers(companyId(req));
        res.json({ ok: true, numbers });
    } catch (err) {
        if (err.code === 'TELEPHONY_NOT_CONNECTED') return res.json({ ok: true, numbers: [], not_connected: true });
        fail(res, err, 'Failed to list numbers');
    }
});

// POST /api/telephony/numbers/buy — purchase a number
router.post('/buy', async (req, res) => {
    try {
        const { phone_number, friendly_name } = req.body || {};
        const out = await svc.buyNumber(companyId(req), {
            phoneNumber: phone_number,
            friendlyName: friendly_name,
            actorId: req.user?.crmUser?.id,
        });
        res.status(201).json({ ok: true, number: out });
    } catch (err) {
        // Twilio 21422 = number no longer available
        if (err.code === 21422) return res.status(409).json({ ok: false, code: 'NUMBER_UNAVAILABLE', error: 'This number was just taken — pick another one' });
        fail(res, err, 'Failed to buy the number');
    }
});

// DELETE /api/telephony/numbers/:sid — release a number
router.delete('/:sid', async (req, res) => {
    try {
        const out = await svc.releaseNumber(companyId(req), req.params.sid, { actorId: req.user?.crmUser?.id });
        res.json({ ok: true, ...out });
    } catch (err) { fail(res, err, 'Failed to release the number'); }
});

module.exports = router;
