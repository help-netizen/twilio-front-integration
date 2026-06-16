/**
 * technicians.js — settings API for technician display profiles (photo + name)
 * used on the public payment page.
 *
 * Mounted: app.use('/api/settings/technicians', authenticate,
 *   requirePermission('tenant.company.manage'), requireCompanyAccess, router)
 */
const express = require('express');
const multer = require('multer');
const router = express.Router();
const { requirePermission } = require('../middleware/authorization');
const svc = require('../services/technicianProfilesService');

const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
    fileFilter: (req, file, cb) => cb(null, /^image\//.test(file.mimetype)),
});

function companyId(req) { return req.companyFilter?.company_id; }

// GET /api/settings/technicians — list distinct technicians + photo status.
router.get('/', requirePermission('tenant.company.manage'), async (req, res) => {
    try {
        res.json({ ok: true, data: await svc.listTechnicians(companyId(req)) });
    } catch (err) {
        console.error('[Technicians] list error:', err.message);
        res.status(500).json({ ok: false, error: { code: 'INTERNAL', message: err.message } });
    }
});

// POST /api/settings/technicians/:techId/photo — upload/replace a photo (multipart).
router.post('/:techId/photo', requirePermission('tenant.company.manage'), upload.single('photo'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ ok: false, error: { code: 'NO_FILE', message: 'Image file required' } });
        const data = await svc.uploadPhoto(companyId(req), req.params.techId, { name: req.body?.name, file: req.file });
        res.json({ ok: true, data });
    } catch (err) {
        console.error('[Technicians] upload error:', err.message);
        res.status(500).json({ ok: false, error: { code: 'INTERNAL', message: err.message } });
    }
});

module.exports = router;
