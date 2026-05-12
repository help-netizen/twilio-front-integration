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
const { requireIntegrationScope } = require('../middleware/integrationScopes');
const rateLimiter = require('../middleware/rateLimiter');

// Middleware chain (mirrors integrations-leads)
router.use(rejectLegacyAuth);
router.use(validateHeaders);
router.use(authenticateIntegration);
router.use(rateLimiter);

const requireAnalyticsRead = requireIntegrationScope('analytics:read');

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

router.get('/analytics/summary', requireAnalyticsRead, async (req, res) => {
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

router.get('/analytics/calls', requireAnalyticsRead, async (req, res) => {
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

router.get('/analytics/leads', requireAnalyticsRead, async (req, res) => {
    try {
        let hasGclid;
        if (req.query.has_gclid !== undefined) {
            const v = String(req.query.has_gclid).toLowerCase();
            if (v === 'true' || v === '1')  hasGclid = true;
            if (v === 'false' || v === '0') hasGclid = false;
        }
        const data = await analyticsService.listLeads({
            from: req.query.from,
            to: req.query.to,
            trackingNumber: req.query.tracking_number,
            companyId: req.integrationCompanyId,
            limit: req.query.limit,
            cursor: req.query.cursor,
            hasGclid,
        });
        res.json({ success: true, request_id: req.requestId, ...data });
    } catch (err) { handleError(err, req, res); }
});

router.get('/analytics/jobs', requireAnalyticsRead, async (req, res) => {
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
