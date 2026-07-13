/**
 * Tenant Telephony Numbers API — ALB-107.
 * Mounted at /api/telephony/numbers with tenant.telephony.manage.
 */

const express = require('express');
const router = express.Router();
const db = require('../db/connection');
const svc = require('../services/telephonyTenantService');
const territoryGeoService = require('../services/territoryGeoService');

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

function nullableNumber(value) {
    if (value == null) return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
}

async function getCompanyLocale(id) {
    const { rows } = await db.query(
        `SELECT c.city, c.state, c.zip, z.lat, z.lon,
                z.city AS geocoded_city, z.state AS geocoded_state
         FROM companies c
         LEFT JOIN zip_geocache z ON z.zip = c.zip
         WHERE c.id = $1`,
        [id]
    );
    const company = rows[0] || null;

    if (company?.zip) {
        let geography = company;
        if (company.lat == null || company.lon == null) {
            try {
                geography = await territoryGeoService.geocodeZip(company.zip) || company;
            } catch (err) {
                console.warn('[TelephonyNumbers] Company ZIP geocoding failed:', err.message);
            }
        }
        return {
            city: company.city ?? geography.city ?? company.geocoded_city ?? null,
            state: company.state ?? geography.state ?? company.geocoded_state ?? null,
            zip: company.zip,
            lat: nullableNumber(geography.lat),
            lon: nullableNumber(geography.lon),
        };
    }

    const { rows: radii } = await db.query(
        `SELECT r.zip, r.lat, r.lon, z.city, z.state
         FROM territory_radii r
         LEFT JOIN zip_geocache z ON z.zip = r.zip
         WHERE r.company_id = $1
         ORDER BY r.position ASC
         LIMIT 1`,
        [id]
    );
    const radius = radii[0] || null;
    return {
        city: radius?.city ?? company?.city ?? null,
        state: radius?.state ?? company?.state ?? null,
        zip: radius?.zip ?? null,
        lat: nullableNumber(radius?.lat),
        lon: nullableNumber(radius?.lon),
    };
}

// GET /api/telephony/numbers/status — connection state
router.get('/status', async (req, res) => {
    try {
        const id = companyId(req);
        const state = await svc.getTelephonyState(id);
        const { rows } = await db.query(
            `SELECT settings->>'port_in_prompt' AS port_in_prompt
             FROM companies
             WHERE id = $1`,
            [id]
        );
        res.json({ ok: true, state, port_in_prompt: rows[0]?.port_in_prompt || null });
    } catch (err) { fail(res, err, 'Failed to load telephony status'); }
});

// POST /api/telephony/numbers/port-in-prompt/dismiss — persist the shared prompt dismissal
router.post('/port-in-prompt/dismiss', async (req, res) => {
    try {
        const { rows } = await db.query(
            `UPDATE companies
             SET settings = COALESCE(settings, '{}'::jsonb)
                 || jsonb_build_object('port_in_prompt', 'dismissed')
             WHERE id = $1
             RETURNING settings->>'port_in_prompt' AS port_in_prompt`,
            [companyId(req)]
        );
        res.json({ ok: true, port_in_prompt: rows[0]?.port_in_prompt || null });
    } catch (err) { fail(res, err, 'Failed to dismiss port-in prompt'); }
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

// GET /api/telephony/numbers/locale — company base locale for area-code suggestions
router.get('/locale', async (req, res) => {
    try {
        res.json(await getCompanyLocale(companyId(req)));
    } catch (err) { fail(res, err, 'Failed to load company locale'); }
});

// GET /api/telephony/numbers/search?area_code=&contains=&locality=&toll_free=
router.get('/search', async (req, res) => {
    try {
        const id = companyId(req);
        await svc.connectTelephony(id, {
            actorId: req.user?.crmUser?.id,
            companyName: req.authz?.company?.name,
        });
        const results = await svc.searchNumbers(id, {
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
        const id = companyId(req);
        await svc.connectTelephony(id, {
            actorId: req.user?.crmUser?.id,
            companyName: req.authz?.company?.name,
        });
        const { phone_number, friendly_name } = req.body || {};
        const out = await svc.buyNumber(id, {
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

// ── Phase 2: usage, softphone, A2P ───────────────────────────────────────────

const a2pService = require('../services/a2pService');

// GET /api/telephony/numbers/usage — this-month usage for the tenant
router.get('/usage', async (req, res) => {
    try {
        res.json({ ok: true, usage: await svc.getUsageSummary(companyId(req)) });
    } catch (err) {
        if (err.code === 'TELEPHONY_NOT_CONNECTED') return res.json({ ok: true, usage: null, not_connected: true });
        fail(res, err, 'Failed to load usage');
    }
});

// POST /api/telephony/numbers/softphone/setup — API key + TwiML app in the subaccount
router.post('/softphone/setup', async (req, res) => {
    try {
        const creds = await svc.ensureSoftphoneSetup(companyId(req));
        res.json({ ok: true, twiml_app_sid: creds.twimlAppSid, api_key_sid: creds.apiKeySid });
    } catch (err) { fail(res, err, 'Softphone setup failed'); }
});

// GET /api/telephony/numbers/a2p — registration state (with live refresh)
router.get('/a2p', async (req, res) => {
    try {
        let reg = await a2pService.getRegistration(companyId(req));
        if (reg && !['not_started', 'approved'].includes(reg.status)) {
            reg = await a2pService.refreshStatus(companyId(req));
        }
        res.json({ ok: true, registration: reg || { status: 'not_started' } });
    } catch (err) { fail(res, err, 'Failed to load A2P status'); }
});

// POST /api/telephony/numbers/a2p/register — submit business identity + brand
router.post('/a2p/register', async (req, res) => {
    try {
        const reg = await a2pService.startRegistration(companyId(req), req.body?.business || {}, {
            actorId: req.user?.crmUser?.id,
        });
        res.status(201).json({ ok: true, registration: reg });
    } catch (err) { fail(res, err, 'A2P registration failed'); }
});

// POST /api/telephony/numbers/a2p/campaign — create the messaging campaign
router.post('/a2p/campaign', async (req, res) => {
    try {
        const reg = await a2pService.createCampaign(companyId(req), req.body?.campaign || {}, {
            actorId: req.user?.crmUser?.id,
        });
        res.status(201).json({ ok: true, registration: reg });
    } catch (err) { fail(res, err, 'Campaign submission failed'); }
});

module.exports = router;
