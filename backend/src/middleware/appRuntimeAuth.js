'use strict';

const crypto = require('crypto');
const tokenService = require('../services/appRuntimeTokenService');
const rateLimit = require('../services/appRuntimeRateLimit');
const { AppRuntimeError, appRuntimeError } = require('../services/appRuntimeErrors');

function bearerToken(req) {
    const value = req.headers?.authorization || '';
    const match = /^Bearer\s+([^\s]+)$/i.exec(value);
    return match ? match[1] : null;
}

function requestId(req) {
    req.requestId = req.requestId || `app-gw-${crypto.randomUUID()}`;
    return req.requestId;
}

function sendError(req, res, error) {
    const failure = error instanceof AppRuntimeError
        ? error
        : appRuntimeError('APP_RUNTIME_TOKEN_INVALID', 'Invalid app runtime token.', 401);
    const rate = rateLimit.consumeUnauthenticated(req);
    if (!rate.allowed) {
        res.set('Retry-After', String(rate.retryAfterSeconds));
        return res.status(429).json({
            ok: false,
            code: 'RATE_LIMITED',
            message: 'Too many app runtime requests.',
            request_id: req.requestId,
        });
    }
    res.set('WWW-Authenticate', 'Bearer');
    return res.status(failure.httpStatus || 401).json({
        ok: false,
        code: failure.code,
        message: failure.message,
        request_id: req.requestId,
    });
}

async function authenticateAppRuntime(req, res, next) {
    requestId(req);
    const token = bearerToken(req);
    if (!token) {
        return sendError(
            req,
            res,
            appRuntimeError(
                'APP_RUNTIME_AUTH_REQUIRED',
                'Bearer token required.',
                401
            )
        );
    }
    try {
        const claims = tokenService.verifyRunToken(token);
        req.appRuntimeContext = await tokenService.resolveRunContext(claims);
        return next();
    } catch (error) {
        return sendError(req, res, error);
    }
}

function authenticateAppRuntimeClaims(req, res, next) {
    requestId(req);
    const token = bearerToken(req);
    if (!token) {
        return sendError(
            req,
            res,
            appRuntimeError(
                'APP_RUNTIME_AUTH_REQUIRED',
                'Bearer token required.',
                401
            )
        );
    }
    try {
        req.appRuntimeClaims = tokenService.verifyRunToken(token);
        return next();
    } catch (error) {
        return sendError(req, res, error);
    }
}

module.exports = {
    bearerToken,
    requestId,
    sendError,
    authenticateAppRuntime,
    authenticateAppRuntimeClaims,
};
