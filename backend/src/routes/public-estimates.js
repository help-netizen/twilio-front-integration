/**
 * Public (un-authenticated) estimate routes. The URL's opaque token is the
 * credential — anyone holding it can fetch the view JSON or PDF. Used for the
 * estimate "send" flow where the customer receives a tokenized link via email
 * or SMS. Mirrors public-invoices.js.
 */
const express = require('express');
const router = express.Router();
const estimatesService = require('../services/estimatesService');

const TOKEN_RE = /^[A-Za-z0-9_-]{6,64}$/;

// GET /api/public/estimates/:token — safe, view-only estimate JSON.
router.get('/estimates/:token', async (req, res) => {
    try {
        const { token } = req.params;
        if (!TOKEN_RE.test(token)) return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: 'Invalid link' } });
        const view = await estimatesService.getPublicEstimate(token);
        if (!view) return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: 'Invalid link' } });
        res.json({ ok: true, data: view });
    } catch (err) {
        console.error('[Public/Estimates] GET /:token error:', err.message);
        const status = err.httpStatus || 500;
        res.status(status).json({ ok: false, error: { code: err.code || 'INTERNAL', message: err.message } });
    }
});

// GET /api/public/estimates/:token/pdf — Render the PDF resolved by its public token.
router.get('/estimates/:token/pdf', async (req, res) => {
    try {
        const { token } = req.params;
        if (!TOKEN_RE.test(token)) return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: 'Invalid link' } });
        const { estimate, buffer } = await estimatesService.generatePdfByPublicToken(token);
        const safeNumber = String(estimate.estimate_number || `estimate-${estimate.id}`).replace(/[^a-z0-9_-]+/gi, '_');

        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Length', buffer.length);
        // Cache-control: public token is opaque, but content can change as the estimate does.
        res.setHeader('Cache-Control', 'private, max-age=0, must-revalidate');
        res.setHeader('Content-Disposition', `inline; filename="${safeNumber}.pdf"`);
        res.send(buffer);
    } catch (err) {
        console.error('[Public/Estimates] GET /:token/pdf error:', err.message);
        const status = err.httpStatus || 500;
        res.status(status).json({ ok: false, error: { code: err.code || 'INTERNAL', message: err.message } });
    }
});

/**
 * Short alias router (mounted at root): GET /ep/:token → 302 to the full PDF URL.
 * Keeps customer-facing links short for SMS / pasted messages.
 */
const shortRouter = express.Router();
shortRouter.get('/ep/:token', (req, res) => {
    const { token } = req.params;
    if (!TOKEN_RE.test(token)) {
        return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: 'Invalid link' } });
    }
    res.redirect(302, `/api/public/estimates/${token}/pdf`);
});

router.shortRouter = shortRouter;
module.exports = router;
