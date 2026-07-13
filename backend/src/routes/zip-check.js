/**
 * Territory Check — checks the active service-territory mode
 * GET /api/zip-check?q=02101      (zip code)
 * GET /api/zip-check?q=Boston     (city / area name)
 * GET /api/zip-check?zip=02101    (legacy backward compat)
 */
const express = require('express');
const router = express.Router();
const territoryService = require('../services/territoryService');

const DEFAULT_COMPANY_ID = '00000000-0000-0000-0000-000000000001';

function getCompanyId(req) {
    return req.companyFilter?.company_id
        || DEFAULT_COMPANY_ID;
}

router.get('/', async (req, res) => {
    try {
        const query = req.query.q || req.query.zip;
        if (!query) return res.status(400).json({ ok: false, error: 'q or zip parameter is required' });

        const result = await territoryService.isZipInTerritory(getCompanyId(req), query);
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
        res.status(500).json({ ok: false, error: err.message });
    }
});

module.exports = router;
