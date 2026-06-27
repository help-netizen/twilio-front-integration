/**
 * companyProfile.js — COMPANY-PROFILE-001 — tenant-facing Company Profile API.
 *
 * Single source of company identity + branding; the brand source for invoice /
 * estimate PDFs. Identity/payment edits go through the whitelist in
 * companyProfileService; the logo upload mirrors the technician photo pattern.
 *
 * Mounted: app.use('/api/settings/company-profile', authenticate,
 *   requirePermission('tenant.company.manage'), requireCompanyAccess, router)
 */
const express = require('express');
const multer = require('multer');
const router = express.Router();
const { requirePermission } = require('../middleware/authorization');
const svc = require('../services/companyProfileService');

const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
    fileFilter: (req, file, cb) => cb(null, /^image\//.test(file.mimetype)),
});

function companyId(req) { return req.companyFilter?.company_id; }

function handleError(res, where, err) {
    if (err && err.httpStatus) {
        return res.status(err.httpStatus).json({ ok: false, error: { code: err.code, message: err.message } });
    }
    console.error(`[CompanyProfile] ${where} error:`, err.message);
    return res.status(500).json({ ok: false, error: { code: 'INTERNAL', message: err.message } });
}

// GET /api/settings/company-profile — current company identity + branding.
router.get('/', requirePermission('tenant.company.manage'), async (req, res) => {
    try {
        res.json({ ok: true, data: await svc.getProfile(companyId(req)) });
    } catch (err) {
        handleError(res, 'get', err);
    }
});

// PATCH /api/settings/company-profile — update whitelisted identity/payment fields.
router.patch('/', requirePermission('tenant.company.manage'), async (req, res) => {
    try {
        res.json({ ok: true, data: await svc.updateProfile(companyId(req), req.body || {}) });
    } catch (err) {
        handleError(res, 'update', err);
    }
});

// POST /api/settings/company-profile/logo — upload/replace the company logo (multipart).
router.post('/logo', requirePermission('tenant.company.manage'), upload.single('file'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ ok: false, error: { code: 'NO_FILE', message: 'Image file required' } });
        res.json({ ok: true, data: await svc.uploadLogo(companyId(req), req.file) });
    } catch (err) {
        handleError(res, 'upload', err);
    }
});

module.exports = router;
