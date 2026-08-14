/**
 * Territory Check — checks the active service-territory mode
 * GET /api/zip-check?q=02101      (zip code)
 * GET /api/zip-check?q=Boston     (city / area name)
 * GET /api/zip-check?zip=02101    (legacy backward compat)
 */
const express = require('express');
const router = express.Router();
const territoryService = require('../services/territoryService');
const { requireRequestCompanyId, sendTenantContextRequired } = require('../utils/tenantContext');

router.get('/', async (req, res) => {
    try {
        const query = req.query.q || req.query.zip;
        if (!query) return res.status(400).json({ ok: false, error: 'q or zip parameter is required' });

        const result = await territoryService.isZipInTerritory(requireRequestCompanyId(req), query);
        res.json({
            ok: true,
            data: {
                success: true,
                exists: result.inside,
                area: result.area || '',
                city: result.city || '',
                state: result.state || '',
                zip: result.zip || '',
            },
        });
    } catch (err) {
        console.error('[ZipCheck] error:', err.message);
        if (sendTenantContextRequired(res, err)) return;
        res.status(500).json({ ok: false, error: err.message });
    }
});

module.exports = router;
