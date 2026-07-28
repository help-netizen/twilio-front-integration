'use strict';

const express = require('express');
const analytics = require('../services/leadChannelAnalyticsService');

const router = express.Router();

function companyIdFrom(req) {
    return req.companyFilter?.company_id;
}

function sendError(res, error, context) {
    if (error instanceof analytics.LeadChannelAnalyticsError) {
        return res.status(error.httpStatus).json({
            error: {
                code: error.code,
                message: error.message,
            },
        });
    }

    console.error(`[LeadChannelAnalytics] ${context} error:`, error);
    return res.status(500).json({
        error: {
            code: 'INTERNAL_ERROR',
            message: 'Failed to load lead channel analytics',
        },
    });
}

router.get('/summary', async (req, res) => {
    try {
        const result = await analytics.getSummary(
            companyIdFrom(req),
            { from: req.query.from, to: req.query.to }
        );
        return res.json(result);
    } catch (error) {
        return sendError(res, error, 'summary');
    }
});

router.get('/breakdown', async (req, res) => {
    try {
        const result = await analytics.getBreakdown(
            companyIdFrom(req),
            {
                dimension: req.query.dimension,
                from: req.query.from,
                to: req.query.to,
            }
        );
        return res.json(result);
    } catch (error) {
        return sendError(res, error, 'breakdown');
    }
});

router.get('/data-quality', async (req, res) => {
    try {
        const result = await analytics.getDataQuality(
            companyIdFrom(req),
            { from: req.query.from, to: req.query.to }
        );
        return res.json(result);
    } catch (error) {
        return sendError(res, error, 'data-quality');
    }
});

module.exports = router;
