const express = require('express');
const router = express.Router();
const marketplaceService = require('../services/marketplaceService');
const rateMeService = require('../services/rateMeService');

function companyId(req) {
    return req.companyFilter?.company_id;
}

function actorId(req) {
    return req.user?.crmUser?.id || null;
}

function handleError(err, req, res) {
    if (err instanceof marketplaceService.MarketplaceServiceError
        || err instanceof rateMeService.RateMeServiceError) {
        return res.status(err.httpStatus || 400).json({
            success: false,
            code: err.code,
            message: err.message,
            request_id: req.requestId,
        });
    }
    console.error('[Marketplace] Error:', err.message);
    return res.status(500).json({
        success: false,
        code: 'INTERNAL_ERROR',
        message: 'Internal server error.',
        request_id: req.requestId,
    });
}

router.get('/apps', async (req, res) => {
    try {
        const apps = await marketplaceService.listApps(companyId(req));
        res.json({ success: true, apps, request_id: req.requestId });
    } catch (err) {
        handleError(err, req, res);
    }
});

router.get('/installations', async (req, res) => {
    try {
        const includeInactive = String(req.query.include_inactive || '').toLowerCase() === 'true';
        const installations = await marketplaceService.listInstallations(companyId(req), includeInactive);
        res.json({ success: true, installations, request_id: req.requestId });
    } catch (err) {
        handleError(err, req, res);
    }
});

async function setChatgptMcpWrites(req, res, enabled) {
    try {
        const result = await marketplaceService.setChatgptMcpWrites(
            companyId(req),
            actorId(req),
            enabled,
            { requestId: req.requestId }
        );
        res.json({ success: true, ...result, request_id: req.requestId });
    } catch (err) {
        handleError(err, req, res);
    }
}

async function setChatgptMcpSends(req, res, enabled) {
    try {
        const result = await marketplaceService.setChatgptMcpSends(
            companyId(req),
            actorId(req),
            enabled,
            { requestId: req.requestId }
        );
        res.json({ success: true, ...result, request_id: req.requestId });
    } catch (err) {
        handleError(err, req, res);
    }
}

router.post('/apps/chatgpt-crm-mcp/writes/enable', async (req, res) => {
    await setChatgptMcpWrites(req, res, true);
});

router.post('/apps/chatgpt-crm-mcp/writes/disable', async (req, res) => {
    await setChatgptMcpWrites(req, res, false);
});

router.post('/apps/chatgpt-crm-mcp/sends/enable', async (req, res) => {
    await setChatgptMcpSends(req, res, true);
});

router.post('/apps/chatgpt-crm-mcp/sends/disable', async (req, res) => {
    await setChatgptMcpSends(req, res, false);
});

router.get('/apps/:appKey/settings', async (req, res) => {
    try {
        const result = await marketplaceService.getAppSettings(
            companyId(req),
            req.params.appKey
        );
        res.json({ success: true, ...result, request_id: req.requestId });
    } catch (err) {
        handleError(err, req, res);
    }
});

router.put('/apps/:appKey/settings', async (req, res) => {
    try {
        const result = await marketplaceService.updateAppSettings(
            companyId(req),
            actorId(req),
            req.params.appKey,
            req.body,
            { requestId: req.requestId }
        );
        res.json({ success: true, ...result, request_id: req.requestId });
    } catch (err) {
        handleError(err, req, res);
    }
});

router.put('/apps/rate-me/domain', async (req, res) => {
    try {
        const domain = await rateMeService.setCustomDomain(
            companyId(req),
            actorId(req),
            req.body?.domain
        );
        res.json({ success: true, domain, request_id: req.requestId });
    } catch (err) {
        handleError(err, req, res);
    }
});

router.post('/apps/rate-me/domain/verify', async (req, res) => {
    try {
        const domain = await rateMeService.verifyDomain(
            companyId(req),
            actorId(req)
        );
        res.json({ success: true, domain, request_id: req.requestId });
    } catch (err) {
        handleError(err, req, res);
    }
});

router.delete('/apps/rate-me/domain', async (req, res) => {
    try {
        await rateMeService.removeDomain(companyId(req), actorId(req));
        res.json({ success: true, request_id: req.requestId });
    } catch (err) {
        handleError(err, req, res);
    }
});

router.post('/apps/rate-me/tokens', async (req, res) => {
    try {
        const token = await rateMeService.mintToken(companyId(req), {
            jobId: req.body?.job_id,
            techId: req.body?.tech_id,
            techName: req.body?.tech_name,
        });
        res.status(201).json({
            success: true,
            token,
            request_id: req.requestId,
        });
    } catch (err) {
        handleError(err, req, res);
    }
});

router.post('/apps/:appKey/install', async (req, res) => {
    try {
        const installation = await marketplaceService.installApp(
            companyId(req),
            actorId(req),
            req.params.appKey,
            { requestId: req.requestId, req }
        );
        res.status(201).json({ success: true, installation, request_id: req.requestId });
    } catch (err) {
        handleError(err, req, res);
    }
});

router.post('/installations/:id/disconnect', async (req, res) => {
    try {
        const installation = await marketplaceService.disconnectInstallation(
            companyId(req),
            actorId(req),
            req.params.id,
            { requestId: req.requestId }
        );
        res.json({ success: true, installation, request_id: req.requestId });
    } catch (err) {
        handleError(err, req, res);
    }
});

router.post('/installations/:id/retry-provisioning', async (req, res) => {
    try {
        const installation = await marketplaceService.retryProvisioning(
            companyId(req),
            actorId(req),
            req.params.id,
            { requestId: req.requestId, req }
        );
        res.json({ success: true, installation, request_id: req.requestId });
    } catch (err) {
        handleError(err, req, res);
    }
});

module.exports = router;
