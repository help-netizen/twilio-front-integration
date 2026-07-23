'use strict';

const { rateLimit, ipKeyGenerator } = require('express-rate-limit');

const DEFAULT_LIMIT = 300;
const DEFAULT_WINDOW_MS = 60_000;

function positiveInteger(value, fallback) {
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

const RATE_LIMIT = positiveInteger(process.env.CHATGPT_MCP_RATE_LIMIT, DEFAULT_LIMIT);
const RATE_WINDOW_MS = positiveInteger(
    process.env.CHATGPT_MCP_RATE_WINDOW_MS,
    DEFAULT_WINDOW_MS
);

function firstForwardedIp(req) {
    const raw = req.headers?.['x-forwarded-for'];
    const value = Array.isArray(raw) ? raw[0] : raw;
    if (typeof value !== 'string') return null;
    return value.split(',')[0].trim() || null;
}

function ipKey(req) {
    return `ip:${ipKeyGenerator(firstForwardedIp(req) || req.ip)}`;
}

function retryAfterSeconds(req) {
    const resetAt = req.rateLimit?.resetTime instanceof Date
        ? req.rateLimit.resetTime.getTime()
        : Date.now() + RATE_WINDOW_MS;
    return Math.max(1, Math.ceil((resetAt - Date.now()) / 1000));
}

function rateLimited(req, res) {
    res.set('Retry-After', String(retryAfterSeconds(req)));
    return res.status(429).json({
        jsonrpc: '2.0',
        id: req.body?.id ?? null,
        error: {
            code: -32000,
            message: 'Too many connector requests.',
            data: {
                code: 'RATE_LIMITED',
                request_id: req.requestId || req.traceId || null,
            },
        },
    });
}

const commonOptions = {
    windowMs: RATE_WINDOW_MS,
    max: RATE_LIMIT,
    standardHeaders: true,
    legacyHeaders: false,
    handler: rateLimited,
};

// Authentication failures never have a trusted binding. Bound them by the
// request IP so invalid-token loops cannot bypass the connector guard.
const unauthenticatedLimiter = rateLimit({
    ...commonOptions,
    keyGenerator: ipKey,
});

// Once OAuth has resolved the active tenant binding, the binding is the stable
// authority and rate-limit key. One company cannot consume another's budget.
const authenticatedLimiter = rateLimit({
    ...commonOptions,
    keyGenerator: (req) => `binding:${req.chatgptMcpBinding?.id || ipKey(req)}`,
});

module.exports = {
    DEFAULT_LIMIT,
    DEFAULT_WINDOW_MS,
    RATE_LIMIT,
    RATE_WINDOW_MS,
    authenticatedLimiter,
    unauthenticatedLimiter,
};
