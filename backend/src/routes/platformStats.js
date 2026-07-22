/** Platform Statistics API — parent mount is restricted to super admins. */

const express = require('express');
const router = express.Router();
const platformStatsService = require('../services/platformStatsService');

router.get('/', async (req, res) => {
    try {
        const result = await platformStatsService.getStats();
        res.json({ ok: true, ...result });
    } catch (err) {
        console.error('[PlatformStats] Load failed:', err.message);
        res.status(500).json({ code: 'INTERNAL_ERROR', message: 'Failed to load statistics', trace_id: req.traceId });
    }
});

module.exports = router;
