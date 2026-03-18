/**
 * Fast Zip Code Check — proxies rely-lead-processor API
 * GET /api/zip-check?zip=02101
 */
const express = require('express');
const router = express.Router();

const RELY_API_URL = 'https://rely-lead-processor.fly.dev/api/zip-codes/check';
const RELY_API_KEY = process.env.RELY_INTERNAL_API_KEY;

router.get('/', async (req, res) => {
    try {
        const { zip } = req.query;
        if (!zip) return res.status(400).json({ ok: false, error: 'zip is required' });

        if (!RELY_API_KEY) {
            console.warn('[ZipCheck] RELY_INTERNAL_API_KEY not configured, skipping fast check');
            return res.status(503).json({ ok: false, error: 'Zip check service not configured' });
        }

        const response = await fetch(`${RELY_API_URL}?zip=${encodeURIComponent(zip)}`, {
            headers: { 'X-Internal-API-Key': RELY_API_KEY },
            signal: AbortSignal.timeout(5000),
        });

        if (!response.ok) {
            const text = await response.text().catch(() => '');
            console.error(`[ZipCheck] Upstream error ${response.status}:`, text);
            return res.status(response.status).json({ ok: false, error: `Upstream error (${response.status})` });
        }

        const data = await response.json();
        res.json({ ok: true, data });
    } catch (err) {
        console.error('[ZipCheck] error:', err.message);
        res.status(500).json({ ok: false, error: err.message });
    }
});

module.exports = router;
