const express = require('express');
const router = express.Router();
const marketplaceService = require('../services/marketplaceService');

function companyId(req) {
    return req.companyFilter?.company_id || req.user?.company_id;
}

function actorId(req) {
    return req.user?.crmUser?.id || null;
}

function handleError(err, req, res) {
    if (err instanceof marketplaceService.MarketplaceServiceError) {
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
