'use strict';

const express = require('express');
const appBuilderService = require('../services/appBuilderService');
const appVersionTransitionService = require('../services/appVersionTransitionService');
const { runnerConfigurationIssue } = require('../services/appBuilderDryRunService');
const { requirePermission } = require('../middleware/authorization');

const router = express.Router();

router.use(requirePermission('tenant.integrations.manage'));
router.use(requireTenantAdmin);

// APP-SVC-001: explicit product flag plus a complete remote-runner configuration.
// There is no local execution fallback; missing service settings fail closed.
router.use((req, res, next) => {
    const enabled = String(process.env.APP_STUDIO_ENABLED || '').trim() === 'true';
    if (!enabled) {
        return res.status(404).json({
            code: 'APP_STUDIO_DISABLED',
            message: 'App Studio is not available.',
            request_id: req.requestId,
        });
    }
    const configurationIssue = runnerConfigurationIssue();
    if (configurationIssue) {
        return res.status(503).json({
            code: 'APP_RUNNER_NOT_CONFIGURED',
            message: configurationIssue,
            request_id: req.requestId,
        });
    }
    return next();
});

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function requireTenantAdmin(req, res, next) {
    if (req.user?._devMode) return next();
    if (req.authz?.membership?.role_key === 'tenant_admin') return next();
    return res.status(403).json({
        code: 'TENANT_ADMIN_ONLY',
        message: 'Tenant admin role required.',
        request_id: req.requestId,
    });
}

function requestContext(req) {
    const companyId = req.companyFilter?.company_id;
    const actorId = req.user?.crmUser?.id;
    if (!companyId || !actorId) return null;
    return { companyId, actorId };
}

function validObject(body, allowedKeys) {
    return body && typeof body === 'object' && !Array.isArray(body)
        && Object.keys(body).every(key => allowedKeys.includes(key));
}

function handleError(error, req, res) {
    const status = Number(error?.httpStatus) || 500;
    if (status >= 500) {
        console.error('[AppStudio] Request failed:', error?.message || error);
    }
    const payload = {
        code: error?.code || 'INTERNAL_ERROR',
        message: status >= 500 ? 'App Studio request failed.' : error.message,
        request_id: req.requestId,
    };
    if (error?.botMessage) payload.message_record = error.botMessage;
    return res.status(status).json(payload);
}

router.post('/chats', async (req, res) => {
    if (!validObject(req.body, ['app_id', 'title'])) {
        return res.status(400).json({ code: 'INVALID_REQUEST', message: 'Invalid chat request.' });
    }
    const context = requestContext(req);
    if (!context) {
        return res.status(403).json({ code: 'TENANT_CONTEXT_REQUIRED', message: 'Company access required.' });
    }
    try {
        const chat = await appBuilderService.createChat(context.companyId, context.actorId, req.body);
        return res.status(201).json({ chat, request_id: req.requestId });
    } catch (error) {
        return handleError(error, req, res);
    }
});

router.get('/chats', async (req, res) => {
    const context = requestContext(req);
    if (!context) {
        return res.status(403).json({ code: 'TENANT_CONTEXT_REQUIRED', message: 'Company access required.' });
    }
    try {
        const chats = await appBuilderService.listChats(context.companyId);
        return res.json({ chats, request_id: req.requestId });
    } catch (error) {
        return handleError(error, req, res);
    }
});

router.get('/chats/:id/messages', async (req, res) => {
    const context = requestContext(req);
    if (!context) {
        return res.status(403).json({ code: 'TENANT_CONTEXT_REQUIRED', message: 'Company access required.' });
    }
    if (!UUID_RE.test(req.params.id)) {
        return res.status(404).json({ code: 'NOT_FOUND', message: 'App Studio resource not found.' });
    }
    try {
        const result = await appBuilderService.getMessages(context.companyId, req.params.id);
        return res.json({ ...result, request_id: req.requestId });
    } catch (error) {
        return handleError(error, req, res);
    }
});

router.post('/chats/:id/messages', async (req, res) => {
    const context = requestContext(req);
    if (!context) {
        return res.status(403).json({ code: 'TENANT_CONTEXT_REQUIRED', message: 'Company access required.' });
    }
    if (!UUID_RE.test(req.params.id)) {
        return res.status(404).json({ code: 'NOT_FOUND', message: 'App Studio resource not found.' });
    }
    if (!validObject(req.body, ['text']) || typeof req.body.text !== 'string') {
        return res.status(400).json({ code: 'INVALID_REQUEST', message: 'Message text is required.' });
    }
    try {
        const result = await appBuilderService.generateMessage({
            companyId: context.companyId,
            actorId: context.actorId,
            chatId: req.params.id,
            text: req.body.text,
            requestId: req.requestId,
        });
        return res.json({ ...result, request_id: req.requestId });
    } catch (error) {
        return handleError(error, req, res);
    }
});

router.get('/apps/:appId/versions', async (req, res) => {
    const context = requestContext(req);
    if (!context) {
        return res.status(403).json({ code: 'TENANT_CONTEXT_REQUIRED', message: 'Company access required.' });
    }
    try {
        const result = await appBuilderService.listVersions(context.companyId, req.params.appId);
        return res.json({ ...result, request_id: req.requestId });
    } catch (error) {
        return handleError(error, req, res);
    }
});

async function tenantVersionTransition(req, res, action) {
    const context = requestContext(req);
    if (!context) {
        return res.status(403).json({ code: 'TENANT_CONTEXT_REQUIRED', message: 'Company access required.' });
    }
    if (!/^[1-9]\d*$/.test(String(req.params.appId || ''))
        || !UUID_RE.test(String(req.params.versionId || ''))) {
        return res.status(404).json({ code: 'NOT_FOUND', message: 'App Studio resource not found.' });
    }
    try {
        const version = await appVersionTransitionService[action]({
            companyId: context.companyId,
            actorId: context.actorId,
            appId: req.params.appId,
            versionId: req.params.versionId,
            traceId: req.requestId,
        });
        return res.status(action === 'forkRejectedVersion' ? 201 : 200).json({
            version,
            request_id: req.requestId,
        });
    } catch (error) {
        return handleError(error, req, res);
    }
}

router.post('/apps/:appId/versions/:versionId/submit', (req, res) => (
    tenantVersionTransition(req, res, 'submitVersion')
));

router.post('/apps/:appId/versions/:versionId/publish', (req, res) => (
    tenantVersionTransition(req, res, 'publishVersion')
));

router.post('/apps/:appId/versions/:versionId/fork', (req, res) => (
    tenantVersionTransition(req, res, 'forkRejectedVersion')
));

module.exports = router;
module.exports.requireTenantAdmin = requireTenantAdmin;
