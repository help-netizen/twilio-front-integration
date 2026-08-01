'use strict';

const express = require('express');
const { requestId, authenticateAppRuntime } = require('../middleware/appRuntimeAuth');
const requestValidator = require('../services/appRuntimeRequestValidator');
const gatewayService = require('../services/appRuntimeGatewayService');
const { AppRuntimeError, appRuntimeError } = require('../services/appRuntimeErrors');

const router = express.Router();

router.use((req, res, next) => {
    requestId(req);
    res.set('X-Request-Id', req.requestId);
    res.set('Cache-Control', 'no-store');
    next();
});
router.use(express.json({ limit: 32 * 1024, strict: true }));

function sendFailure(req, res, error) {
    const failure = error instanceof AppRuntimeError
        ? error
        : appRuntimeError('INTERNAL_ERROR', 'App runtime request failed.', 500);
    const retryAfter = failure.details?.retryAfterSeconds;
    if (retryAfter) res.set('Retry-After', String(retryAfter));
    return res.status(failure.httpStatus || 500).json({
        ok: false,
        code: failure.code,
        message: failure.message,
        request_id: req.requestId,
    });
}

function validateTransport(req, res, next) {
    try {
        if (Object.keys(req.query || {}).length > 0) {
            throw appRuntimeError('INVALID_REQUEST', 'Query parameters are not accepted.', 400);
        }
        requestValidator.requireArgumentsObject(req.body);
        next();
    } catch (error) {
        sendFailure(req, res, error);
    }
}

// tenant-safety-allow R-route-permission: short-lived run-token auth plus live delegated permission checks gate every allowlisted tool call
router.post('/v1/tools/:toolName', validateTransport, authenticateAppRuntime, async (req, res) => {
    try {
        const data = await gatewayService.execute(req, req.params.toolName, req.body);
        return res.json({
            ok: true,
            data,
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
