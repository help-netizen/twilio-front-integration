/**
 * technicianBaseLocations.js — settings API for technician base (home) locations
 * used by the slot engine (SLOT-ENGINE-001 Phase 2).
 *
 * Mounted: app.use('/api/settings/technician-base-locations', authenticate,
 *   requireCompanyAccess, router)
 */
const express = require('express');
const router = express.Router();
const { requirePermission } = require('../middleware/authorization');
const svc = require('../services/technicianBaseLocationsService');

function companyId(req) { return req.companyFilter?.company_id; }

// GET / — roster of service-provider technicians merged with stored base locations.
router.get('/', requirePermission('tenant.company.manage'), async (req, res) => {
    try {
        res.json({ ok: true, data: await svc.list(companyId(req)) });
    } catch (err) {
        console.error('[TechBaseLocations] list error:', err.message);
        res.status(500).json({ ok: false, error: { code: 'INTERNAL', message: err.message } });
    }
});

// PUT /:techId — set a technician's base
// (body: { lat?, lng?, label?, address?, street?, apt?, city?, state?, zip? }).
router.put('/:techId', requirePermission('tenant.company.manage'), async (req, res) => {
    try {
        const body = req.body || {};
        const data = await svc.upsert(companyId(req), req.params.techId, {
            lat: body.lat,
            lng: body.lng,
            label: body.label,
            address: body.address,
            street: body.street,
            apt: body.apt,
            city: body.city,
            state: body.state,
            zip: body.zip,
        });
        res.json({ ok: true, data });
    } catch (err) {
        if (err.httpStatus) {
            return res.status(err.httpStatus).json({ ok: false, error: { code: err.code || 'INVALID', message: err.message } });
        }
        console.error('[TechBaseLocations] upsert error:', err.message);
        res.status(500).json({ ok: false, error: { code: 'INTERNAL', message: err.message } });
    }
});

// DELETE /:techId — clear a technician's base.
router.delete('/:techId', requirePermission('tenant.company.manage'), async (req, res) => {
    try {
        const removed = await svc.remove(companyId(req), req.params.techId);
        if (!removed) {
            return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: 'No base location for that technician.' } });
        }
        res.json({ ok: true });
    } catch (err) {
        console.error('[TechBaseLocations] delete error:', err.message);
        res.status(500).json({ ok: false, error: { code: 'INTERNAL', message: err.message } });
    }
});

module.exports = router;
