/**
 * /api/estimate-item-presets — per-company item catalog used by the
 * EstimateDetailPanel autocomplete.
 *
 * Mount in `src/server.js`:
 *   app.use('/api/estimate-item-presets',
 *       authenticate, requireCompanyAccess, estimateItemPresetsRouter);
 */

'use strict';

const express = require('express');
const service = require('../services/estimateItemPresetsService');
const { EstimateItemPresetError } = service;

const router = express.Router();

function getCompanyId(req) {
    return req.companyFilter?.company_id || req.user?.company_id || null;
}

function sendServiceError(res, err) {
    if (err instanceof EstimateItemPresetError) {
        return res.status(err.httpStatus).json({
            error: err.code, message: err.message, details: err.details || undefined,
        });
    }
    // eslint-disable-next-line no-console
    console.error('[estimate-item-presets] unexpected error', err);
    return res.status(500).json({ error: 'internal_error', message: 'Unexpected error' });
}

router.get('/', async (req, res) => {
    const companyId = getCompanyId(req);
    if (!companyId) return res.status(403).json({ error: 'forbidden' });
    try {
        const search = typeof req.query.search === 'string' ? req.query.search : '';
        const limit = req.query.limit ? Number(req.query.limit) : 10;
        const items = await service.search(companyId, { search, limit });
        res.json({ items });
    } catch (err) {
        sendServiceError(res, err);
    }
});

router.post('/', async (req, res) => {
    const companyId = getCompanyId(req);
    if (!companyId) return res.status(403).json({ error: 'forbidden' });
    try {
        const created = await service.create(companyId, req.body || {}, { createdBy: req.user?.id || null });
        res.status(201).json(created);
    } catch (err) {
        sendServiceError(res, err);
    }
});

router.patch('/:id', async (req, res) => {
    const companyId = getCompanyId(req);
    if (!companyId) return res.status(403).json({ error: 'forbidden' });
    try {
        const updated = await service.update(companyId, Number(req.params.id), req.body || {});
        res.json(updated);
    } catch (err) {
        sendServiceError(res, err);
    }
});

router.delete('/:id', async (req, res) => {
    const companyId = getCompanyId(req);
    if (!companyId) return res.status(403).json({ error: 'forbidden' });
    try {
        const archived = await service.archive(companyId, Number(req.params.id));
        res.json(archived);
    } catch (err) {
        sendServiceError(res, err);
    }
});

router.post('/:id/used', async (req, res) => {
    const companyId = getCompanyId(req);
    if (!companyId) return res.status(403).json({ error: 'forbidden' });
    try {
        const updated = await service.recordUsage(companyId, Number(req.params.id));
        res.json(updated);
    } catch (err) {
        sendServiceError(res, err);
    }
});

module.exports = router;
