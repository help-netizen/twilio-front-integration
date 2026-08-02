'use strict';

const express = require('express');
const {
    requestId,
    authenticateAppRuntime,
    authenticateAppRuntimeClaims,
} = require('../middleware/appRuntimeAuth');
const tokenService = require('../services/appRuntimeTokenService');
const requestValidator = require('../services/appRuntimeRequestValidator');
const gatewayService = require('../services/appRuntimeGatewayService');
const { AppRuntimeError, appRuntimeError } = require('../services/appRuntimeErrors');

const router = express.Router();
const runtimeJson = express.json({ limit: 32 * 1024, strict: true });
const dataJson = express.json({ limit: 1024 * 1024, strict: true });

router.use((req, res, next) => {
    requestId(req);
    res.set('X-Request-Id', req.requestId);
    res.set('Cache-Control', 'no-store');
    next();
});

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

function validateCompletionTransport(req, res, next) {
    try {
        if (Object.keys(req.query || {}).length > 0) {
            throw appRuntimeError('INVALID_REQUEST', 'Query parameters are not accepted.', 400);
        }
        requestValidator.requireArgumentsObject(req.body);
        tokenService.validateRunMetrics(req.body);
        next();
    } catch (error) {
        sendFailure(req, res, error);
    }
}

function validateAuthorizationTransport(req, res, next) {
    try {
        if (Object.keys(req.query || {}).length > 0) {
            throw appRuntimeError('INVALID_REQUEST', 'Query parameters are not accepted.', 400);
        }
        requestValidator.requireArgumentsObject(req.body);
        if (Object.keys(req.body).length !== 1
            || typeof req.body.source_sha256 !== 'string'
            || !/^[0-9a-f]{64}$/.test(req.body.source_sha256)) {
            throw appRuntimeError('INVALID_REQUEST', 'Source SHA-256 is invalid.', 400);
        }
        next();
    } catch (error) {
        sendFailure(req, res, error);
    }
}

// tenant-safety-allow R-route-permission: live token, consent, and delegated RBAC are re-resolved before the exact DB-pinned artifact receives one execution slot
router.post(
    '/v1/runs/authorize',
    runtimeJson,
    validateAuthorizationTransport,
    authenticateAppRuntime,
    async (req, res) => {
        try {
            await gatewayService.authorizeExecution(req, req.body.source_sha256);
            return res.json({ ok: true, request_id: req.requestId });
        } catch (error) {
            return sendFailure(req, res, error);
        }
    }
);

// tenant-safety-allow R-route-permission: signed run-token identity can only finalize its exact DB-bound run tuple
router.post(
    '/v1/runs/complete',
    runtimeJson,
    validateCompletionTransport,
    authenticateAppRuntimeClaims,
    async (req, res) => {
        try {
            await tokenService.recordRunCompletion(req.appRuntimeClaims, req.body);
            return res.json({ ok: true, request_id: req.requestId });
        } catch (error) {
            return sendFailure(req, res, error);
        }
    }
);

// tenant-safety-allow R-route-permission: run-token binding supplies the only company and installation selectors for declared data listing
router.post(
    '/v1/data/:collection/list',
    dataJson,
    validateTransport,
    authenticateAppRuntime,
    async (req, res) => {
        try {
            const data = await gatewayService.executeData(
                req,
                'list',
                req.params.collection,
                req.body
            );
            return res.json({ ok: true, data, request_id: req.requestId });
        } catch (error) {
            return sendFailure(req, res, error);
        }
    }
);

// tenant-safety-allow R-route-permission: run-token binding supplies the only company and installation selectors for schema-validated data upserts
router.post(
    '/v1/data/:collection/upsert',
    dataJson,
    validateTransport,
    authenticateAppRuntime,
    async (req, res) => {
        try {
            const data = await gatewayService.executeData(
                req,
                'upsert',
                req.params.collection,
                req.body
            );
            return res.json({ ok: true, data, request_id: req.requestId });
        } catch (error) {
            return sendFailure(req, res, error);
        }
    }
);

// tenant-safety-allow R-route-permission: run-token binding supplies the only company and installation selectors for server-keyed data deletion
router.post(
    '/v1/data/:collection/delete',
    dataJson,
    validateTransport,
    authenticateAppRuntime,
    async (req, res) => {
        try {
            const data = await gatewayService.executeData(
                req,
                'delete',
                req.params.collection,
                req.body
            );
            return res.json({ ok: true, data, request_id: req.requestId });
        } catch (error) {
            return sendFailure(req, res, error);
        }
    }
);

// tenant-safety-allow R-route-permission: short-lived run-token auth plus live delegated permission checks gate every allowlisted tool call
router.post('/v1/tools/:toolName', runtimeJson, validateTransport, authenticateAppRuntime, async (req, res) => {
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
