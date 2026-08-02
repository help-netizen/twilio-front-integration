'use strict';

const crypto = require('crypto');
const express = require('express');
const { authenticate, requireCompanyAccess } = require('../middleware/keycloakAuth');
const appExecutionService = require('../services/appExecutionService');
const { AppRuntimeError } = require('../services/appRuntimeErrors');

const router = express.Router();

router.use((req, res, next) => {
    req.requestId = req.requestId || `app-view-${crypto.randomUUID()}`;
    req.traceId = req.traceId || req.requestId;
    res.set('X-Request-Id', req.requestId);
    res.set('Cache-Control', 'no-store');
    next();
});
router.use(authenticate, requireCompanyAccess);
router.use(express.json({ limit: 8 * 1024, strict: true }));

function requestContext(req) {
    const companyId = req.companyFilter?.company_id;
    const actorId = req.user?.crmUser?.id;
    if (!companyId || !actorId) return null;
    return { companyId, actorId };
}

function validInstallationId(value) {
    return typeof value === 'string' && /^[1-9]\d*$/.test(value);
}

function sendError(req, res, error) {
    const known = error instanceof AppRuntimeError
        || (typeof error?.code === 'string' && Number.isInteger(error?.httpStatus));
    const status = known ? error.httpStatus : 500;
    if (status >= 500) {
        console.error('[AppViews] Request failed:', error?.message || error);
    }
    return res.status(status).json({
        ok: false,
        code: known ? error.code : 'INTERNAL_ERROR',
        message: known ? error.message : 'Application request failed.',
        request_id: req.requestId,
    });
}

function routeInput(req) {
    const context = requestContext(req);
    if (!context) {
        throw new AppRuntimeError(
            'TENANT_CONTEXT_REQUIRED',
            'Company access is required.',
            403
        );
    }
    if (!validInstallationId(req.params.id)) {
        throw new AppRuntimeError('NOT_FOUND', 'App installation was not found.', 404);
    }
    return { ...context, installationId: req.params.id };
}

// tenant-safety-allow R-route-permission: the service re-resolves the viewer's live declared business permissions before claiming the tenant-bound installation
router.post('/installations/:id/runs', async (req, res) => {
    try {
        if (Object.keys(req.query || {}).length > 0
            || !req.body
            || typeof req.body !== 'object'
            || Array.isArray(req.body)
            || Object.keys(req.body).length > 0) {
            throw new AppRuntimeError(
                'INVALID_REQUEST',
                'Run request must use an empty JSON object.',
                400
            );
        }
        const run = await appExecutionService.run({
            ...routeInput(req),
            trigger: 'manual',
        });
        return res.status(run.status === 'running' ? 202 : 200).json({
            ok: true,
            run,
            request_id: req.requestId,
        });
    } catch (error) {
        return sendError(req, res, error);
    }
});

// tenant-safety-allow R-route-permission: the service re-resolves live viewer permissions and filters every metering read by company_id plus installation_id
router.get('/installations/:id/runs', async (req, res) => {
    try {
        if (Object.keys(req.query || {}).length > 0) {
            throw new AppRuntimeError(
                'INVALID_REQUEST',
                'Query parameters are not accepted.',
                400
            );
        }
        const runs = await appExecutionService.listRuns(routeInput(req));
        return res.json({ ok: true, runs, request_id: req.requestId });
    } catch (error) {
        return sendError(req, res, error);
    }
});

// tenant-safety-allow R-route-permission: the service re-resolves live viewer permissions and requires the company/installation/run tuple
router.get('/installations/:id/runs/:runId', async (req, res) => {
    try {
        if (Object.keys(req.query || {}).length > 0) {
            throw new AppRuntimeError(
                'INVALID_REQUEST',
                'Query parameters are not accepted.',
                400
            );
        }
        const run = await appExecutionService.getRunResult({
            ...routeInput(req),
            runId: req.params.runId,
        });
        return res.json({ ok: true, run, request_id: req.requestId });
    } catch (error) {
        return sendError(req, res, error);
    }
});

// tenant-safety-allow R-route-permission: the service re-resolves live viewer permissions and follows only the tenant-paired latest result pointer
router.get('/installations/:id/latest', async (req, res) => {
    try {
        if (Object.keys(req.query || {}).length > 0) {
            throw new AppRuntimeError(
                'INVALID_REQUEST',
                'Query parameters are not accepted.',
                400
            );
        }
        const run = await appExecutionService.getLatestResult(routeInput(req));
        return res.json({ ok: true, run, request_id: req.requestId });
    } catch (error) {
        return sendError(req, res, error);
    }
});

router.use((error, req, res, _next) => {
    if (error?.type === 'entity.too.large' || error instanceof SyntaxError) {
        return sendError(
            req,
            res,
            new AppRuntimeError('INVALID_REQUEST', 'Request body is invalid.', 400)
        );
    }
    return sendError(req, res, error);
});

module.exports = router;
module.exports.requestContext = requestContext;
