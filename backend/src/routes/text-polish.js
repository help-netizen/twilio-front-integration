/**
 * Text Polish API routes
 * POST /api/text/polish — polish a message via Gemini
 * GET  /api/text/polish/health — healthcheck
 */
const express = require('express');
const router = express.Router();
const { polishText } = require('../services/textPolishService');

// POST / — Polish text
router.post('/', async (req, res) => {
    try {
        const { text, language, tone, channel } = req.body;

        if (!text || typeof text !== 'string' || text.trim().length === 0) {
            return res.status(400).json({ error: 'text is required', code: 'VALIDATION_ERROR' });
        }
        if (text.length > 4000) {
            return res.status(413).json({ error: 'text exceeds 4000 character limit', code: 'PAYLOAD_TOO_LARGE' });
        }

        const result = await polishText(text, { language, tone, channel });
        res.json(result);
    } catch (err) {
        console.error('[TextPolish] POST / error:', err);
        const status = err.status || 500;
        res.status(status).json({
            error: err.message || 'Polish failed',
            code: err.code || 'INTERNAL_ERROR',
        });
    }
});

// GET /health — Healthcheck
router.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        service: 'text-polish',
        version: '1.0.0',
    });
});

module.exports = router;
