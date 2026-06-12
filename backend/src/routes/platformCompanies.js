/**
 * Platform Companies API — ALB-102 (PF103 §2).
 * Platform super admin only; returns platform metadata, never tenant business data.
 */

const express = require('express');
const router = express.Router();
const platformCompanyService = require('../services/platformCompanyService');

// GET /api/platform/companies
router.get('/', async (req, res) => {
    try {
        const { status, q, page, limit } = req.query;
        const out = await platformCompanyService.listCompanies({
            status: status || undefined,
            q: q || undefined,
            page: page ? parseInt(page, 10) : 1,
            limit: limit ? Math.min(parseInt(limit, 10), 100) : 25,
        });
        res.json({ ok: true, ...out });
    } catch (err) {
        console.error('[Platform] list error:', err.message);
        res.status(500).json({ code: 'INTERNAL_ERROR', message: 'Failed to list companies' });
    }
});

// GET /api/platform/companies/:id
router.get('/:id', async (req, res) => {
    try {
        const detail = await platformCompanyService.getCompanyDetail(req.params.id);
        if (!detail) return res.status(404).json({ code: 'NOT_FOUND', message: 'Company not found' });
        res.json({ ok: true, ...detail });
    } catch (err) {
        if (err.code === '22P02') return res.status(404).json({ code: 'NOT_FOUND', message: 'Company not found' });
        console.error('[Platform] detail error:', err.message);
        res.status(500).json({ code: 'INTERNAL_ERROR', message: 'Failed to load company' });
    }
});

// PATCH /api/platform/companies/:id
router.patch('/:id', async (req, res) => {
    try {
        const updated = await platformCompanyService.updateCompany(
            req.params.id,
            req.body || {},
            { id: req.user?.crmUser?.id, email: req.user?.email }
        );
        if (!updated) return res.status(404).json({ code: 'NOT_FOUND', message: 'Company not found' });
        res.json({ ok: true, company: updated });
    } catch (err) {
        if (err.httpStatus) return res.status(err.httpStatus).json({ code: 'VALIDATION_ERROR', message: err.message });
        if (err.code === '22P02') return res.status(404).json({ code: 'NOT_FOUND', message: 'Company not found' });
        console.error('[Platform] update error:', err.message);
        res.status(500).json({ code: 'INTERNAL_ERROR', message: 'Failed to update company' });
    }
});

module.exports = router;
