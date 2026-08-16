/**
 * Public (un-authenticated) estimate routes. The URL's opaque token is the
 * credential — anyone holding it can fetch the view JSON or PDF. Used for the
 * estimate "send" flow where the customer receives a tokenized link via email
 * or SMS. Mirrors public-invoices.js.
 */
const express = require('express');
const { rateLimit, ipKeyGenerator } = require('express-rate-limit');
const router = express.Router();
const estimatesService = require('../services/estimatesService');
const { withTransaction } = require('../services/transactionService');

const TOKEN_RE = /^[A-Za-z0-9_-]{6,64}$/;
const NOT_FOUND = {
    ok: false,
    error: { code: 'NOT_FOUND', message: 'Invalid link' },
};
const RATE_LIMITED = {
    ok: false,
    error: { code: 'RATE_LIMITED', message: 'Too many requests' },
};

function firstForwardedIp(req) {
    const raw = req.headers['x-forwarded-for'];
    const value = Array.isArray(raw) ? raw[0] : raw;
    if (typeof value !== 'string') return null;
    return value.split(',')[0].trim() || null;
}

function rateLimitKey(req) {
    return ipKeyGenerator(firstForwardedIp(req) || req.ip);
}

const publicWriteRateLimiter = rateLimit({
    windowMs: 60_000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: rateLimitKey,
    handler: (_req, res) => res.status(429).json(RATE_LIMITED),
});

function requireValidToken(req, res, next) {
    if (!TOKEN_RE.test(req.params.token)) return res.status(404).json(NOT_FOUND);
    next();
}

function requestEvidence(req) {
    const ip = firstForwardedIp(req) || req.ip || req.socket?.remoteAddress || '';
    const rawUserAgent = req.headers['user-agent'];
    const userAgent = Array.isArray(rawUserAgent) ? rawUserAgent[0] : rawUserAgent;
    return {
        ip_address: String(ip).slice(0, 64),
        user_agent: typeof userAgent === 'string' ? userAgent.slice(0, 512) : '',
    };
}

function handleActionError(res, err, label) {
    console.error(`[Public/Estimates] ${label} error:`, err.message);
    if (err.httpStatus === 400 || err.httpStatus === 409) {
        return res.status(err.httpStatus).json({
            ok: false,
            error: { code: err.code, message: err.message },
        });
    }
    return res.status(500).json({
        ok: false,
        error: { code: 'INTERNAL', message: 'Something went wrong' },
    });
}

// GET /api/public/estimates/:token — safe, view-only estimate JSON.
router.get('/estimates/:token', async (req, res) => {
    try {
        const { token } = req.params;
        if (!TOKEN_RE.test(token)) return res.status(404).json(NOT_FOUND);
        const view = await estimatesService.getPublicEstimate(token, { recordView: true });
        if (!view) return res.status(404).json(NOT_FOUND);
        res.json({ ok: true, data: view });
    } catch (err) {
        console.error('[Public/Estimates] GET /:token error:', err.message);
        const status = err.httpStatus || 500;
        if (status === 404) return res.status(404).json(NOT_FOUND);
        res.status(status).json({ ok: false, error: { code: err.code || 'INTERNAL', message: err.message } });
    }
});

// POST /api/public/estimates/:token/approve — customer approval by opaque link.
router.post(
    '/estimates/:token/approve',
    requireValidToken,
    publicWriteRateLimiter,
    async (req, res) => {
        try {
            const result = await withTransaction(client => (
                estimatesService.approvePublicEstimate(
                    req.params.token,
                    requestEvidence(req),
                    client
                )
            ));
            if (!result) return res.status(404).json(NOT_FOUND);
            res.setHeader('Cache-Control', 'no-store');
            return res.json({ ok: true, data: result });
        } catch (err) {
            return handleActionError(res, err, 'POST /:token/approve');
        }
    }
);

// POST /api/public/estimates/:token/decline — optional structured reason + text.
router.post(
    '/estimates/:token/decline',
    requireValidToken,
    publicWriteRateLimiter,
    async (req, res) => {
        try {
            const result = await withTransaction(client => (
                estimatesService.declinePublicEstimate(
                    req.params.token,
                    req.body || {},
                    requestEvidence(req),
                    client
                )
            ));
            if (!result) return res.status(404).json(NOT_FOUND);
            res.setHeader('Cache-Control', 'no-store');
            return res.json({ ok: true, data: result });
        } catch (err) {
            return handleActionError(res, err, 'POST /:token/decline');
        }
    }
);

// GET /api/public/estimates/:token/pdf — Render the PDF resolved by its public token.
router.get('/estimates/:token/pdf', async (req, res) => {
    try {
        const { token } = req.params;
        if (!TOKEN_RE.test(token)) return res.status(404).json(NOT_FOUND);
        const { estimate, buffer } = await estimatesService.generatePdfByPublicToken(
            token,
            { recordView: true }
        );
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
        if (status === 404) return res.status(404).json(NOT_FOUND);
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
        return res.status(404).json(NOT_FOUND);
    }
    res.redirect(302, `/api/public/estimates/${token}/pdf`);
});

router.shortRouter = shortRouter;
module.exports = router;
