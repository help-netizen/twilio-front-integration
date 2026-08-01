'use strict';

const crypto = require('crypto');
const express = require('express');
const { authenticate } = require('../middleware/keycloakAuth');
const { requirePlatformRole } = require('../middleware/authorization');
const tokenService = require('../services/appRuntimeTokenService');
const requestValidator = require('../services/appRuntimeRequestValidator');
const { AppRuntimeError, appRuntimeError } = require('../services/appRuntimeErrors');

const router = express.Router();
const BODY_KEYS = new Set(['installation_id', 'version_id', 'ttl_seconds']);

router.use((req, res, next) => {
    req.requestId = req.requestId || `app-gw-dev-${crypto.randomUUID()}`;
    req.traceId = req.traceId || req.requestId;
    res.set('X-Request-Id', req.requestId);
    res.set('Cache-Control', 'no-store');
    if (process.env.APP_RUNTIME_DEV_TOKEN_ROUTE_ENABLED !== 'true') {
        return res.status(404).json({
            ok: false,
            code: 'NOT_FOUND',
            message: 'Not found.',
            request_id: req.requestId,
        });
    }
    next();
});
router.use(express.json({ limit: 8 * 1024, strict: true }));
router.use(authenticate);
router.use((req, res, next) => {
    if (req.user?._devMode) {
        return res.status(403).json({
            ok: false,
            code: 'ACCESS_DENIED',
            message: 'Platform role required.',
            request_id: req.requestId,
        });
    }
    next();
});
router.use(requirePlatformRole('super_admin'));

function validateBody(body) {
    requestValidator.requireArgumentsObject(body);
    if (Object.keys(body).some((key) => !BODY_KEYS.has(key))) {
        throw appRuntimeError('INVALID_REQUEST', 'Request body is invalid.', 400);
    }
    if (!/^[1-9]\d*$/.test(String(body.installation_id || ''))
        || typeof body.version_id !== 'string') {
        throw appRuntimeError('INVALID_REQUEST', 'Request body is invalid.', 400);
    }
}

function sendFailure(req, res, error) {
    const failure = error instanceof AppRuntimeError
        ? error
        : appRuntimeError('INTERNAL_ERROR', 'App runtime token could not be created.', 500);
    return res.status(failure.httpStatus || 500).json({
        ok: false,
        code: failure.code,
        message: failure.message,
        request_id: req.requestId,
    });
}

router.post('/dev-tokens', async (req, res) => {
    try {
        if (Object.keys(req.query || {}).length > 0) {
            throw appRuntimeError('INVALID_REQUEST', 'Query parameters are not accepted.', 400);
        }
        validateBody(req.body);
        const minted = await tokenService.mintRunToken({
            installationId: req.body.installation_id,
            versionId: req.body.version_id,
            ttlSeconds: req.body.ttl_seconds,
        });
        return res.json({
            ok: true,
            token: minted.token,
            run_id: minted.runId,
            expires_at: minted.expiresAt,
            request_id: req.requestId,
        });
    } catch (error) {
        return sendFailure(req, res, error);
    }
});

router.use((error, req, res, _next) => {
    if (error?.type === 'entity.too.large' || error instanceof SyntaxError) {
        return sendFailure(
            req,
            res,
            appRuntimeError('INVALID_REQUEST', 'Request body is invalid.', 400)
        );
    }
    return sendFailure(req, res, error);
});

module.exports = router;
