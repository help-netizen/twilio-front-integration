'use strict';

const express = require('express');
const { rateLimit, ipKeyGenerator } = require('express-rate-limit');
const rateMeService = require('../services/rateMeService');

const router = express.Router();

const RATE_TOKEN_RE = /^[A-Za-z0-9_-]{22,64}$/;
const LOOPBACK_ADDRESSES = new Set([
    '127.0.0.1',
    '::1',
    '::ffff:127.0.0.1',
]);
const UNIFORM_NOT_FOUND = {
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

function rateLimited(_req, res) {
    return res.status(429).json(RATE_LIMITED);
}

const getRateLimiter = rateLimit({
    windowMs: 60_000,
    max: 60,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: rateLimitKey,
    handler: rateLimited,
});

const postRateLimiter = rateLimit({
    windowMs: 60_000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: rateLimitKey,
    handler: rateLimited,
});

function logNotFound(req, reason) {
    console.warn('[RateMe] public 404', {
        reason,
        host_mode: req.rateHost?.mode || 'pass_through',
    });
}

function requireRateToken(req, res, next) {
    if (!RATE_TOKEN_RE.test(req.params.token)) {
        logNotFound(req, 'bad_format');
        return res.status(404).json(UNIFORM_NOT_FOUND);
    }
    next();
}

function internalError(res) {
    return res.status(500).json({
        ok: false,
        error: { code: 'INTERNAL', message: 'Something went wrong' },
    });
}

function isAskLoopback(req) {
    const headers = req.headers || {};
    if (Object.prototype.hasOwnProperty.call(headers, 'x-forwarded-for')) {
        return false;
    }
    return LOOPBACK_ADDRESSES.has(req.socket?.remoteAddress);
}

// GET /api/public/rate/:token
router.get('/rate/:token', getRateLimiter, requireRateToken, async (req, res) => {
    try {
        const context = await rateMeService.getPublicContext(
            req.params.token,
            req.rateHost?.companyId ?? null
        );
        if (!context) {
            logNotFound(req, 'not_found');
            return res.status(404).json(UNIFORM_NOT_FOUND);
        }
        return res.json({ ok: true, data: context });
    } catch (error) {
        console.error('[RateMe] public context error', {
            name: error?.name || 'Error',
            code: error?.code || 'UNKNOWN',
        });
        return internalError(res);
    }
});

// POST /api/public/rate/:token/rating
router.post('/rate/:token/rating', postRateLimiter, requireRateToken, async (req, res) => {
    const { stars, feedback } = req.body || {};
    if (!Number.isInteger(stars) || stars < 1 || stars > 5) {
        return res.status(400).json({
            ok: false,
            error: {
                code: 'INVALID_STARS',
                message: 'Stars must be an integer from 1 to 5.',
            },
        });
    }
    if (feedback !== undefined && typeof feedback !== 'string') {
        return res.status(400).json({
            ok: false,
            error: {
                code: 'INVALID_FEEDBACK',
                message: 'Feedback must be a string.',
            },
        });
    }

    try {
        const result = await rateMeService.submitRating(
            req.params.token,
            { stars, feedback },
            req.rateHost?.companyId ?? null
        );
        if (!result) {
            logNotFound(req, 'not_found');
            return res.status(404).json(UNIFORM_NOT_FOUND);
        }
        return res.json({ ok: true, data: result });
    } catch (error) {
        console.error('[RateMe] public rating error', {
            name: error?.name || 'Error',
            code: error?.code || 'UNKNOWN',
        });
        return internalError(res);
    }
});

// GET /api/public/rate-domain-ask?domain=<host>
router.get('/rate-domain-ask', async (req, res) => {
    if (!isAskLoopback(req)) return res.status(404).end();

    try {
        const allow = await rateMeService.authorizeAskDomain(req.query.domain);
        return res.status(allow ? 200 : 404).end();
    } catch (error) {
        console.error('[RateMe] ask error', {
            name: error?.name || 'Error',
            code: error?.code || 'UNKNOWN',
        });
        return res.status(404).end();
    }
});

router.RATE_TOKEN_RE = RATE_TOKEN_RE;
router.isAskLoopback = isAskLoopback;

module.exports = router;
