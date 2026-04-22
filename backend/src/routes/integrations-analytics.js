/**
 * Integrations Analytics Router (F014)
 *
 * External read-only endpoints for Ads performance reporting.
 *
 *   GET /api/v1/integrations/analytics/summary
 *   GET /api/v1/integrations/analytics/calls
 *   GET /api/v1/integrations/analytics/leads
 *   GET /api/v1/integrations/analytics/jobs
 *
 * Auth: X-BLANC-API-KEY + X-BLANC-API-SECRET headers, scope `analytics:read`.
 */

const express = require('express');
const router = express.Router();
const analyticsService = require('../services/analyticsService');
const {
    rejectLegacyAuth,
    validateHeaders,
    authenticateIntegration,
} = require('../middleware/integrationsAuth');
const rateLimiter = require('../middleware/rateLimiter');

// Middleware chain (mirrors integrations-leads)
router.use(rejectLegacyAuth);
router.use(validateHeaders);
router.use(authenticateIntegration);
router.use(rateLimiter);

function requireScope(req, res, next) {
    const scopes = req.integrationScopes || [];
    if (!scopes.includes('analytics:read')) {
        return res.status(403).json({
            success: false,
            code: 'SCOPE_INSUFFICIENT',
            message: 'This integration does not have analytics:read scope.',
            request_id: req.requestId,
        });
    }
    next();
}

function handleError(err, req, res) {
    if (err instanceof analyticsService.AnalyticsServiceError) {
        return res.status(err.httpStatus || 400).json({
            success: false,
            code: err.code,
            message: err.message,
            request_id: req.requestId,
        });
    }
    console.error('[IntegrationsAnalytics] Error:', err.message);
    return res.status(500).json({
        success: false,
        code: 'INTERNAL_ERROR',
        message: 'Internal server error.',
        request_id: req.requestId,
    });
}

router.get('/analytics/summary', requireScope, async (req, res) => {
    try {
        const data = await analyticsService.getSummary({
            from: req.query.from,
            to: req.query.to,
            trackingNumber: req.query.tracking_number,
            companyId: req.integrationCompanyId,
        });
        res.json({ success: true, request_id: req.requestId, ...data });
    } catch (err) { handleError(err, req, res); }
});

router.get('/analytics/calls', requireScope, async (req, res) => {
    try {
        const data = await analyticsService.listCalls({
            from: req.query.from,
            to: req.query.to,
            trackingNumber: req.query.tracking_number,
            companyId: req.integrationCompanyId,
            limit: req.query.limit,
            cursor: req.query.cursor,
        });
        res.json({ success: true, request_id: req.requestId, ...data });
    } catch (err) { handleError(err, req, res); }
});

router.get('/analytics/leads', requireScope, async (req, res) => {
    try {
        const data = await analyticsService.listLeads({
            from: req.query.from,
            to: req.query.to,
            trackingNumber: req.query.tracking_number,
            companyId: req.integrationCompanyId,
            limit: req.query.limit,
            cursor: req.query.cursor,
        });
        res.json({ success: true, request_id: req.requestId, ...data });
    } catch (err) { handleError(err, req, res); }
});

router.get('/analytics/jobs', requireScope, async (req, res) => {
    try {
        const data = await analyticsService.listJobs({
            from: req.query.from,
            to: req.query.to,
            trackingNumber: req.query.tracking_number,
            companyId: req.integrationCompanyId,
            limit: req.query.limit,
            cursor: req.query.cursor,
        });
        res.json({ success: true, request_id: req.requestId, ...data });
    } catch (err) { handleError(err, req, res); }
});

module.exports = router;
